import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DateTime } from 'luxon'
import { openDatabase } from '../main/db/client'
import { createSettingsService } from '../main/services/settingsService'
import { createPeopleService } from '../main/services/peopleService'
import { createAvatarService } from '../main/services/avatarService'
import { createCalendarService } from '../main/services/calendarService'
import { createEventService } from '../main/services/eventService'
import { buildChannelTable, dispatch, type Services } from '../main/ipc/router'
import { broadcast } from '../main/ipc/bus'
import { createCompanionTokens } from '../main/companion/companionTokens'
import { createCompanionServer } from '../main/companion/companionServer'
import { pickLanAddresses } from '../main/companion/lanAddress'
import { createWeatherService } from '../main/services/weatherService'
import { createAuthService } from '../main/services/authService'
import { createChoresService } from '../main/services/choresService'
import { createRewardsService } from '../main/services/rewardsService'
import { createListsService } from '../main/services/listsService'
import { createMealsService } from '../main/services/mealsService'
import { createKiosk } from '../main/kiosk/kiosk'
import { createUpdater } from '../main/updater'
import { createRssService } from '../main/services/rssService'
import { createCameraService } from '../main/services/cameraService'
import { createUnifiService, decryptSecret, fetchSnapshot } from '../main/services/unifiService'
import { createWebdavService } from '../main/services/webdavService'
import { createAiService } from '../main/services/aiService'
import { createDoorbellService } from '../main/services/doorbellService'
import { createBackupService } from '../main/services/backupService'
import { createAiScanService } from '../main/services/aiScanService'
import { createRecipeService } from '../main/services/recipeService'
import { createGroceriesService } from '../main/services/groceriesService'
import { createReceiptService } from '../main/services/receiptService'
import { AppError } from '../main/services/errors'
import { createBirdNetService } from '../main/services/birdnetService'
import { createGoogleAuth, type GoogleAuthHooks } from '../main/sync/googleAuth'
import { createGoogleSync } from '../main/sync/googleSync'
import { createCalDavAuth } from '../main/sync/caldavAuth'
import { createCalDavSync } from '../main/sync/caldavSync'
import { createOutboxWorker } from '../main/sync/outboxWorker'
import { createIcsSync } from '../main/sync/icsSync'
import { createSyncManager } from '../main/sync/scheduler'
import { createWebServer } from './webServer'
import { getProtocolHandler } from './electronStub'

/**
 * OpenSkyLight server mode: the whole app (database, sync, services) runs
 * headless on a server and any device on the network opens the web app in a
 * browser — no Electron, no local install on the display device.
 *
 *   node out/server/index.js            # after npm run build
 *
 * Env: OSL_DATA_DIR (default ./data), OSL_PORT (8080), OSL_HOST (0.0.0.0),
 *      OSL_SERVER_TOKEN (optional LAN access token), OSL_PUBLIC_URL
 *      (optional externally reachable base URL, used for the OAuth redirect).
 */

function readPkgVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0-server'
  } catch {
    return '0.0.0-server'
  }
}

const dataDir = resolve(process.env.OSL_DATA_DIR ?? join(process.cwd(), 'data'))
const version = process.env.OSL_VERSION ?? readPkgVersion()
process.env.OSL_USER_DATA = dataDir
process.env.OSL_VERSION = version
mkdirSync(dataDir, { recursive: true })

const port = Number(process.env.OSL_PORT ?? 8080)
const host = process.env.OSL_HOST ?? '0.0.0.0'
const token = process.env.OSL_SERVER_TOKEN?.trim() || undefined
const publicBaseUrl =
  process.env.OSL_PUBLIC_URL?.trim() || `http://${pickLanAddresses()[0] ?? 'localhost'}:${port}`

const { db, sqlite } = openDatabase(join(dataDir, 'openskylight.db'))
const deviceTz = (): string => DateTime.local().zoneName ?? 'UTC'

const settings = createSettingsService(db)
const backupService = createBackupService({
  sqlite,
  getAllSettings: () => settings.getAll() as unknown as Record<string, unknown>,
  getRaw: (key) => settings.getRaw(key),
  setRaw: (key, value) => settings.setRaw(key, value)
})
const avatars = createAvatarService({ rootDir: dataDir })
const webdavService = createWebdavService({
  settings,
  cacheDir: join(dataDir, 'screensaver-cache')
})
const aiService = createAiService({ settings })
const aiScanService = createAiScanService({
  settings,
  ai: aiService,
  webdav: webdavService,
  onDrafts: (drafts, source) => {
    const raw = settings.getRaw('aiScan.pending') ?? '[]'
    try {
      const pending = JSON.parse(raw) as { drafts: unknown[]; source: string }[]
      pending.push({ drafts, source })
      settings.setRaw('aiScan.pending', JSON.stringify(pending.slice(-20)))
    } catch {
      settings.setRaw('aiScan.pending', JSON.stringify([{ drafts, source }]))
    }
    broadcast('push:aiDrafts', { count: drafts.length, source })
  }
})
const doorbellService = createDoorbellService({
  settings,
  port: () => companion.boundPort() ?? settings.getAll().companion.port
})
const groceriesService = createGroceriesService(db)
const receiptService = createReceiptService({ rootDir: dataDir, db })
const kiosk = createKiosk({
  settings,
  broadcast,
  avatars,
  webdavCacheDir: join(dataDir, 'screensaver-cache')
})
const updater = createUpdater({ broadcast })
const cameraService = createCameraService(settings, { noServer: true, pathPrefix: '/camera-ws' })
const unifiService = createUnifiService({
  settings,
  addCamera: (name, url) => cameraService.add(name, url).id
})
const choresService = createChoresService(db, deviceTz)

