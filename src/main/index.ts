import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { DateTime } from 'luxon'
import { openDatabase } from './db/client'
import { createSettingsService } from './services/settingsService'
import { createPeopleService } from './services/peopleService'
import { createAvatarService } from './services/avatarService'
import { createCalendarService } from './services/calendarService'
import { createEventService } from './services/eventService'
import {
  buildChannelTable,
  dispatch,
  registerIpcHandlers,
  broadcast,
  type ChannelTable,
  type Services
} from './ipc/router'
import { createCompanionTokens } from './companion/companionTokens'
import { createCompanionServer } from './companion/companionServer'
import { createMainWindow } from './window'
import { createWeatherService } from './services/weatherService'
import { createAuthService } from './services/authService'
import { createChoresService } from './services/choresService'
import { createRewardsService } from './services/rewardsService'
import { createListsService } from './services/listsService'
import { createMealsService } from './services/mealsService'
import { createKiosk } from './kiosk/kiosk'
import { createUpdater } from './updater'
import { createRssService } from './services/rssService'
import { createCameraService } from './services/cameraService'
import { createUnifiService } from './services/unifiService'
import { createWebdavService } from './services/webdavService'
import { createAiService } from './services/aiService'
import { createDoorbellService } from './services/doorbellService'
import { createBirdNetService } from './services/birdnetService'
import { createGoogleAuth } from './sync/googleAuth'
import { createGoogleSync } from './sync/googleSync'
import { createCalDavAuth } from './sync/caldavAuth'
import { createCalDavSync } from './sync/caldavSync'
import { createOutboxWorker } from './sync/outboxWorker'
import { createIcsSync } from './sync/icsSync'
import { createSyncManager } from './sync/scheduler'

// Test harnesses point this at a temp dir so smoke runs never touch real data
if (process.env.OSL_USER_DATA) {
  app.setPath('userData', process.env.OSL_USER_DATA)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    const { db } = openDatabase(join(app.getPath('userData'), 'openskylight.db'))
    const deviceTz = (): string => DateTime.local().zoneName ?? 'UTC'

    const settings = createSettingsService(db)
    const avatars = createAvatarService({ rootDir: app.getPath('userData') })
    const webdavService = createWebdavService({
      settings,
      cacheDir: join(app.getPath('userData'), 'screensaver-cache')
    })
    const aiService = createAiService({ settings })
    const doorbellService = createDoorbellService({
      settings,
      port: () => companion.boundPort() ?? settings.getAll().companion.port
    })
    const kiosk = createKiosk({
      settings,
      broadcast,
      avatars,
      webdavCacheDir: join(app.getPath('userData'), 'screensaver-cache')
    })
    const updater = createUpdater({ broadcast })
    const cameraService = createCameraService(settings)
    const unifiService = createUnifiService({
      settings,
      addCamera: (name, url) => cameraService.add(name, url).id
    })
    app.on('will-quit', () => cameraService.shutdown())
    const choresService = createChoresService(db, deviceTz)
    const googleAuth = createGoogleAuth(db, settings)
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
      outbox,
      ics: icsSync,
      settings,
      broadcast
    })

    // companion dispatches through the same channel table built below; the
    // closure resolves after boot, before any HTTP request can arrive
    let channelTable: ChannelTable
    const companion = createCompanionServer({
      settings,
      tokens: createCompanionTokens(settings),
      dispatch: (channel, payload) => dispatch(services, channelTable, channel, payload, { gate: 'none' }),
      version: app.getVersion(),
      staticRoot: join(__dirname, '../companion'),
      avatarBytes: (personId) => avatars.get(personId),
      uploadPhoto: (fileName, bytes) => webdavService.upload(fileName, bytes),
      acceptDoorbellRing: (token) => doorbellService.acceptRing(token),
      verifyDoorbellToken: (token) => doorbellService.verifyToken(token),
      onDoorbellRing: () => broadcast('push:doorbellRing', { at: new Date().toISOString() })
    })
    app.on('will-quit', () => companion.shutdown())

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
      kiosk,
      updater,
      rss: createRssService(),
      camera: cameraService,
      unifi: unifiService,
      webdav: webdavService,
      ai: aiService,
      doorbell: doorbellService,
      birdnet: createBirdNetService(),
      companion
    }
    channelTable = buildChannelTable(services)
    registerIpcHandlers(services, channelTable)
    createMainWindow()
    syncManager.start()
    kiosk.start()
    updater.start()
    companion.applySettings()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  // A wall display should restart its UI if the renderer ever crashes
  app.on('render-process-gone', (_event, _webContents, details) => {
    console.error('[main] renderer gone:', details.reason)
    if (details.reason !== 'clean-exit') {
      for (const win of BrowserWindow.getAllWindows()) win.destroy()
      createMainWindow()
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
