// Captures the README screenshot set: seeds a realistic family through the
// real IPC layer, then walks every major view. Output: docs/screenshots/*.png
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-readme-'))
const outDir = 'docs/screenshots'
mkdirSync(outDir, { recursive: true })

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  // consistent capture size regardless of the dev machine's display
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setContentSize(1600, 960)
    win.center()
  })
  await page.waitForSelector('[data-tile-type="todayEvents"]', { timeout: 15000 })

  // ---- seed a believable family through the real IPC layer ----------------
  await page.evaluate(async () => {
    const inv = async (ch, p) => {
      const res = await window.osl.invoke(ch, p)
      if (!res.ok) throw new Error(`${ch}: ${res.error?.message}`)
      return res.data
    }
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const dayIso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    const today = new Date()
    const todayIso = dayIso(today)
    // date offset by n days at h:m local
    const at = (dayOffset, h, m = 0) => {
      const d = new Date()
      d.setDate(d.getDate() + dayOffset)
      d.setHours(h, m, 0, 0)
      return d.toISOString()
    }

    const emma = await inv('people:create', { name: 'Emma', color: '#46A758', role: 'child' })
    const leo = await inv('people:create', { name: 'Leo', color: '#0091FF', role: 'child' })
    const mom = await inv('people:create', { name: 'Sam', color: '#E5484D', role: 'parent' })
    const dad = await inv('people:create', { name: 'Alex', color: '#8E4EC6', role: 'parent' })

    const cals = await inv('calendars:list', undefined)
    const family = cals[0].id
    const school = (await inv('calendars:create', { name: 'School', color: '#FFB224' })).id

    const mk = (cal, title, dayOffset, h, people, durH = 1, extra = {}) =>
      inv('events:create', {
        calendarId: cal, title, start: at(dayOffset, h), end: at(dayOffset, h + durH), tz: zone,
        allDay: false, personIds: people, recurrence: null, ...extra
      })
    // today
    await mk(family, 'Dentist — Leo', 0, 9, [leo.id])
    await mk(school, 'Soccer practice', 0, 16, [emma.id])
    await mk(family, 'Piano lesson', 0, 17, [leo.id])
    await mk(family, 'Family movie night', 0, 19, [emma.id, leo.id, mom.id, dad.id], 2)
    // rest of the week
    await mk(school, 'Science fair setup', 1, 15, [emma.id], 2)
    await mk(family, 'Swim class', 1, 17, [leo.id])
    await mk(family, 'Date night', 2, 19, [mom.id, dad.id], 3)
    await mk(school, 'Half day — early pickup', 2, 12, [emma.id, leo.id])
    await mk(family, 'Grandma visits', 3, 11, [emma.id, leo.id, mom.id, dad.id], 4)
    await mk(family, 'Birthday party (Ava)', 3, 14, [emma.id], 3)
    await mk(family, 'Farmers market', -1, 9, [mom.id], 2)
    await mk(school, 'Library books due', 1, 10, [leo.id])
    // a recurring one so the week shows repetition
    await inv('events:create', {
      calendarId: family, title: 'Morning run', start: at(0, 6, 30), end: at(0, 7), tz: zone,
      allDay: false, personIds: [dad.id], recurrence: { freq: 'daily' }
    })

    // chores with morning/evening routines + some already checked off
    const chore = (title, p, stars, routine) =>
      inv('chores:create', { title, personId: p, starsValue: stars, recurrence: { freq: 'daily' }, routine })
    const c1 = await chore('Make bed', emma.id, 1, 'morning')
    await chore('Brush teeth', emma.id, 1, 'morning')
    const c2 = await chore('Feed the dog', emma.id, 2, 'evening')
    const c3 = await chore('Make bed', leo.id, 1, 'morning')
    await chore('Set the table', leo.id, 2, 'evening')
    await chore('Take out trash', leo.id, 2, 'evening')
    await inv('chores:complete', { choreId: c1.id, date: todayIso })
    await inv('chores:complete', { choreId: c2.id, date: todayIso })
    await inv('chores:complete', { choreId: c3.id, date: todayIso })

    await inv('rewards:create', { title: 'Pick the movie', costStars: 10 })
    await inv('rewards:create', { title: 'Ice cream trip', costStars: 15 })
    await inv('rewards:create', { title: '30 min extra screen time', costStars: 8 })

    // lists
    const groceries = await inv('lists:create', { name: 'Groceries', color: '#46A758', kind: 'grocery' })
    for (const t of ['Milk', 'Eggs', 'Tortillas', 'Avocados', 'Cheddar', 'Apples', 'Coffee']) {
      await inv('listItems:add', { listId: groceries.id, text: t })
    }
    const gItems = (await inv('lists:getAll', undefined)).find((l) => l.id === groceries.id).items
    await inv('listItems:toggle', { id: gItems[0].id })
    await inv('listItems:toggle', { id: gItems[1].id })
    const todos = await inv('lists:create', { name: 'Weekend projects', color: '#0091FF', kind: 'todo' })
    for (const t of ['Fix the gate latch', 'Plant tomatoes', 'Clean the garage']) {
      await inv('listItems:add', { listId: todos.id, text: t })
    }

    // meals around today
    const meal = (off, slot, text) => {
      const d = new Date()
      d.setDate(d.getDate() + off)
      return inv('meals:set', { date: dayIso(d), slot, text })
    }
    await meal(0, 'breakfast', 'Pancakes')
    await meal(0, 'dinner', 'Taco night')
    await meal(1, 'dinner', 'Sheet-pan salmon')
    await meal(2, 'dinner', 'Pizza Friday')
    await meal(-1, 'dinner', 'Spaghetti')

    // avatars so the shots show real photos (solid-color circles generated on canvas)
    const avatar = (person, hex) => {
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = hex
      ctx.beginPath()
      ctx.arc(128, 128, 128, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 96px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(person.name[0], 128, 132)
      return canvas.toDataURL('image/png').split(',')[1]
    }
    await inv('people:setAvatar', { personId: emma.id, data: avatar(emma, '#46A758') })
    await inv('people:setAvatar', { personId: leo.id, data: avatar(leo, '#0091FF') })
    await inv('people:setAvatar', { personId: mom.id, data: avatar(mom, '#E5484D') })
    await inv('people:setAvatar', { personId: dad.id, data: avatar(dad, '#8E4EC6') })
    // weather location (live Open-Meteo fetch) — and 12h clock for the shots
    await inv('settings:set', { patch: { weather: { lat: 39.7392, lon: -104.9903, label: 'Denver' } } })
  })

  // seeding bypassed React Query — reload to refetch, let weather/news settle
  await page.reload()
  await page.waitForSelector('[data-tile-type="todayEvents"]', { timeout: 15000 })
  await page.waitForTimeout(3000)

  const shot = (name) => page.screenshot({ path: join(outDir, name) })
  const go = async (tab) => {
    await page.getByRole('button', { name: tab, exact: true }).click()
    await page.waitForTimeout(900)
  }

  // 1. home (the hero)
  await shot('home.png')

  // 2. week view
  await go('Week')
  await shot('week.png')

  // 3. event editor over the week view
  await page.locator('text=Family movie night').first().click()
  await page.waitForTimeout(800)
  await shot('editor.png')
  await page.reload() // dismiss the sheet; boots back to home
  await page.waitForSelector('[data-tile-type="todayEvents"]', { timeout: 15000 })

  // 4-6. month, chores, lists
  await go('Month')
  await shot('month.png')
  await go('Chores')
  await shot('chores.png')
  await go('Lists')
  await shot('lists.png')

  // 7. dark mode home, with a news tile swapped in for the star balances
  await page.evaluate(async () => {
    const settings = (await window.osl.invoke('settings:getAll', undefined)).data
    const layout = settings.homeLayout.map((t) =>
      t.id === 'default-starBalances'
        ? { id: 'shot-news', type: 'news', x: t.x, y: t.y, w: t.w, h: t.h, config: { feedId: 'npr' } }
        : t
    )
    await window.osl.invoke('settings:set', { patch: { theme: 'dark', homeLayout: layout } })
  })
  await go('Home')
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 5000 })
  await page.waitForTimeout(3500) // bg transition + live NPR fetch
  await shot('home-dark.png')

  console.log('README screenshots written to', outDir)
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
