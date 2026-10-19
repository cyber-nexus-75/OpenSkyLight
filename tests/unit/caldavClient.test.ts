import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import {
  findCalendarHomeSet,
  listCalendars,
  getCtag,
  multiget,
  etagReport,
  putEvent,
  deleteEvent,
  ConflictError
} from '../../src/main/sync/caldavClient'

/**
 * Stub CalDAV server modeled on Nextcloud's DAV endpoints. Round-trip test
 * only — never talks to a live Nextcloud.
 */
function startStub(): Promise<{ server: Server; base: string; stop: () => void }> {
  const events = new Map<string, { etag: string; data: string }>()
  let ctag = 'ctag-1'
  const server = createServer((req, res) => {
    const body: string[] = []
    req.on('data', (c) => body.push(String(c)))
    req.on('end', () => {
      const auth = req.headers.authorization ?? ''
      if (!auth.startsWith('Basic ')) {
        res.writeHead(401).end()
        return
      }
      const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':')
      if (user !== 'alice' || pass !== 'app-password') {
        res.writeHead(401).end()
        return
      }
      const url = req.url ?? '/'

      if (req.method === 'PROPFIND' && (url === '/' || url === '/remote.php/dav/' || url.endsWith('/remote.php/dav/'))) {
        res.writeHead(207, { 'Content-Type': 'application/xml' })
        res.end(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/remote.php/dav/principals/users/alice/</d:href>
    <d:propstat>
      <d:prop><c:calendar-home-set><d:href>/remote.php/dav/calendars/alice/</d:href></c:calendar-home-set></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`)
        return
      }

      if (req.method === 'PROPFIND' && body.join('').includes('getctag')) {
        res.writeHead(207, { 'Content-Type': 'application/xml' })
        res.end(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/family/</d:href>
    <d:propstat><d:prop><cs:getctag>${ctag}</cs:getctag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`)
        return
      }

      if (req.method === 'PROPFIND' && url.startsWith('/remote.php/dav/calendars/alice/')) {
        res.writeHead(207, { 'Content-Type': 'application/xml' })
        res.end(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/" xmlns:n="http://nextcloud.com/ns/">
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/family/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>Family</d:displayname>
        <ic:calendar-color>#0091ff</ic:calendar-color>
        <n:calendar-enabled>1</n:calendar-enabled>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/inbox/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>Inbox</d:displayname>
        <n:calendar-enabled>1</n:calendar-enabled>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/personal-shared-secret/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>Shared calendar</d:displayname>
        <n:calendar-enabled>0</n:calendar-enabled>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`)
        return
      }

      if (req.method === 'REPORT' && !body.join('').includes('calendar-multiget') && body.join('').includes('getetag')) {
        const rows = [...events.entries()]
          .map(([href, e]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${e.etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
          .join('')
        res.writeHead(207, { 'Content-Type': 'application/xml' })
        res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${rows}</d:multistatus>`)
        return
      }

      if (req.method === 'REPORT') {
        // multiget without href filter: return everything with bodies
        const rows = [...events.entries()]
          .map(([href, e]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${e.etag}</d:getetag><c:calendar-data>${e.data.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
          .join('')
        res.writeHead(207, { 'Content-Type': 'application/xml' })
        res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`)
        return
      }

      if (req.method === 'PUT') {
        const ifMatch = req.headers['if-match']
        const href = url
        const existing = events.get(href)
        if (ifMatch && existing && ifMatch !== existing.etag) {
          res.writeHead(412).end()
          return
        }
        const etag = `"etag-${events.size + 1}"`
        events.set(href, { etag, data: body.join('') })
        ctag = `ctag-${events.size + 1}`
        res.writeHead(201, { etag }).end()
        return
      }

      if (req.method === 'DELETE') {
        if (!events.has(url)) {
          res.writeHead(404).end()
          return
        }
        events.delete(url)
        ctag = `ctag-del-${events.size}`
        res.writeHead(204).end()
        return
      }

      res.writeHead(404).end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        server,
        base: `http://127.0.0.1:${port}/remote.php/dav/`,
        stop: () => new Promise<void>((r) => server.close(() => r()))
      })
    })
  })
}

describe('caldavClient against a stub server', () => {
  it('discovers the calendar home and lists only enabled calendars', async () => {
    const stub = await startStub()
    try {
      const creds = { baseUrl: stub.base, username: 'alice', password: 'app-password' }
      const home = await findCalendarHomeSet(creds)
      expect(home).toContain('/remote.php/dav/calendars/alice/')
      const cals = await listCalendars(creds)
      const names = cals.map((c) => c.name)
      expect(names).toContain('Family')
      expect(names).toContain('Inbox')
      expect(names).not.toContain('Shared calendar') // calendar-enabled 0
      const family = cals.find((c) => c.name === 'Family')!
      expect(family.color).toBe('#0091ff')
      expect(family.url).toContain('/remote.php/dav/calendars/alice/family/')
    } finally {
      await stub.stop()
    }
  })

  it('rejects bad credentials with a clear error', async () => {
    const stub = await startStub()
    try {
      const creds = { baseUrl: stub.base, username: 'alice', password: 'wrong' }
      await expect(findCalendarHomeSet(creds)).rejects.toThrow(/Invalid CalDAV username/)
    } finally {
      await stub.stop()
    }
  })

  it('round-trips a push → etag-report → pull cycle', async () => {
    const stub = await startStub()
    try {
      const creds = { baseUrl: stub.base, username: 'alice', password: 'app-password' }
      const calUrl = `${stub.base}calendars/alice/family/`
      const ics = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenSkyLight//EN',
        'BEGIN:VEVENT', 'UID:rt-1', 'SUMMARY:Round trip',
        'DTSTART;TZID=America/Denver:20260310T160000',
        'DTEND;TZID=America/Denver:20260310T170000',
        'END:VEVENT', 'END:VCALENDAR'
      ].join('\r\n')

      const put = await putEvent(calUrl, creds, ics)
      expect(put.etag).toMatch(/^"etag-/)

      const etags = await etagReport(calUrl, creds)
      expect(etags.length).toBe(1)
      expect(etags[0]!.etag).toBe(put.etag)

      const ctag1 = await getCtag(calUrl, creds)
      const entries = await multiget(calUrl, creds)
      expect(entries.length).toBe(1)
      expect(entries[0]!.data).toContain('Round trip')

      // optimistic concurrency: stale If-Match → 412 ConflictError
      await expect(
        putEvent(calUrl, creds, ics, { eventUrl: etags[0]!.href, ifMatch: '"stale"' })
      ).rejects.toThrow(ConflictError)

      // delete → etag report is empty, delete again is tolerated (404)
      await deleteEvent(etags[0]!.href, creds)
      expect((await etagReport(calUrl, creds)).length).toBe(0)
      await expect(deleteEvent(etags[0]!.href, creds)).resolves.toBeUndefined()

      const ctag2 = await getCtag(calUrl, creds)
      expect(ctag2).not.toBe(ctag1)
    } finally {
      await stub.stop()
    }
  })
})
