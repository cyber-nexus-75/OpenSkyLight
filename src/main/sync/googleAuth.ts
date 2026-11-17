import http from 'node:http'
import crypto from 'node:crypto'
import { AddressInfo } from 'node:net'
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'
import { safeStorage, shell } from 'electron'
import { and, eq, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { calendars, events, googleAccounts } from '../db/schema'
import type { SettingsService } from '../services/settingsService'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { AppError, invalid, notFound } from '../services/errors'

const SCOPES = ['https://www.googleapis.com/auth/calendar', 'openid', 'email']
const KEY_CLIENT_ID = 'google.clientId'
const KEY_CLIENT_SECRET = 'google.clientSecretEnc'
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000

/** Server-mode hooks: OAuth redirects land on the web server instead of a loopback listener. */
export interface GoogleAuthHooks {
  /** Base URL other devices can reach, e.g. http://192.168.1.10:8080 */
  publicBaseUrl?: string
  /** Receives the consent URL (pushed to web clients) instead of opening a local browser */
  onAuthUrl?: (url: string) => void
  /** Registers the handler for `${publicBaseUrl}/__oauth/google` redirects */
  registerCallback?: (
    handler: (q: { code: string | null; error: string | null; state: string | null }) => boolean
  ) => void
}

interface PendingAuth {
  resolve: (v: { code: string; redirectUri: string; verifier: string }) => void
  reject: (err: unknown) => void
  verifier: string
  redirectUri: string
  timer: NodeJS.Timeout
}

function encryptSecret(plain: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain)
  return Buffer.from(`plain:${plain}`, 'utf8')
}

