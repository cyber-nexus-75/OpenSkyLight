import { and, eq, inArray, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { calendars, events } from '../db/schema'
import { parseIcsFeed, type IcsMappedEvent } from './icsMap'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'

type CalendarRow = typeof calendars.$inferSelect

export function createIcsSync(deps: { db: AppDb; deviceTz: () => string }) {
  const { db } = deps

  function addFeed(input: { url: string; name: string; color: string }): CalendarRow {
    const id = uuidv7()
    db.insert(calendars)
      .values({
        id,
        provider: 'ics',
        icsUrl: input.url,
        name: input.name,
        color: input.color,
        readOnly: true,
        visible: true,
        personId: null
      })
      .run()
    const [row] = db.select().from(calendars).where(eq(calendars.id, id)).all()
    return row
  }

  /** Refresh one feed. Returns true if local data changed. */
  async function pullFeed(cal: CalendarRow): Promise<boolean> {
    if (!cal.icsUrl) return false
    const headers: Record<string, string> = {}
    if (cal.icsEtag) headers['If-None-Match'] = cal.icsEtag
    if (cal.icsLastModified) headers['If-Modified-Since'] = cal.icsLastModified

    const res = await fetch(cal.icsUrl, { headers })
    if (res.status === 304) {
      db.update(calendars).set({ lastSyncedAt: isoUtc(DateTime.utc()), syncError: null }).where(eq(calendars.id, cal.id)).run()
      return false
    }
    if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`)
    const text = await res.text()
    const mapped = parseIcsFeed(text, deps.deviceTz())
    const changed = applyFeed(cal, mapped)

    db.update(calendars)
      .set({
        icsEtag: res.headers.get('etag'),
        icsLastModified: res.headers.get('last-modified'),
        lastSyncedAt: isoUtc(DateTime.utc()),
        syncError: null
      })
      .where(eq(calendars.id, cal.id))
      .run()
    return changed
  }

  function applyFeed(cal: CalendarRow, mapped: IcsMappedEvent[]): boolean {
    let changed = false
    const now = isoUtc(DateTime.utc())
    db.transaction((tx) => {
      const existingRows = tx
        .select()
        .from(events)
        .where(and(eq(events.calendarId, cal.id), isNull(events.deletedAt)))
        .all()
      const byKey = new Map(existingRows.map((r) => [`${r.icalUid}|${r.originalStartAt ?? ''}`, r]))
      const masterIdByUid = new Map(
        existingRows.filter((r) => !r.recurringEventId).map((r) => [r.icalUid!, r.id])
      )
      const seen = new Set<string>()

      const masters = mapped.filter((m) => !m.recurrenceId && m.status !== 'cancelled')
      const exceptions = mapped.filter((m) => m.recurrenceId)

      const upsert = (m: IcsMappedEvent, recurringLocalId: string | null): void => {
        const key = `${m.uid}|${m.recurrenceId ?? ''}`
        seen.add(key)
        const existing = byKey.get(key)
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
          status: m.status,
          recurringEventId: recurringLocalId,
          originalStartAt: m.recurrenceId,
          updatedAt: now
        }
        if (existing) {
          tx.update(events).set(fields).where(eq(events.id, existing.id)).run()
        } else {
          const id = uuidv7()
          tx.insert(events).values({ id, calendarId: cal.id, icalUid: m.uid, createdAt: now, ...fields }).run()
          if (!m.recurrenceId) masterIdByUid.set(m.uid, id)
        }
        changed = true
      }

      for (const m of masters) upsert(m, null)
      for (const m of exceptions) {
        const masterId = masterIdByUid.get(m.uid)
        if (masterId) upsert(m, masterId)
      }

      // tombstone rows that disappeared from the feed
      const stale = existingRows.filter((r) => !seen.has(`${r.icalUid}|${r.originalStartAt ?? ''}`))
      if (stale.length > 0) {
        tx.update(events).set({ deletedAt: now }).where(inArray(events.id, stale.map((r) => r.id))).run()
        changed = true
      }
    })
    return changed
  }

  return { addFeed, pullFeed }
}

export type IcsSync = ReturnType<typeof createIcsSync>
