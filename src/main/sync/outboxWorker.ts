import { and, asc, eq, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { calendars, eventPeople, events } from '../db/schema'
import type { GoogleSync } from './googleSync'
import type { CalDavSync } from './caldavSync'
import { httpStatus } from './googleSync'
import { instanceProviderId, rowToGResource } from './googleMap'
import { ConflictError } from './caldavClient'

type EventRow = typeof events.$inferSelect

/**
 * Push engine. The `dirty` flag on event rows IS the outbox: every local
 * mutation sets it; this worker drains dirty rows for Google-backed calendars.
 * The operation is derived from row state (tombstone / missing provider id / etc.).
 */
export function createOutboxWorker(deps: {
  db: AppDb
  sync: GoogleSync
  caldav?: CalDavSync
  onConflict: (title: string) => void
}) {
  const { db, sync, caldav } = deps
  // transient retry state, in memory only
  const retries = new Map<string, { attempts: number; nextAtMs: number }>()

  function personIdsFor(eventId: string): string[] {
    return db
      .select()
      .from(eventPeople)
      .where(eq(eventPeople.eventId, eventId))
      .all()
      .map((r) => r.personId)
  }

  /** Clear dirty only if the row wasn't touched again while we were pushing. */
  function finishRow(row: EventRow, patch: Partial<typeof events.$inferInsert>): void {
    db.update(events)
      .set({ ...patch, dirty: false })
      .where(and(eq(events.id, row.id), eq(events.updatedAt, row.updatedAt)))
      .run()
    retries.delete(row.id)
  }

  async function pushRow(cal: typeof calendars.$inferSelect, row: EventRow): Promise<void> {
    const client = sync.api(cal.googleAccountId!)
    const calendarId = cal.googleCalendarId!

    // 1. Deletions
    if (row.deletedAt || row.status === 'cancelled') {
      if (row.providerEventId) {
        try {
          await client.events.delete({ calendarId, eventId: row.providerEventId })
        } catch (err) {
          const status = httpStatus(err)
          if (status !== 404 && status !== 410) throw err
        }
      }
      finishRow(row, {})
      return
    }

    const resource = rowToGResource({ ...row, personIds: personIdsFor(row.id) })

    // 2. Exception instances → patch the Google instance id
    if (row.recurringEventId) {
      const [master] = db.select().from(events).where(eq(events.id, row.recurringEventId)).all()
      if (!master?.providerEventId) return // master not pushed yet; retry next drain
      const instanceId =
        row.providerEventId ?? instanceProviderId(master.providerEventId, row.originalStartAt!, master.allDay)
      delete (resource as Record<string, unknown>).recurrence
      const res = await client.events.patch(
        { calendarId, eventId: instanceId, requestBody: resource },
        row.etag ? { headers: { 'If-Match': row.etag } } : undefined
      )
      finishRow(row, { providerEventId: res.data.id ?? instanceId, etag: res.data.etag ?? null })
      return
    }

    // 3. Creates
    if (!row.providerEventId) {
      const res = await client.events.insert({ calendarId, requestBody: resource })
      finishRow(row, {
        providerEventId: res.data.id ?? null,
        etag: res.data.etag ?? null,
        icalUid: res.data.iCalUID ?? null
      })
      return
    }

    // 4. Updates
    const res = await client.events.patch(
      { calendarId, eventId: row.providerEventId, requestBody: resource },
      row.etag ? { headers: { 'If-Match': row.etag } } : undefined
    )
    finishRow(row, { etag: res.data.etag ?? null })
  }

  /** 412: someone changed the event remotely while we held a local edit. Last writer wins. */
  async function resolveConflict(cal: typeof calendars.$inferSelect, row: EventRow): Promise<void> {
    const client = sync.api(cal.googleAccountId!)
    const remote = await client.events.get({ calendarId: cal.googleCalendarId!, eventId: row.providerEventId! })
    const remoteUpdated = remote.data.updated ? DateTime.fromISO(remote.data.updated) : null
    const localUpdated = DateTime.fromISO(row.updatedAt)

    if (remoteUpdated && remoteUpdated > localUpdated) {
      // remote wins: drop the local edit, let the next pull apply the remote state
      finishRow(row, { etag: null })
      db.update(calendars).set({ syncToken: null }).where(eq(calendars.id, cal.id)).run()
      deps.onConflict(row.title)
    } else {
      // local wins: retry with the fresh etag
      db.update(events).set({ etag: remote.data.etag ?? null }).where(eq(events.id, row.id)).run()
    }
  }

  /** Returns true if any row was pushed (i.e. remote state changed). */
  async function drain(): Promise<boolean> {
    const googleCals = db
      .select()
      .from(calendars)
      .where(and(eq(calendars.provider, 'google'), isNull(calendars.deletedAt), eq(calendars.readOnly, false)))
      .all()
    if (googleCals.length === 0) return false

    let pushedAny = false
    const nowMs = DateTime.utc().toMillis()
    for (const cal of googleCals) {
      const dirtyRows = db
        .select()
        .from(events)
        .where(and(eq(events.calendarId, cal.id), eq(events.dirty, true)))
        .orderBy(asc(events.updatedAt))
        .all()
      // masters before exceptions so new series get provider ids first
      dirtyRows.sort((a, b) => Number(a.recurringEventId !== null) - Number(b.recurringEventId !== null))

      for (const row of dirtyRows) {
        const retry = retries.get(row.id)
        if (retry && retry.nextAtMs > nowMs) continue
        try {
          await pushRow(cal, row)
          pushedAny = true
        } catch (err) {
          const status = httpStatus(err)
          if (status === 412) {
            await resolveConflict(cal, row).catch(() => undefined)
            pushedAny = true
          } else {
            const attempts = (retry?.attempts ?? 0) + 1
            const backoffMs = Math.min(2 ** attempts * 30_000, 30 * 60_000)
            retries.set(row.id, { attempts, nextAtMs: nowMs + backoffMs })
            db.update(calendars)
              .set({ syncError: err instanceof Error ? err.message : 'push failed' })
              .where(eq(calendars.id, cal.id))
              .run()
            if (status === 401 || status === 403 || status === 429) break // stop hammering this calendar
          }
        }
      }
    }
    // CalDAV calendars share the same dirty-flag outbox
    if (caldav) {
      const davCals = db
        .select()
        .from(calendars)
        .where(and(eq(calendars.provider, 'caldav'), isNull(calendars.deletedAt), eq(calendars.readOnly, false)))
        .all()
      for (const cal of davCals) {
        const dirtyRows = db
          .select()
          .from(events)
          .where(and(eq(events.calendarId, cal.id), eq(events.dirty, true)))
          .orderBy(asc(events.updatedAt))
          .all()
        dirtyRows.sort((a, b) => Number(a.recurringEventId !== null) - Number(b.recurringEventId !== null))
        for (const row of dirtyRows) {
          const retry = retries.get(row.id)
          if (retry && retry.nextAtMs > nowMs) continue
          try {
            await caldav.pushRow(cal, row)
            finishRow(row, {})
            pushedAny = true
          } catch (err) {
            if (err instanceof ConflictError) {
              // 412: changed on the server while we held a local edit.
              // Last writer wins, mirroring the Google path; drop our etag so the
              // next pull re-evaluates remote state, and surface the conflict.
              db.update(events).set({ etag: null }).where(eq(events.id, row.id)).run()
              deps.onConflict(row.title)
              pushedAny = true
            } else {
              const attempts = (retry?.attempts ?? 0) + 1
              const backoffMs = Math.min(2 ** attempts * 30_000, 30 * 60_000)
              retries.set(row.id, { attempts, nextAtMs: nowMs + backoffMs })
              db.update(calendars)
                .set({ syncError: err instanceof Error ? err.message : 'push failed' })
                .where(eq(calendars.id, cal.id))
                .run()
              break
            }
          }
        }
      }
    }

    return pushedAny
  }

  return { drain }
}

export type OutboxWorker = ReturnType<typeof createOutboxWorker>
