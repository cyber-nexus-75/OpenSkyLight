import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdirSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { safeStorage } from 'electron'
import { XMLParser } from 'fast-xml-parser'
import { DateTime } from 'luxon'
import type { SettingsService } from './settingsService'
import { AppError, invalid } from './errors'
import { isoUtc } from '@shared/dates'

/**
 * Screensaver photos live on the user's Nextcloud (or any WebDAV server).
 * Main pulls them into a local cache dir on a schedule so the screensaver
 * never streams from the network; the paired phone uploads through the
 * companion server, which PUTs with these credentials in main only.
 *
 * Credentials are stored in raw settings keys (never part of AppSettings,
 * so they never cross to the renderer); the password is safeStorage-encrypted.
 */

const KEY_URL = 'screensaver.webdav.url'
const KEY_USERNAME = 'screensaver.webdav.username'
const KEY_PASSWORD_ENC = 'screensaver.webdav.passwordEnc'
const KEY_LAST_SYNC = 'screensaver.webdav.lastSync'

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const XML = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false })

export interface WebDavStatus {
  configured: boolean
  url: string | null
  username: string | null
  lastSyncedAt: string | null
  /** photos currently in the local pull cache */
  cachedCount: number
  lastError: string | null
}

function encryptSecret(plain: string): string {
  const available = (() => {
    try {
      return safeStorage?.isEncryptionAvailable() ?? false
    } catch {
      return false
    }
  })()
  const buf = available ? safeStorage.encryptString(plain) : Buffer.from(`plain:${plain}`, 'utf8')
  return buf.toString('base64')
}

function decryptSecret(b64: string): string {
  const buf = Buffer.from(b64, 'base64')
  const asString = buf.toString('utf8')
  if (asString.startsWith('plain:')) return asString.slice(6)
  return safeStorage.decryptString(buf)
}

export type DavFetch = (url: string, init?: RequestInit) => Promise<Response>

export function davFetch(creds: { url: string; username: string; password: string }): DavFetch {
  const auth = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
  return async (url, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', auth)
    return fetch(url, { ...init, headers })
  }
}

export interface DavFileInfo {
  name: string
  etag: string
  size: number
}

