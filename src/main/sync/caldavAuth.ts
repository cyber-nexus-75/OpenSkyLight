import { safeStorage } from 'electron'
import { and, eq, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { caldavAccounts, calendars, events } from '../db/schema'
import type { SettingsService } from '../services/settingsService'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { notFound } from '../services/errors'
import { listCalendars, type DiscoveredCalendar } from './caldavClient'

function encryptSecret(plain: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain)
  return Buffer.from(`plain:${plain}`, 'utf8')
}

function decryptSecret(buf: Buffer): string {
  const asString = buf.toString('utf8')
  if (asString.startsWith('plain:')) return asString.slice(6)
  return safeStorage.decryptString(buf)
}

export function createCalDavAuth(deps: { db: AppDb; settings: SettingsService }) {
  const { db } = deps

  /** Verify credentials and store the account. Returns discovery-ready info. */
  async function connect(input: { baseUrl: string; username: string; password: string }): Promise<{
    accountId: string
    displayName: string | null
  }> {
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const creds = { baseUrl, username: input.username.trim(), password: input.password }
    // probe with discovery so a bad URL/password fails now, not on first sync
    await listCalendars(creds)
    const displayName: string | null = null
    const id = uuidv7()
    db.insert(caldavAccounts)
      .values({
        id,
        baseUrl,
        username: creds.username,
        passwordEnc: encryptSecret(input.password),
        connectedAt: isoUtc(DateTime.utc()),
        lastError: null
      })
      .run()
    return { accountId: id, displayName }
  }

  function listAccounts(): {
    id: string
    baseUrl: string
    username: string
    displayName: string | null
    error: string | null
  }[] {
    return db.select().from(caldavAccounts).all().map((a) => ({
      id: a.id,
      baseUrl: a.baseUrl,
      username: a.username,
      displayName: a.displayName,
      error: a.lastError
    }))
  }

  /** Credentials for API calls — decrypted in main only, never in the renderer. */
  function credentialsFor(accountId: string): { baseUrl: string; username: string; password: string } {
    const [account] = db.select().from(caldavAccounts).where(eq(caldavAccounts.id, accountId)).all()
    if (!account?.passwordEnc) throw notFound('CalDAV account')
    return {
      baseUrl: account.baseUrl,
      username: account.username,
      password: decryptSecret(Buffer.from(account.passwordEnc))
    }
  }

  async function discoverCalendars(accountId: string): Promise<DiscoveredCalendar[]> {
    return listCalendars(credentialsFor(accountId))
  }

  function markError(accountId: string, message: string | null): void {
    db.update(caldavAccounts).set({ lastError: message }).where(eq(caldavAccounts.id, accountId)).run()
  }

  function disconnect(accountId: string): void {
    const [account] = db.select().from(caldavAccounts).where(eq(caldavAccounts.id, accountId)).all()
    if (!account) throw notFound('CalDAV account')
    const now = isoUtc(DateTime.utc())
    db.transaction((tx) => {
      const cals = tx
        .select()
        .from(calendars)
        .where(and(eq(calendars.caldavAccountId, accountId), isNull(calendars.deletedAt)))
        .all()
      for (const cal of cals) {
        tx.update(events).set({ deletedAt: now }).where(and(eq(events.calendarId, cal.id), isNull(events.deletedAt))).run()
        tx.update(calendars).set({ deletedAt: now }).where(eq(calendars.id, cal.id)).run()
      }
      tx.delete(caldavAccounts).where(eq(caldavAccounts.id, accountId)).run()
    })
  }

  return { connect, listAccounts, credentialsFor, discoverCalendars, markError, disconnect }
}

export type CalDavAuth = ReturnType<typeof createCalDavAuth>

/** Accepts bare hosts and appends the standard Nextcloud DAV path. */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '')
  if (/^https?:\/\/[^/]+$/i.test(u)) u = `${u}/remote.php/dav/`
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  return new URL(u).toString()
}