let oauthCallback: ((q: { code: string | null; error: string | null; state: string | null }) => boolean) | null =
  null
const googleHooks: GoogleAuthHooks = {
  publicBaseUrl,
  onAuthUrl: (url) => broadcast('push:googleAuthUrl', { url }),
  registerCallback: (handler) => {
    oauthCallback = handler
  }
}
const googleAuth = createGoogleAuth(db, settings, googleHooks)
const googleSync = createGoogleSync({ db, auth: googleAuth, deviceTz })
const caldavAuth = createCalDavAuth({ db, settings })
const caldavSync = createCalDavSync({ db, auth: caldavAuth, deviceTz })
const outbox = createOutboxWorker({
  db,
  sync: googleSync,
  caldav: caldavSync,
  onConflict: (title) => broadcast('push:syncConflict', { title })
})
const icsSync = createIcsSync({ db, deviceTz })
const syncManager = createSyncManager({
  db,
  auth: googleAuth,
  google: googleSync,
  caldav: caldavSync,
  webdav: webdavService,
  backup: {
    autoBackup: () =>
      backupService.autoBackup((fileName, bytes) => webdavService.uploadFile(fileName, bytes))
  },
  aiScan: { scanNow: () => aiScanService.scanNow() },
  outbox,
  ics: icsSync,
  settings,
  broadcast
})

let channelTable: ReturnType<typeof buildChannelTable>
const companion = createCompanionServer({
  settings,
  tokens: createCompanionTokens(settings),
  dispatch: (channel, payload) => dispatch(services, channelTable, channel, payload, { gate: 'none' }),
  version,
  staticRoot: join(__dirname, '../companion'),
  avatarBytes: (personId) => avatars.get(personId),
  uploadPhoto: (fileName, bytes) => webdavService.upload(fileName, bytes),
  scanReceipt: (bytes) => receiptService.scan(bytes),
  setAvatar: async (personId, bytes) => {
    const result = await dispatch(services, channelTable, 'people:setAvatar', { personId, data: bytes.toString('base64') }, { gate: 'none' })
    if (!result.ok) throw new AppError(result.error.code, result.error.message)
  },
  acceptDoorbellRing: (token) => doorbellService.acceptRing(token),
  verifyDoorbellToken: (token) => doorbellService.verifyToken(token),
  onDoorbellRing: () => {
    broadcast('push:doorbellRing', { at: new Date().toISOString() })
    const unifiId = doorbellService.unifiCameraId()
    const unifiHost = settings.getRaw('unifi.host')
    const unifiKeyEnc = settings.getRaw('unifi.apiKeyEnc')
    if (unifiId && unifiHost && unifiKeyEnc) {
      void (async () => {
        try {
          const apiKey = decryptSecret(unifiKeyEnc)
          const bytes = await fetchSnapshot(unifiHost, apiKey, unifiId)
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          await webdavService.uploadFile(`visitor-${stamp}.jpg`, bytes, { subfolder: 'doorbell' })
        } catch {
          // snapshot is a bonus, never a failure of the ring itself
        }
      })()
    }
  }
})

const services: Services = {
  settings,
  people: createPeopleService(db),
  avatars,
  calendars: createCalendarService(db),
  events: createEventService(db),
  googleAuth,
  googleSync,
  caldavAuth,
  caldavSync,
  icsSync,
  syncManager,
  weather: createWeatherService(settings),
  auth: createAuthService(settings),
  chores: choresService,
  rewards: createRewardsService(db, choresService),
  lists: createListsService(db),
  meals: createMealsService(db),
  recipeLibrary: createRecipeService(db),
  kiosk,
  updater,
  rss: createRssService(),
  camera: cameraService,
  unifi: unifiService,
  webdav: webdavService,
  ai: aiService,
  doorbell: doorbellService,
  backup: backupService,
  birdnet: createBirdNetService(),
  companion,
  groceries: groceriesService,
  receipts: receiptService
}
channelTable = buildChannelTable(services, version)

const server = createWebServer({
  version,
  staticRoot: join(__dirname, '../renderer'),
  dispatch: (channel, payload) => dispatch(services, channelTable, channel, payload, { gate: 'pin' }),
  protocolHandler: getProtocolHandler,
  handleUpgrade: (req, socket, head) => cameraService.handleUpgrade(req, socket, head),
  oauthCallback: (q) => (oauthCallback ? oauthCallback(q) : false),
  token,
  onListen: (bound) => {
    const lan = pickLanAddresses().map((ip) => `http://${ip}:${bound}/`)
    console.log(`[server] OpenSkyLight web app listening on ${host}:${bound}`)
    for (const u of lan) console.log(`[server] open on a device: ${u}${token ? ' (then /api/login?t=<OSL_SERVER_TOKEN>)' : ''}`)
    if (token) console.log('[server] LAN token auth is ON (OSL_SERVER_TOKEN)')
  }
})

async function main(): Promise<void> {
  await server.listen(port, host)
  syncManager.start()
  kiosk.start()
  updater.start()
  companion.applySettings()
}

function shutdown(): void {
  cameraService.shutdown()
  companion.shutdown()
  server.close()
  syncManager.stop()
  kiosk.stop()
}

process.on('SIGTERM', () => {
  shutdown()
  process.exit(0)
})
process.on('SIGINT', () => {
  shutdown()
  process.exit(0)
})

main().catch((err) => {
  console.error('[server] failed to start:', err)
  process.exit(1)
})
