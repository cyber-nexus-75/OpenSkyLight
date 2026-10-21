import { and, eq, isNull } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { calendars } from '../db/schema'
import type { GoogleAuth } from './googleAuth'
import type { GoogleSync } from './googleSync'
import { httpStatus } from './googleSync'
import type { IcsSync } from './icsSync'
import type { CalDavSync } from './caldavSync'
import type { OutboxWorker } from './outboxWorker'
import type { SettingsService } from '../services/settingsService'
import type { WebdavService } from '../services/webdavService'

const TICK_MS = 60_000
const ICS_EVERY_N_TICKS = 30 // ≈ every 30 minutes
const DEFAULT_INTERVAL_MINUTES = 15

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error'
  lastError: string | null
  calendars: { id: string; name: string; provider: string; lastSyncedAt: string | null; syncError: string | null }[]
}

export function createSyncManager(deps: {
  db: AppDb
  auth: GoogleAuth
  google: GoogleSync
  caldav?: CalDavSync
  webdav?: Pick<WebdavService, 'pull'>
  backup?: { autoBackup: () => Promise<boolean> }
  outbox: OutboxWorker
  ics: IcsSync
  settings?: Pick<SettingsService, 'getAll'>
  broadcast: (channel: string, payload: unknown) => void
}) {
  const { db, auth, google, caldav, outbox, ics, broadcast } = deps
  let running = false
  let state: SyncStatus['state'] = 'idle'
  let lastError: string | null = null
  let tickCount = 0
  let timer: NodeJS.Timeout | null = null

  function setState(next: SyncStatus['state'], message?: string): void {
    state = next
    if (next === 'error') lastError = message ?? lastError
    if (next === 'idle') lastError = null
    broadcast('push:syncStatus', { state, message: lastError ?? undefined })
  }

  async function tick(opts: { ics: boolean }): Promise<void> {
    if (running) return
    running = true
    let anyChange = false
    let anyError: string | null = null
    setState('syncing')
    try {
      // 1. push local edits first so pulls don't race them
      try {
        anyChange = (await outbox.drain()) || anyChange
      } catch (err) {
        anyError = err instanceof Error ? err.message : 'push failed'
      }

      // 2. pull each google calendar
      const googleCals = db
        .select()
        .from(calendars)
        .where(and(eq(calendars.provider, 'google'), isNull(calendars.deletedAt)))
        .all()
      for (const cal of googleCals) {
        try {
          anyChange = (await google.pullCalendar(cal)) || anyChange
        } catch (err) {
          const message = err instanceof Error ? err.message : 'sync failed'
          anyError = message
          db.update(calendars).set({ syncError: message }).where(eq(calendars.id, cal.id)).run()
          if (httpStatus(err) === 401 && cal.googleAccountId) {
            auth.markAuthError(cal.googleAccountId, 'Sign-in expired — reconnect this account')
          }
        }
      }

      // 3. CalDAV calendars (Nextcloud) — etag-report pull keeps polling cheap
      if (caldav) {
        const davCals = db
          .select()
          .from(calendars)
          .where(and(eq(calendars.provider, 'caldav'), isNull(calendars.deletedAt)))
          .all()
        for (const cal of davCals) {
          try {
            anyChange = (await caldav.pullCalendar(cal)) || anyChange
          } catch (err) {
            const message = err instanceof Error ? err.message : 'CalDAV sync failed'
            anyError = message
            db.update(calendars).set({ syncError: message }).where(eq(calendars.id, cal.id)).run()
          }
        }
      }
      // 4. screensaver photos from Nextcloud/WebDAV on the slow cadence
      if (opts.ics && deps.webdav) {
        try {
          const changed = await deps.webdav.pull()
          if (changed > 0) broadcast('push:screensaverPhotos', { changed })
        } catch (err) {
          // photo sync failing must never block calendar sync; surfaced via status
          console.error('[sync] webdav photo pull failed:', err instanceof Error ? err.message : err)
        }
      }
      // 5. daily backup to the WebDAV folder (no-op if not due)
      if (opts.ics && deps.backup) {
        try {
          await deps.backup.autoBackup()
        } catch {
          // autoBackup records its own errors; never block calendar sync
        }
      }
      // 6. ICS feeds on the slow cadence
      if (opts.ics) {
        const icsCals = db
          .select()
          .from(calendars)
          .where(and(eq(calendars.provider, 'ics'), isNull(calendars.deletedAt)))
          .all()
        for (const cal of icsCals) {
          try {
            anyChange = (await ics.pullFeed(cal)) || anyChange
          } catch (err) {
            const message = err instanceof Error ? err.message : 'feed failed'
            anyError = message
            db.update(calendars).set({ syncError: message }).where(eq(calendars.id, cal.id)).run()
          }
        }
      }
    } finally {
      running = false
      if (anyChange) broadcast('push:dataChanged', { domain: 'events' })
      setState(anyError ? 'error' : 'idle', anyError ?? undefined)
    }
  }

  function intervalTicks(): number {
    const minutes = deps.settings?.getAll().syncIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES
    return Math.max(1, Math.round((minutes * 60_000) / TICK_MS))
  }

  function start(): void {
    if (timer) return
    // first run shortly after boot, with ICS included
    setTimeout(() => void tick({ ics: true }), 3_000)
    const scheduleNext = (): void => {
      timer = setTimeout(() => {
        tickCount += 1
        void tick({ ics: tickCount % ICS_EVERY_N_TICKS === 0 }).finally(() => scheduleNext())
      }, intervalTicks() * TICK_MS)
    }
    scheduleNext()
  }

  function stop(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  /** Manual "Sync now" — also used right after connecting/selecting calendars. */
  function syncNow(): void {
    void tick({ ics: true })
  }

  function getStatus(): SyncStatus {
    const rows = db
      .select()
      .from(calendars)
      .where(isNull(calendars.deletedAt))
      .all()
      .filter((c) => c.provider !== 'local')
    return {
      state,
      lastError,
      calendars: rows.map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        lastSyncedAt: c.lastSyncedAt,
        syncError: c.syncError
      }))
    }
  }

  return { start, stop, syncNow, getStatus }
}

export type SyncManager = ReturnType<typeof createSyncManager>
