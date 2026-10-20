import { and, eq, inArray, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { calendars, eventPeople, events, people } from '../db/schema'
import type { CalDavAuth } from './caldavAuth'
import { parseDavEvent, rowToVCalendar, type DavMappedEvent } from './caldavMap'
import { multiget, etagReport, putEvent, deleteEvent, ConflictError, resolveUrl } from './caldavClient'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { notFound } from '../services/errors'

type CalendarRow = typeof calendars.$inferSelect
type EventRow = typeof events.$inferSelect

export interface DavRemoteCalendar {
  url: string
  name: string
  color: string
  readOnly: boolean
  selected: boolean
  /** local calendar-to-person mapping for this remote calendar (null = shared) */
  personId: string | null
}

export function createCalDavSync(deps: { db: AppDb; auth: CalDavAuth; deviceTz: () => string }) {
  const { db, auth } = deps

  async function listRemoteCalendars(accountId: string): Promise<DavRemoteCalendar[]> {
    const discovered = await auth.discoverCalendars(accountId)
    const existing = db
      .select()
      .from(calendars)
      .where(and(eq(calendars.caldavAccountId, accountId), isNull(calendars.deletedAt)))
      .all()
    const selectedUrls = new Map(existing.map((c) => [c.caldavCalendarUrl, c.personId]))
    return discovered.map((d) => ({
      url: d.url,
      name: d.name,
      color: d.color,
      readOnly: d.readOnly,
      selected: selectedUrls.has(d.url),
      personId: selectedUrls.get(d.url) ?? null
    }))
  }

  function setCalendarSelected(input: {
    accountId: string
    calendarUrl: string
    name: string
    color: string
    readOnly: boolean
    selected: boolean
    personId: string | null
  }): void {
    const existing = db
      .select()
      .from(calendars)
      .where(
        and(
          eq(calendars.caldavAccountId, input.accountId),
          eq(calendars.caldavCalendarUrl, input.calendarUrl),
          isNull(calendars.deletedAt)
        )
      )
      .all()
    if (input.selected) {
      if (existing.length > 0) {
        // update mapping/color on re-select
        db.update(calendars)
          .set({ personId: input.personId, color: input.color, name: input.name })
          .where(eq(calendars.id, existing[0].id))
          .run()
        return
      }
      db.insert(calendars)
        .values({
          id: uuidv7(),
          provider: 'caldav',
          caldavAccountId: input.accountId,
          caldavCalendarUrl: input.calendarUrl,
          name: input.name,
          color: input.color,
          readOnly: input.readOnly,
          visible: true,
          personId: input.personId
        })
        .run()
    } else if (existing.length > 0) {
      const now = isoUtc(DateTime.utc())
      db.transaction((tx) => {
        tx.update(events)
          .set({ deletedAt: now })
          .where(and(eq(events.calendarId, existing[0].id), isNull(events.deletedAt)))
          .run()
        tx.update(calendars).set({ deletedAt: now }).where(eq(calendars.id, existing[0].id)).run()
      })
    }
  }

  /**
   * Pull changes for one CalDAV calendar. etag-based: cheap REPORT of hrefs+etags,
   * then multiget only for resources whose etag changed (or all on first sync).
   * Returns true if local data changed.
   */
  async function pullCalendar(cal: CalendarRow, fetchFn?: typeof fetch): Promise<boolean> {
    if (!cal.caldavAccountId || !cal.caldavCalendarUrl) throw notFound('CalDAV calendar binding')
    const creds = auth.credentialsFor(cal.caldavAccountId)
    const remote = etagReport(cal.caldavCalendarUrl, creds, fetchFn)
    const entries = await remote
    const remoteEtags = new Map(entries.map((e) => [e.href, e.etag]))

    // cheap change detection: if every etag matches what we stored, we're done
    const localRows = db
      .select()
      .from(events)
      .where(and(eq(events.calendarId, cal.id), isNull(events.deletedAt)))
      .all()
    // rows not yet pushed have no providerEventId; the non-null assertion is
    // only for the map type — filter them so "undefined" never becomes a key
    const localEtags = new Map(
      localRows
        .filter((r) => r.providerEventId !== null)
        .map((r) => [r.providerEventId!, r.etag] as const)
    )
    const staleHrefs: string[] = []
    for (const [href, etag] of remoteEtags) {
      if (localEtags.get(href) !== etag) staleHrefs.push(href)
    }
    const disappeared = [...localEtags.keys()].filter((href) => !remoteEtags.has(href))

    if (staleHrefs.length === 0 && disappeared.length === 0) {
      db.update(calendars)
        .set({ lastSyncedAt: isoUtc(DateTime.utc()), syncError: null })
        .where(eq(calendars.id, cal.id))
        .run()
      return false
    }

    // fetch bodies only for changed resources
    const knownPeople = new Set(db.select({ id: people.id }).from(people).all().map((p) => p.id))
    const deviceTz = deps.deviceTz()
    let changed = false
    const mappedAll: (DavMappedEvent & { raw: string })[] = []

    if (staleHrefs.length > 0) {
      const fetched = await multiget(cal.caldavCalendarUrl, creds, fetchFn)
      for (const entry of fetched) {
        if (!staleHrefs.includes(entry.href)) continue
        const mapped = parseDavEvent(entry.href, entry.etag, entry.data, deviceTz)
        if (mapped) mappedAll.push({ ...mapped, raw: entry.data })
      }
    }

    const now = isoUtc(DateTime.utc())
    db.transaction((tx) => {
      // masters first, then exception instances (need their master's local id)
      const masters = mappedAll.filter((m) => !m.recurrenceId)
      const exceptions = mappedAll.filter((m) => m.recurrenceId)
      const masterIdByUid = new Map<string, string>()

      const upsertOne = (m: DavMappedEvent, recurringLocalId: string | null): void => {
        const [existing] = tx
          .select()
          .from(events)
          .where(and(eq(events.calendarId, cal.id), eq(events.providerEventId, m.href)))
          .all()
        // Local unsynced edits win until the push path resolves them
        if (existing?.dirty) return

        if (m.status === 'cancelled' && !m.recurrenceId) {
          if (existing && !existing.deletedAt) {
            tx.update(events).set({ deletedAt: now }).where(eq(events.id, existing.id)).run()
            tx.update(events)
              .set({ deletedAt: now })
              .where(and(eq(events.recurringEventId, existing.id), isNull(events.deletedAt)))
              .run()
            changed = true
          }
          return
        }

        const fields = {
          title: m.title,
          description: m.description,
          location: m.location,
          startAt: m.startAt,
          endAt: m.endAt,
          tz: m.tz,
          allDay: m.allDay,
          rrule: m.rrule,
          exdates: m.exdates.length > 0 ? JSON.stringify(m.exdates) : null,
          rdates: m.rdates.length > 0 ? JSON.stringify(m.rdates) : null,
          etag: m.etag,
          icalUid: m.uid,
          status: m.status,
          recurringEventId: recurringLocalId,
          originalStartAt: m.recurrenceId,
          remoteUpdatedAt: m.remoteUpdatedAt,
          deletedAt: null,
          updatedAt: now
        }
        let localId: string
        if (existing) {
          tx.update(events).set(fields).where(eq(events.id, existing.id)).run()
          localId = existing.id
        } else {
          localId = uuidv7()
          tx.insert(events)
            .values({
              id: localId,
              calendarId: cal.id,
              providerEventId: m.href,
              dirty: false,
              createdAt: now,
              ...fields
            })
            .run()
        }
        if (!m.recurrenceId) masterIdByUid.set(m.uid, localId)

        // person assignment: inherited from the calendar mapping, kept local
        if (cal.personId && knownPeople.has(cal.personId)) {
          const current = tx
            .select()
            .from(eventPeople)
            .where(and(eq(eventPeople.eventId, localId), eq(eventPeople.personId, cal.personId!)))
            .all()
          if (current.length === 0) {
            tx.delete(eventPeople).where(eq(eventPeople.eventId, localId)).run()
            tx.insert(eventPeople).values({ eventId: localId, personId: cal.personId! }).run()
          }
        }
        changed = true
      }

      for (const m of masters) upsertOne(m, null)
      for (const m of exceptions) {
        const [master] = tx
          .select()
          .from(events)
          .where(and(eq(events.calendarId, cal.id), eq(events.icalUid, m.uid), isNull(events.recurringEventId)))
          .all()
        if (!master) continue // master outside our window — orphan instance, skip
        upsertOne(m, master.id)
      }

      // resources that vanished remotely: tombstone (unless dirty)
      if (disappeared.length > 0) {
        tx.update(events)
          .set({ deletedAt: now })
          .where(and(eq(events.calendarId, cal.id), inArray(events.providerEventId, disappeared), eq(events.dirty, false)))
          .run()
        changed = true
      }
    })

    db.update(calendars)
      .set({ lastSyncedAt: isoUtc(DateTime.utc()), syncError: null })
      .where(eq(calendars.id, cal.id))
      .run()
    return changed
  }

  /** Push one dirty row. Used by the shared outbox worker. */
  async function pushRow(cal: CalendarRow, row: EventRow, fetchFn?: typeof fetch): Promise<void> {
    if (!cal.caldavAccountId || !cal.caldavCalendarUrl) throw notFound('CalDAV calendar binding')
    const creds = auth.credentialsFor(cal.caldavAccountId)

    // 1. Deletions
    if (row.deletedAt || row.status === 'cancelled') {
      if (row.providerEventId) {
        const eventUrl = resolveUrl(cal.caldavCalendarUrl, row.providerEventId)
        await deleteEvent(eventUrl, creds, fetchFn)
      }
      return
    }

    const personIds = db
      .select()
      .from(eventPeople)
      .where(eq(eventPeople.eventId, row.id))
      .all()
      .map((r) => r.personId)

    const ics = rowToVCalendar({
      uid: row.icalUid ?? `osl-${row.id}@openskylight`,
      title: row.title,
      description: row.description,
      location: row.location,
      startAt: row.startAt,
      endAt: row.endAt,
      tz: row.tz,
      allDay: row.allDay,
      rrule: row.rrule,
      exdates: safeParse(row.exdates),
      rdates: safeParse(row.rdates),
      personIds,
      recurrenceIdIso: row.originalStartAt
    })

    const eventUrl = row.providerEventId
      ? resolveUrl(cal.caldavCalendarUrl, row.providerEventId)
      : undefined
    const result = await putEvent(
      cal.caldavCalendarUrl,
      creds,
      ics,
      { eventUrl, ifMatch: eventUrl ? row.etag : null },
      fetchFn
    )
    // always persist the resource URL (the href the server assigned on create)
    // so the next edit patches THIS event instead of creating a duplicate
    db.update(events)
      .set({
        providerEventId: result.url,
        etag: result.etag,
        ...(row.icalUid ? {} : { icalUid: `osl-${row.id}@openskylight` })
      })
      .where(eq(events.id, row.id))
      .run()
  }

  return { listRemoteCalendars, setCalendarSelected, pullCalendar, pushRow }
}

export type CalDavSync = ReturnType<typeof createCalDavSync>
export { ConflictError }

function safeParse(s: string | null): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