function decryptSecret(buf: Buffer): string {
  const asString = buf.toString('utf8')
  if (asString.startsWith('plain:')) return asString.slice(6)
  return safeStorage.decryptString(buf)
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createGoogleAuth(db: AppDb, settings: SettingsService, hooks: GoogleAuthHooks = {}) {
  let connectInFlight = false
  const pending = new Map<string, PendingAuth>()
  if (hooks.registerCallback) {
    hooks.registerCallback((q) => {
      const p = q.state ? pending.get(q.state) : undefined
      if (!p || !q.state) return false
      pending.delete(q.state)
      clearTimeout(p.timer)
      if (q.code) p.resolve({ code: q.code, redirectUri: p.redirectUri, verifier: p.verifier })
      else p.reject(new AppError('AUTH_DENIED', `Google sign-in failed: ${q.error ?? 'no authorization code'}`))
      return true
    })
  }

  function getCredentials(): { clientId: string; clientSecret: string } | null {
    const clientId = settings.getRaw(KEY_CLIENT_ID)
    const secretB64 = settings.getRaw(KEY_CLIENT_SECRET)
    if (!clientId || !secretB64) return null
    try {
      return { clientId, clientSecret: decryptSecret(Buffer.from(secretB64, 'base64')) }
    } catch {
      return null
    }
  }

  function setCredentials(clientId: string, clientSecret: string): void {
    settings.setRaw(KEY_CLIENT_ID, clientId.trim())
    settings.setRaw(KEY_CLIENT_SECRET, encryptSecret(clientSecret.trim()).toString('base64'))
  }

  function isConfigured(): boolean {
    return getCredentials() !== null
  }

  function listAccounts(): { id: string; email: string; error: string | null }[] {
    return db
      .select()
      .from(googleAccounts)
      .all()
      .map((a) => ({ id: a.id, email: a.email, error: a.lastRefreshError }))
  }

  /** Loopback OAuth flow: opens the system browser, waits for the redirect. */
  async function connect(): Promise<{ email: string }> {
    const creds = getCredentials()
    if (!creds) throw new AppError('NOT_CONFIGURED', 'Enter your Google OAuth client ID and secret first')
    if (connectInFlight) throw new AppError('BUSY', 'A Google sign-in is already in progress')
    connectInFlight = true
    try {
      const code = await waitForAuthCode(creds)
      const account = await exchangeAndStore(creds, code.code, code.redirectUri, code.verifier)
      return { email: account.email }
    } finally {
      connectInFlight = false
    }
  }

  function waitForAuthCode(creds: {
    clientId: string
    clientSecret: string
  }): Promise<{ code: string; redirectUri: string; verifier: string }> {
    if (hooks.publicBaseUrl && hooks.onAuthUrl) return waitForAuthCodeViaServer(creds)
    return waitForAuthCodeLoopback(creds)
  }

  /** Server mode: Google redirects to <publicBaseUrl>/__oauth/google, which the
   *  HTTP server routes to the registered callback — no browser on the server. */
  function waitForAuthCodeViaServer(creds: {
    clientId: string
    clientSecret: string
  }): Promise<{ code: string; redirectUri: string; verifier: string }> {
    return new Promise((resolve, reject) => {
      const verifier = b64url(crypto.randomBytes(32))
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
      const state = b64url(crypto.randomBytes(16))
      const redirectUri = `${hooks.publicBaseUrl}/__oauth/google`
      const client = new OAuth2Client({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        redirectUri
      })
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: challenge,
        state
      })
      const timer = setTimeout(() => {
        pending.delete(state)
        reject(new AppError('AUTH_TIMEOUT', 'Google sign-in timed out'))
      }, CONNECT_TIMEOUT_MS)
      pending.set(state, { resolve, reject, verifier, redirectUri, timer })
      hooks.onAuthUrl!(authUrl)
    })
  }

  /** Desktop mode: loopback redirect on 127.0.0.1, system browser opens the consent URL. */
  function waitForAuthCodeLoopback(creds: {
    clientId: string
    clientSecret: string
  }): Promise<{ code: string; redirectUri: string; verifier: string }> {
    return new Promise((resolve, reject) => {
      const verifier = b64url(crypto.randomBytes(32))
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())

      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body style="font-family:sans-serif;text-align:center;padding-top:4rem">
             <h2>${code ? 'Connected!' : 'Sign-in failed'}</h2>
             <p>You can close this tab and return to your OpenSkyLight display.</p>
           </body></html>`
        )
        if (code) {
          cleanup()
          resolve({ code, redirectUri, verifier })
        } else if (error) {
          cleanup()
          reject(new AppError('AUTH_DENIED', `Google sign-in failed: ${error}`))
        }
      })

      let redirectUri = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new AppError('AUTH_TIMEOUT', 'Google sign-in timed out'))
      }, CONNECT_TIMEOUT_MS)

      function cleanup(): void {
        clearTimeout(timer)
        server.close()
      }

      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port
        redirectUri = `http://127.0.0.1:${port}`
        const client = new OAuth2Client({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          redirectUri
        })
        const authUrl = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: SCOPES,
          code_challenge_method: CodeChallengeMethod.S256,
          code_challenge: challenge
        })
        void shell.openExternal(authUrl)
      })
      server.on('error', (err) => {
        cleanup()
        reject(err)
      })
    })
  }

  async function exchangeAndStore(
    creds: { clientId: string; clientSecret: string },
    code: string,
    redirectUri: string,
    verifier: string
  ): Promise<{ id: string; email: string }> {
    const client = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri })
    const { tokens } = await client.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri })
    if (!tokens.refresh_token) throw new AppError('NO_REFRESH_TOKEN', 'Google did not return a refresh token')

    const userinfo = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })
    const profile = (await userinfo.json()) as { email?: string }
    const email = profile.email ?? 'unknown'

    const enc = encryptSecret(tokens.refresh_token)
    const existing = db.select().from(googleAccounts).where(eq(googleAccounts.email, email)).all()
    if (existing.length > 0) {
      db.update(googleAccounts)
        .set({ refreshTokenEnc: enc, lastRefreshError: null, connectedAt: isoUtc(DateTime.utc()) })
        .where(eq(googleAccounts.id, existing[0].id))
        .run()
      return { id: existing[0].id, email }
    }
    const id = uuidv7()
    db.insert(googleAccounts)
      .values({ id, email, refreshTokenEnc: enc, scopes: SCOPES.join(' '), connectedAt: isoUtc(DateTime.utc()) })
      .run()
    return { id, email }
  }

  /** An OAuth2Client ready for API calls for a stored account. */
  function getAuthedClient(accountId: string): OAuth2Client {
    const creds = getCredentials()
    if (!creds) throw new AppError('NOT_CONFIGURED', 'Google credentials missing')
    const [account] = db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId)).all()
    if (!account?.refreshTokenEnc) throw notFound('Google account')
    const client = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret })
    client.setCredentials({ refresh_token: decryptSecret(Buffer.from(account.refreshTokenEnc)) })
    return client
  }

  function markAuthError(accountId: string, message: string | null): void {
    db.update(googleAccounts).set({ lastRefreshError: message }).where(eq(googleAccounts.id, accountId)).run()
  }

  function disconnect(accountId: string): void {
    const [account] = db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId)).all()
    if (!account) throw notFound('Google account')
    const now = isoUtc(DateTime.utc())
    db.transaction((tx) => {
      const cals = tx
        .select()
        .from(calendars)
        .where(and(eq(calendars.googleAccountId, accountId), isNull(calendars.deletedAt)))
        .all()
      for (const cal of cals) {
        tx.update(events).set({ deletedAt: now }).where(and(eq(events.calendarId, cal.id), isNull(events.deletedAt))).run()
        tx.update(calendars).set({ deletedAt: now }).where(eq(calendars.id, cal.id)).run()
      }
      tx.delete(googleAccounts).where(eq(googleAccounts.id, accountId)).run()
    })
  }

  return { isConfigured, setCredentials, connect, listAccounts, getAuthedClient, markAuthError, disconnect }
}

export type GoogleAuth = ReturnType<typeof createGoogleAuth>

export function assertHttpsUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw invalid('Not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalid('Feed URLs must be http(s)')
  }
}
