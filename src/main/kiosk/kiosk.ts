import { app, dialog, net, powerMonitor, powerSaveBlocker, protocol } from 'electron'
import { readdirSync, existsSync } from 'node:fs'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DateTime } from 'luxon'
import type { SettingsService } from '../services/settingsService'
import type { AvatarService } from '../services/avatarService'
import { isInSleepWindow } from '@shared/sleepWindow'
import { resolvePhotoInDir, PHOTO_EXTENSIONS } from './photoGuard'

const IDLE_POLL_MS = 5_000
const SLEEP_POLL_MS = 5_000

export function createKiosk(deps: {
  settings: SettingsService
  broadcast: (ch: string, p: unknown) => void
  avatars: Pick<AvatarService, 'get'>
  /** WebDAV pull cache dir, preferred over the local folder when it has photos */
  webdavCacheDir: string | null
}) {
  const { settings, broadcast, avatars, webdavCacheDir } = deps
  let idleTimer: NodeJS.Timeout | null = null
  let sleepTimer: NodeJS.Timeout | null = null
  let screensaverOn = false
  let sleeping = false
  let blockerId: number | null = null

  /** Photos are served through osl-photo:// so the sandboxed renderer never touches the filesystem. */
  function registerPhotoProtocol(): void {
    protocol.handle('osl-photo', (request) => {
      const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
      const cache = webdavCacheDir
      if (cache) {
        const cachedFull = resolvePhotoInDir(cache, name)
        if (cachedFull && existsSync(cachedFull)) {
          return net.fetch(pathToFileURL(cachedFull).toString())
        }
      }
      const folder = settings.getAll().screensaver.folder
      if (!folder) return new Response('no folder', { status: 404 })
      const full = resolvePhotoInDir(folder, name)
      if (!full) return new Response('forbidden', { status: 403 })
      return net.fetch(pathToFileURL(full).toString())
    })
  }

  /** Avatars are served through osl-avatar:// so the sandboxed renderer never touches the filesystem. */
  function registerAvatarProtocol(): void {
    protocol.handle('osl-avatar', (request) => {
      const personId = new URL(request.url).hostname
      const bytes = avatars.get(personId)
      if (!bytes) return new Response('no avatar', { status: 404 })
      return new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }
      })
    })
  }

  /**
   * Bird photos are proxied through osl-bird:// so the sandboxed renderer never
   * makes a cross-origin request to the (parent-configured) BirdNET-Go host.
   * Only the fixed /media/image/ path is ever fetched.
   */
  function registerBirdImageProtocol(): void {
    protocol.handle('osl-bird', (request) => {
      const url = new URL(request.url)
      const base = url.searchParams.get('base') ?? ''
      const sci = url.searchParams.get('sci') ?? ''
      if (!/^https?:\/\//i.test(base) || sci === '') return new Response('bad request', { status: 400 })
      return net.fetch(`${base}/media/image/${encodeURIComponent(sci)}`)
    })
  }

  /** Photos come from the WebDAV pull cache when it has any; else the local folder. */
  function listPhotos(): string[] {
    const listed = (dir: string): string[] => {
      try {
        return readdirSync(dir)
          .filter((f) => PHOTO_EXTENSIONS.has(extname(f).toLowerCase()))
          .sort()
          .map((f) => `osl-photo://photos/${encodeURIComponent(f)}`)
      } catch {
        return []
      }
    }
    if (webdavCacheDir) {
      const cached = listed(webdavCacheDir)
      if (cached.length > 0) return cached
    }
    const folder = settings.getAll().screensaver.folder
    if (!folder) return []
    return listed(folder)
  }

  async function pickFolder(): Promise<{ folder: string | null }> {
    const result = await dialog.showOpenDialog({
      title: 'Choose a photo folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { folder: settings.getAll().screensaver.folder }
    const folder = result.filePaths[0]
    settings.set({ screensaver: { ...settings.getAll().screensaver, folder } })
    return { folder }
  }

  function setScreensaver(on: boolean): void {
    if (screensaverOn === on) return
    screensaverOn = on
    broadcast('push:kioskIdle', { state: on ? 'screensaver' : 'active' })
  }

  function setSleeping(on: boolean): void {
    if (sleeping === on) return
    sleeping = on
    broadcast('push:sleepState', { sleeping: on })
    // while awake, keep the display alive; while asleep, let the OS power it down
    if (on) {
      if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
      blockerId = null
    } else if (blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-display-sleep')
    }
  }

  /** Used by the settings "Preview" button. */
  function previewScreensaver(): void {
    broadcast('push:kioskIdle', { state: 'screensaver' })
  }

  function start(): void {
    registerPhotoProtocol()
    registerAvatarProtocol()
    registerBirdImageProtocol()
    blockerId = powerSaveBlocker.start('prevent-display-sleep')

    idleTimer = setInterval(() => {
      const s = settings.getAll().screensaver
      const idleSeconds = powerMonitor.getSystemIdleTime()
      setScreensaver(s.folder !== null && idleSeconds >= s.idleMinutes * 60)
    }, IDLE_POLL_MS)

    sleepTimer = setInterval(() => {
      const s = settings.getAll().sleep
      if (!s.enabled) {
        setSleeping(false)
        return
      }
      const now = DateTime.now()
      setSleeping(isInSleepWindow(now.hour * 60 + now.minute, s.start, s.end))
    }, SLEEP_POLL_MS)
  }

  function stop(): void {
    if (idleTimer) clearInterval(idleTimer)
    if (sleepTimer) clearInterval(sleepTimer)
  }

  function setLaunchOnStartup(enabled: boolean): void {
    if (!app.isPackaged) return // pointless (and confusing) for dev runs
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
  }

  return { start, stop, listPhotos, pickFolder, previewScreensaver, setLaunchOnStartup }
}

export type Kiosk = ReturnType<typeof createKiosk>
