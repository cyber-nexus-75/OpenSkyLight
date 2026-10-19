// End-to-end smoke test: launch the built app with an isolated data dir,
// create an event through the real UI, and verify it appears in the week grid.
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
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

  console.log('SMOKE PASS: event created and visible in week view; avatar uploaded and rendered')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
