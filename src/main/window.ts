import { BrowserWindow, shell } from 'electron'
import { join } from 'path'

export function createMainWindow(): BrowserWindow {
  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  // Dev runs windowed by default; production runs kiosk fullscreen.
  // Override with --kiosk (force kiosk in dev) or --windowed (force windowed in prod).
  const windowed = process.argv.includes('--windowed') || (isDev && !process.argv.includes('--kiosk'))

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    fullscreen: !windowed,
    kiosk: !windowed,
    autoHideMenuBar: true,
    backgroundColor: '#F7F3EC',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())
  // Pinch-zoom on a touchscreen must not scale the kiosk UI
  win.webContents.setVisualZoomLevelLimits(1, 1)
  // The groceries view uses the camera for receipt photos — allow 'media' only
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  // Any external link goes to the system browser, never inside the kiosk
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
