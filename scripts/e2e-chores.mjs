// E2E: full chores + rewards loop through the real UI —
// add a child, create a chore and a reward, check the chore off on the board,
// redeem the reward, and grant it as a parent.
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-chores-'))
mkdirSync('shots', { recursive: true })

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await page.waitForSelector('text=Week', { timeout: 15000 })

  // 1. add a child
  await page.getByLabel('Settings').click()
  await page.getByRole('button', { name: 'Add family member', exact: true }).click()
  await page.getByPlaceholder('Name').fill('Emma')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const sheet = () => page.locator('.animate-sheet-up')

  // 2. create a chore worth 2 stars
  await sheet().getByRole('button', { name: 'Chores', exact: true }).click()
  await page.getByRole('button', { name: 'Add chore' }).click()
  await page.getByPlaceholder('e.g. Make your bed').fill('Make bed')
  await page.getByRole('button', { name: '+', exact: true }).click() // stars 1 -> 2
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // 3. create a reward costing 2 stars
  await page.getByRole('button', { name: 'Add reward' }).click()
  await page.getByPlaceholder('e.g. Movie night pick').fill('Ice cream')
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: '−', exact: true }).click() // 10 -> 2
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByLabel('Close').click()

  // 4. chores board: check the chore off
  await page.getByRole('button', { name: 'Chores', exact: true }).click()
  await page.waitForSelector('text=Make bed', { timeout: 5000 })
  await page.getByRole('button', { name: /Make bed/ }).click()
  await page.waitForSelector('text=1/1 done', { timeout: 5000 })

  // 5. redeem the reward
  await page.getByRole('button', { name: '★ Rewards' }).click()
  await page.waitForSelector('text=★ 2', { timeout: 5000 })
  await page.getByRole('button', { name: 'Redeem', exact: true }).click()
  await page.waitForSelector('text=ask a parent', { timeout: 5000 })
  await page.screenshot({ path: 'shots/chores.png' })
  await page.keyboard.press('Escape').catch(() => {})
  await page.mouse.click(40, 300) // dismiss dialog via backdrop

  // 6. grant it in settings
  await page.getByLabel('Settings').click()
  await sheet().getByRole('button', { name: 'Chores', exact: true }).click()
  await page.waitForSelector('text=Waiting for approval', { timeout: 5000 })
  await page.getByRole('button', { name: 'Grant', exact: true }).click()
  await page.waitForSelector('text=Waiting for approval', { state: 'detached', timeout: 5000 })

  // 7. M7: up-for-grabs claim, linked chores, repeat-after, tasks view — via the real IPC layer
  const m7 = await page.evaluate(async () => {
    const inv = async (ch, p) => {
      const res = await window.osl.invoke(ch, p)
      if (!res.ok) throw new Error(`${ch}: ${res.error?.message}`)
      return res.data
    }
    const people = await inv('people:list', undefined)
    const emma = people.find((p) => p.name === 'Emma')
    if (!emma) throw new Error('Emma not found')
    const today = new Date().toISOString().slice(0, 10)

    // up-for-grabs chore: claim pays the claimer
    const grab = await inv('chores:create', {
      title: 'Walk the dog', personId: null, starsValue: 4,
      recurrence: { freq: 'daily' }, upForGrabs: true, anchorDate: today
    })
    const day0 = await inv('chores:getDay', { date: today })
    const grabRow = day0.find((c) => c.choreId === grab.id)
    if (!grabRow?.upForGrabs || grabRow.completed) throw new Error('up-for-grabs row missing on day board')
    await inv('chores:complete', { choreId: grab.id, date: today, personId: emma.id })
    const day1 = await inv('chores:getDay', { date: today })
    if (day1.find((c) => c.choreId === grab.id)?.claimerId !== emma.id) throw new Error('claimer not recorded')

    // linked chores complete together
    const a = await inv('chores:create', { title: 'Pack lunch', personId: emma.id, starsValue: 2, recurrence: { freq: 'daily' } })
    await inv('chores:create', { title: 'Pack bag', personId: emma.id, starsValue: 3, recurrence: { freq: 'daily' }, linkedChoreIds: [a.id] })
    await inv('chores:complete', { choreId: a.id, date: today })
    const day2 = await inv('chores:getDay', { date: today })
    const linked = day2.find((c) => c.title === 'Pack bag')
    if (!linked?.completed) throw new Error('linked chore did not complete with its pair')

    // repeat-after-completion one-off is due tomorrow too
    const rep = await inv('chores:create', { title: 'Wipe counter', personId: emma.id, starsValue: 1, recurrence: null, repeatAfter: true, anchorDate: today })
    await inv('chores:complete', { choreId: rep.id, date: today })
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
    const dayT = await inv('chores:getDay', { date: tomorrow })
    if (!dayT.some((c) => c.choreId === rep.id && !c.completed)) throw new Error('repeat-after chore not back tomorrow')

    // tasks view exposes due/overdue state
    const tasks = await inv('chores:getTasks', { date: today })
    if (!tasks.some((t) => t.choreId === grab.id && t.completedToday)) throw new Error('tasks view missing claimed chore')
    return true
  })
  if (!m7) throw new Error('M7 IPC flow failed')

  // 8. M7: tasks tab renders the search + up-for-grabs section through the real UI
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.waitForSelector('text=Up for grabs', { timeout: 5000 })
  await page.getByPlaceholder('Search tasks…').fill('walk')
  await page.waitForSelector('text=Walk the dog', { timeout: 5000 })
  await page.screenshot({ path: 'shots/chores-tasks.png' })

  console.log('CHORES E2E PASS: chore checked, stars awarded, reward redeemed and granted, M7 grabs/links/repeat/tasks verified')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
