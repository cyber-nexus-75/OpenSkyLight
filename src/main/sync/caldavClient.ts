import { XMLParser } from 'fast-xml-parser'

/**
 * Minimal CalDAV client: PROPFIND discovery, ctag/etag-based pull, PUT/DELETE push.
 * Pure Node (fetch) — no Electron imports — so it is fully unit-testable
 * against a stub server.
 */

export interface CalDavCredentials {
  baseUrl: string
  username: string
  password: string
}

export interface DiscoveredCalendar {
  url: string
  name: string
  color: string
  readOnly: boolean
}

export interface CalendarMultigetEntry {
  href: string
  etag: string
  data: string
}

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false
})

function authHeader(creds: CalDavCredentials): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
}

/** Resolve a possibly-relative href against the calendar home or server root. */
export function resolveUrl(base: string, href: string): string {
  return new URL(href, base.endsWith('/') ? base : base + '/').toString()
}

function findFirst(obj: unknown, ...keys: string[]): unknown {
  if (obj === null || typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  for (const key of keys) {
    if (rec[key] !== undefined) return rec[key]
    for (const [k, v] of Object.entries(rec)) {
      if (k.replace(/^.*:/, '') === key) return v
    }
  }
  for (const v of Object.values(rec)) {
    const found = findFirst(v, ...keys)
    if (found !== undefined) return found
  }
  return undefined
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec['@_href'] === 'string') return rec['@_href']
    if (typeof rec.href === 'string') return rec.href
    if (typeof rec['#text'] === 'string') return rec['#text']
  }
  return String(value)
}

/** Find the principal's calendar-home-set URL via PROPFIND on the base URL. */
export async function findCalendarHomeSet(
  creds: CalDavCredentials,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const body = `<?xml version="1.0"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set/>
  </D:prop>
</D:propfind>`
  const res = await fetchFn(creds.baseUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(creds),
      Depth: '0',
      'Content-Type': 'application/xml'
    },
    body
  })
  if (res.status === 401 || res.status === 403) throw new Error('Invalid CalDAV username or app password')
  if (!res.ok) throw new Error(`CalDAV server returned HTTP ${res.status}`)
  const xmlText = await res.text()
  const doc = XML.parse(xmlText)
  const home = findFirst(doc, 'calendar-home-set')
  const href = home ? textOf(home) : ''
  if (!href) throw new Error('Server did not return a calendar-home-set')
  return resolveUrl(creds.baseUrl, href)
}

/** PROPFIND the calendar home for all calendar collections. */
export async function listCalendars(
  creds: CalDavCredentials,
  fetchFn: typeof fetch = fetch
): Promise<DiscoveredCalendar[]> {
  const home = await findCalendarHomeSet(creds, fetchFn)
  const body = `<?xml version="1.0"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:IC="http://apple.com/ns/ical/" xmlns:N="http://nextcloud.com/ns/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <C:supported-calendar-component-set/>
    <IC:calendar-color/>
    <N:calendar-enabled/>
  </D:prop>
</D:propfind>`
  const res = await fetchFn(home, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(creds),
      Depth: '1',
      'Content-Type': 'application/xml'
    },
    body
  })
  if (!res.ok) throw new Error(`CalDAV server returned HTTP ${res.status}`)
  const doc = XML.parse(await res.text())
  const responses = (findFirst(doc, 'response') ? toArray(findFirst(doc, 'response')) : []) as unknown[]
  const out: DiscoveredCalendar[] = []
  for (const resp of responses) {
    const href = textOf(findFirst(resp, 'href'))
    if (!href) continue
    const resourceTypes = findFirst(resp, 'resourcetype')
    const isCalendar =
      typeof resourceTypes === 'object' && resourceTypes !== null
        ? Object.keys(flatten(resourceTypes as Record<string, unknown>)).some((k) => k.replace(/^.*:/, '') === 'calendar')
        : false
    if (!isCalendar) continue
    const name = textOf(findFirst(resp, 'displayname')) || decodeURIComponent(href.replace(/\/$/, '').split('/').pop() ?? '')
    const color = textOf(findFirst(resp, 'calendar-color')) || '#0091FF'
    const enabled = textOf(findFirst(resp, 'calendar-enabled'))
    if (enabled === '0' || enabled === 'false') continue
    out.push({
      url: resolveUrl(home, href),
      name,
      color: /^#[0-9a-fA-F]{6}/.test(color) ? color.slice(0, 7) : '#0091FF',
      readOnly: false
    })
  }
  return out
}

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v]
}

function flatten(obj: Record<string, unknown>, out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v
    if (v && typeof v === 'object') flatten(v as Record<string, unknown>, out)
  }
  return out
}