/** PROPFIND Depth:1 on the photo directory; returns photo files only. */
export async function davList(
  fetchFn: DavFetch,
  dirUrl: string
): Promise<DavFileInfo[]> {
  const res = await fetchFn(dirUrl, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:displayname/><D:getcontentlength/><D:getetag/><D:resourcetype/></D:prop>
</D:propfind>`
  })
  if (res.status === 401 || res.status === 403) throw new AppError('WEBDAV_AUTH', 'Invalid WebDAV username or app password')
  if (!res.ok) throw new AppError('WEBDAV_ERROR', `WebDAV server returned HTTP ${res.status}`)
  const doc = XML.parse(await res.text())
  const responses = (Array.isArray(doc.multistatus?.response) ? doc.multistatus.response : [doc.multistatus?.response]).filter(
    (r: unknown) => r !== null && r !== undefined
  ) as Record<string, unknown>[]
  const out: DavFileInfo[] = []
  for (const resp of responses) {
    const href = textOf(resp.href)
    if (!href || href.endsWith('/')) continue // the collection itself
    const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop() ?? '')
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (!PHOTO_EXTENSIONS.has(ext)) continue
    const propstat = (Array.isArray(resp.propstat) ? resp.propstat[0] : resp.propstat) as Record<string, unknown> | undefined
    const prop = (propstat?.prop ?? {}) as Record<string, unknown>
    if (prop.resourcetype && typeof prop.resourcetype === 'object' && 'collection' in (prop.resourcetype as object)) continue
    const etag = textOf(prop.getetag)
    out.push({ name, etag, size: Number(textOf(prop.getcontentlength) || '0') })
  }
  return out
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec['#text'] === 'string') return rec['#text']
    if (typeof rec['@_href'] === 'string') return rec['@_href']
  }
  return String(value)
}

export function safeFileName(name: string): string {
  const trimmed = name.trim()
  // no path separators, no leading dots, no control chars — the name becomes
  // a single path segment inside the remote dir
  if (
    trimmed.length === 0 ||
    trimmed.length > 200 ||
    trimmed.startsWith('.') ||
    /[\\/:*?"<>|\u0000-\u001f]/.test(trimmed)
  ) {
    throw invalid('Invalid file name')
  }
  return trimmed
}

export function createWebdavService(deps: {
  settings: SettingsService
  /** local pull cache; the screensaver serves from here */
  cacheDir: string
}) {
  const { settings, cacheDir } = deps
  mkdirSync(cacheDir, { recursive: true })
  let lastError: string | null = null

  function credentials(): { url: string; username: string; password: string } | null {
    const url = settings.getRaw(KEY_URL)
    const username = settings.getRaw(KEY_USERNAME)
    const passwordEnc = settings.getRaw(KEY_PASSWORD_ENC)
    if (!url || !username || !passwordEnc) return null
    return { url, username, password: decryptSecret(passwordEnc) }
  }

  function getStatus(): WebDavStatus {
    const creds = credentials()
    return {
      configured: creds !== null,
      url: creds?.url ?? null,
      username: creds?.username ?? null,
      lastSyncedAt: settings.getRaw(KEY_LAST_SYNC),
      cachedCount: listCache().length,
      lastError
    }
  }

  /** Verify + store credentials. Throws on bad ones so the UI fails fast. */
  async function connect(input: { url: string; username: string; password: string }): Promise<void> {
    const url = input.url.trim().replace(/\/+$/, '') + '/'
    if (!/^https?:\/\//i.test(url)) throw invalid('WebDAV URL must be http(s)')
    const creds = { url, username: input.username.trim(), password: input.password }
    await davList(davFetch(creds), url) // probe — rejects bad URL/credentials
    settings.setRaw(KEY_URL, url)
    settings.setRaw(KEY_USERNAME, creds.username)
    settings.setRaw(KEY_PASSWORD_ENC, encryptSecret(creds.password))
    lastError = null
  }

  function disconnect(): void {
    for (const key of [KEY_URL, KEY_USERNAME, KEY_PASSWORD_ENC, KEY_LAST_SYNC]) settings.deleteRaw(key)
    clearCache()
  }

  function listCache(): string[] {
    try {
      return readdirSync(cacheDir).filter((f) => !f.startsWith('.')).sort()
    } catch {
      return []
    }
  }

  function clearCache(): void {
    for (const f of listCache()) {
      try {
        unlinkSync(join(cacheDir, f))
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Pull: PROPFIND the remote dir, download new/changed photos (etag compare),
   * remove local files that vanished remotely. Returns how many files changed.
   */
  async function pull(fetchFn?: DavFetch): Promise<number> {
    const creds = credentials()
    if (!creds) return 0
    const fn = fetchFn ?? davFetch(creds)
    const remote = await davList(fn, creds.url)

    const localEtags = new Map<string, string>()
    for (const name of listCache()) {
      try {
        localEtags.set(name, readEtag(name))
      } catch {
        localEtags.set(name, '?')
      }
    }

    let changed = 0
    const remoteNames = new Set<string>()
    for (const file of remote) {
      // a hostile server must not smuggle names that escape the cache dir
      // (traversal, Windows ADS, dotfiles) — same rules as uploads
      try {
        safeFileName(file.name)
      } catch {
        continue
      }
      remoteNames.add(file.name)
      if (localEtags.get(file.name) === file.etag) continue
      const res = await fn(`${creds.url}${encodeURIComponent(file.name)}`)
      if (!res.ok) throw new AppError('WEBDAV_ERROR', `Download failed: HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      writeFileSync(join(cacheDir, file.name), bytes)
      writeEtag(file.name, file.etag)
      changed++
    }
    for (const name of [...localEtags.keys()]) {
      if (!remoteNames.has(name)) {
        try {
          unlinkSync(join(cacheDir, name))
          unlinkSync(etagPath(name))
        } catch {
          // best-effort
        }
        changed++
      }
    }
    settings.setRaw(KEY_LAST_SYNC, isoUtc(DateTime.utc()))
    lastError = null
    return changed
  }

  // etag sidecar so we can skip unchanged downloads without re-reading files
  function etagPath(name: string): string {
    const hash = createHash('sha1').update(name).digest('hex').slice(0, 16)
    return resolve(join(cacheDir, `.etags-${hash}.json`))
  }
  function writeEtag(name: string, etag: string): void {
    try {
      writeFileSync(etagPath(name), JSON.stringify({ name, etag }))
    } catch {
      // best-effort; a re-download later is harmless
    }
  }
  function readEtag(name: string): string {
    const raw = existsSync(etagPath(name)) ? readFileSync(etagPath(name), 'utf8') : ''
    try {
      return (JSON.parse(raw) as { etag: string }).etag
    } catch {
      return '?'
    }
  }

  /** Upload from the paired phone: PUT into the remote dir, then pull so the kiosk sees it. */
  async function upload(fileName: string, bytes: Buffer, fetchFn?: DavFetch): Promise<void> {
    const creds = credentials()
    if (!creds) throw new AppError('NOT_CONFIGURED', 'Connect the photo WebDAV folder in Settings first')
    const fn = fetchFn ?? davFetch(creds)
    const name = safeFileName(fileName)
    const res = await fn(`${creds.url}${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes)
    })
    if (!res.ok) throw new AppError('WEBDAV_ERROR', `Upload failed: HTTP ${res.status}`)
    // surface the new photo immediately
    try {
      await pull(fetchFn)
    } catch {
      // the upload succeeded; the next scheduled pull will pick it up
    }
  }

  return { getStatus, connect, disconnect, pull, upload, listCache }
}

export type WebdavService = ReturnType<typeof createWebdavService>
