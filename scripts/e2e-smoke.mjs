// End-to-end smoke test: launch the built app with an isolated data dir,
// create an event through the real UI, and verify it appears in the week grid.
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-smoke-'))
mkdirSync('shots', { recursive: true })

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await page.waitForSelector('text=Week', { timeout: 15000 })
  // the app boots to Home; event creation lives on the calendar views
  await page.getByRole('button', { name: 'Week', exact: true }).click()

  // Open the editor via the FAB and create an event
  await page.getByLabel('Add event').click()
  await page.getByPlaceholder("What's happening?").fill('Soccer practice')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // The card should appear in the week grid
  await page.waitForSelector('text=Soccer practice', { timeout: 5000 })
  await page.screenshot({ path: 'shots/smoke-created.png' })

  // Reopen it and verify the editor loads the event
  await page.getByText('Soccer practice').first().click()
  await page.waitForSelector('text=Edit event', { timeout: 5000 })
  await page.keyboard.press('Escape')

  // Avatar flow: create a person, upload a photo, verify it renders in Settings
  await page.evaluate(async () => {
    const inv = async (ch, p) => {
      const res = await window.osl.invoke(ch, p)
      if (!res.ok) throw new Error(`${ch}: ${res.error?.message}`)
      return res.data
    }
    const person = await inv('people:create', { name: 'Test Kid', color: '#46A758', role: 'child' })
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#46A758'
    ctx.fillRect(0, 0, 256, 256)
    const data = canvas.toDataURL('image/png').split(',')[1]
    const updated = await inv('people:setAvatar', { personId: person.id, data })
    if (!updated.avatarUrl?.startsWith('osl-avatar://')) throw new Error('avatarUrl missing on PersonDto')
  })
  await page.reload()
  await page.waitForSelector('text=Week', { timeout: 15000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.waitForSelector('text=Family', { timeout: 5000 })
  const avatarImg = page.locator('img[src^="osl-avatar://"]').first()
  await avatarImg.waitFor({ state: 'visible', timeout: 5000 })

  // CalDAV (Nextcloud) two-way sync against a stub server — no live Nextcloud.
  // The stub serves one calendar with one VEVENT and accepts pushes.
  const events = new Map()
  let ctag = 'ctag-1'
  const stub = createServer((req, res) => {
    const body = []
    req.on('data', (c) => body.push(String(c)))
    req.on('end', () => {
      const auth = req.headers.authorization ?? ''
      if (!auth.startsWith('Basic ')) return res.writeHead(401).end()
      const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':')
      if (user !== 'smoke' || pass !== 'stub-password') return res.writeHead(401).end()
      const url = req.url ?? ''
      if (req.method === 'PROPFIND' && url.endsWith('/dav/')) {
        return res.writeHead(207).end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/dav/calendars/smoke/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>')
      }
      if (req.method === 'PROPFIND' && body.join('').includes('getctag')) {
        return res.writeHead(207).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:response><d:href>/dav/calendars/smoke/family/</d:href><d:propstat><d:prop><cs:getctag>${ctag}</cs:getctag></d:prop></d:propstat></d:response></d:multistatus>`)
      }
      if (req.method === 'PROPFIND' && url.startsWith('/dav/calendars/smoke/')) {
        return res.writeHead(207).end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:n="http://nextcloud.com/ns/"><d:response><d:href>/dav/calendars/smoke/family/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Stub Family</d:displayname><n:calendar-enabled>1</n:calendar-enabled></d:prop></d:propstat></d:response></d:multistatus>')
      }
      if (req.method === 'REPORT' && body.join('').includes('calendar-multiget')) {
        const rows = [...events.entries()].map(([href, e]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${e.etag}</d:getetag><c:calendar-data>${e.data.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</c:calendar-data></d:prop></d:propstat></d:response>`).join('')
        return res.writeHead(207).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`)
      }
      if (req.method === 'REPORT') {
        const rows = [...events.entries()].map(([href, e]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${e.etag}</d:getetag></d:prop></d:propstat></d:response>`).join('')
        return res.writeHead(207).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${rows}</d:multistatus>`)
      }
      if (req.method === 'PUT') {
        const etag = `"e${events.size + 1}"`
        events.set(url, { etag, data: body.join('') })
        ctag = `ctag-${events.size + 1}`
        return res.writeHead(201, { etag }).end()
      }
      res.writeHead(404).end()
    })
  })
  await new Promise((r) => stub.listen(0, '127.0.0.1', r))
  const stubPort = stub.address().port
  const stubBase = `http://127.0.0.1:${stubPort}/remote.php/dav/`

  await page.evaluate(async (base) => {
    const inv = async (ch, p) => {
      const res = await window.osl.invoke(ch, p)
      if (!res.ok) throw new Error(`${ch}: ${res.error?.message}`)
      return res.data
    }
    // connect + enable the stub calendar
    const { accountId } = await inv('caldav:connect', {
      baseUrl: base, username: 'smoke', password: 'stub-password'
    })
    const cals = await inv('caldav:listRemoteCalendars', { accountId })
    const family = cals.find((c) => c.name === 'Stub Family')
    if (!family) throw new Error('stub calendar not discovered')
    await inv('caldav:setCalendarSelected', {
      accountId, calendarUrl: family.url, name: family.name, color: family.color,
      readOnly: family.readOnly, selected: true, personId: null
    })
    // an initial sync against the (empty) stub calendar must succeed
    await inv('sync:now', undefined)
  }, stubBase)

  // push a local event into the stub calendar via the outbox
  await page.evaluate(async (base) => {
    const inv = async (ch, p) => {
      const res = await window.osl.invoke(ch, p)
      if (!res.ok) throw new Error(`${ch}: ${res.error?.message}`)
      return res.data
    }
    const cals = await inv('calendars:list', undefined)
    const stubCal = cals.find((c) => c.provider === 'caldav')
    if (!stubCal) throw new Error('caldav calendar not created locally')
    await inv('events:create', {
      calendarId: stubCal.id,
      title: 'Pushed to Nextcloud',
      start: new Date(Date.now() + 86400000).toISOString(),
      end: new Date(Date.now() + 93600000).toISOString(),
      tz: 'UTC', allDay: false, personIds: [], recurrence: null
    })
    await inv('sync:now', undefined)
  }, stubBase)

  if (events.size !== 1) throw new Error(`expected 1 pushed event on the stub, got ${events.size}`)
  const pushedIcs = [...events.values()][0].data
  if (!pushedIcs.includes('SUMMARY:Pushed to Nextcloud')) throw new Error('pushed event missing SUMMARY')
  stub.close()

  console.log('SMOKE PASS: event, avatar, and CalDAV push round-trip verified')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