/** Fetch the calendar's ctag (sync token): changed → refetch everything. */
export async function getCtag(
  calendarUrl: string,
  creds: CalDavCredentials,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  const body = `<?xml version="1.0"?>
<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <CS:getctag/>
    <D:sync-token/>
  </D:prop>
</D:propfind>`
  const res = await fetchFn(calendarUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(creds),
      Depth: '0',
      'Content-Type': 'application/xml'
    },
    body
  })
  if (!res.ok) throw new Error(`CalDAV server returned HTTP ${res.status}`)
  const doc = XML.parse(await res.text())
  const ctag = textOf(findFirst(doc, 'getctag'))
  if (ctag) return ctag
  const syncToken = textOf(findFirst(doc, 'sync-token'))
  return syncToken || null
}

/** Report (multiget) events with etags; optional href filter for cheap pull. */
export async function multiget(
  calendarUrl: string,
  creds: CalDavCredentials,
  fetchFn: typeof fetch = fetch
): Promise<CalendarMultigetEntry[]> {
  const body = `<?xml version="1.0"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter/>
</C:calendar-multiget>`
  const res = await fetchFn(calendarUrl, {
    method: 'REPORT',
    headers: {
      Authorization: authHeader(creds),
      Depth: '1',
      'Content-Type': 'application/xml'
    },
    body
  })
  if (!res.ok) throw new Error(`CalDAV REPORT failed: HTTP ${res.status}`)
  const doc = XML.parse(await res.text())
  const responses = toArray(findFirst(doc, 'response')) as unknown[]
  const out: CalendarMultigetEntry[] = []
  for (const resp of responses) {
    const hrefRaw = textOf(findFirst(resp, 'href'))
    const etag = textOf(findFirst(resp, 'getetag'))
    const data = textOf(findFirst(resp, 'calendar-data'))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
    if (!hrefRaw || !data) continue
    out.push({ href: resolveUrl(calendarUrl, hrefRaw), etag, data })
  }
  return out
}

/** List event hrefs + etags without bodies (cheap change detection). */
export async function etagReport(
  calendarUrl: string,
  creds: CalDavCredentials,
  fetchFn: typeof fetch = fetch
): Promise<{ href: string; etag: string }[]> {
  const body = `<?xml version="1.0"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
  </D:prop>
  <C:filter/>
</C:calendar-query>`
  const res = await fetchFn(calendarUrl, {
    method: 'REPORT',
    headers: {
      Authorization: authHeader(creds),
      Depth: '1',
      'Content-Type': 'application/xml'
    },
    body
  })
  if (!res.ok) throw new Error(`CalDAV REPORT failed: HTTP ${res.status}`)
  const doc = XML.parse(await res.text())
  const responses = toArray(findFirst(doc, 'response')) as unknown[]
  const out: { href: string; etag: string }[] = []
  for (const resp of responses) {
    const hrefRaw = textFirstLevel(resp)
    const etag = textOf(findFirst(resp, 'getetag'))
    if (hrefRaw && etag) out.push({ href: resolveUrl(calendarUrl, hrefRaw), etag })
  }
  return out
}

function textFirstLevel(resp: unknown): string {
  if (resp === null || typeof resp !== 'object') return ''
  const rec = resp as Record<string, unknown>
  const href = rec['href'] ?? rec['D:href'] ?? findFirst(resp, 'href')
  return textOf(href)
}

export interface PutResult {
  etag: string | null
}

/** Create or update one VEVENT. Pass If-Match for optimistic concurrency. */
export async function putEvent(
  calendarUrl: string,
  creds: CalDavCredentials,
  ics: string,
  opts: { eventUrl?: string; ifMatch?: string | null } = {},
  fetchFn: typeof fetch = fetch
): Promise<PutResult> {
  const url = opts.eventUrl ? resolveUrl(calendarUrl, opts.eventUrl) : newEventUrl(calendarUrl)
  const headers: Record<string, string> = {
    Authorization: authHeader(creds),
    'Content-Type': 'text/calendar; charset=utf-8'
  }
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch
  const res = await fetchFn(url, { method: 'PUT', headers, body: ics })
  if (res.status === 412) throw new ConflictError('Event changed on the server')
  if (!res.ok) throw new Error(`CalDAV PUT failed: HTTP ${res.status}`)
  return { etag: res.headers.get('etag') }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export async function deleteEvent(
  eventUrl: string,
  creds: CalDavCredentials,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const res = await fetchFn(eventUrl, {
    method: 'DELETE',
    headers: { Authorization: authHeader(creds) }
  })
  if (res.status === 404 || res.status === 410) return
  if (!res.ok) throw new Error(`CalDAV DELETE failed: HTTP ${res.status}`)
}

const URL_SAFE = /^[A-Za-z0-9._-]+$/

function newEventUrl(calendarUrl: string): string {
  let uid: string
  do {
    uid = `osl-${crypto.randomUUID()}`
  } while (!URL_SAFE.test(uid))
  const base = calendarUrl.endsWith('/') ? calendarUrl : calendarUrl + '/'
  return `${base}${uid}.ics`
}

export function davFetch(creds: CalDavCredentials): typeof fetch {
  const wrapped = (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', authHeader(creds))
    return fetch(input, { ...init, headers })
  }
  return wrapped as unknown as typeof fetch
}
