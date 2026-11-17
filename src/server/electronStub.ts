import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Server-mode stand-in for the `electron` module. The server bundle aliases
 * `electron` (and `electron-updater`) here so the exact same main-process
 * services run headless in plain Node: safeStorage reports "unavailable", which
 * makes every secret use the existing `plain:` fallback (protect the data dir
 * with filesystem permissions), protocol.handle registrations land in a map
 * the HTTP server exposes under /media/<scheme>/, and OS-only APIs no-op.
 */

export type ProtocolHandler = (request: Request) => Response | Promise<Response>

const protocolHandlers = new Map<string, ProtocolHandler>()

/** Used by the web server to serve /media/<scheme>/... for registered custom schemes. */
export function getProtocolHandler(scheme: string): ProtocolHandler | undefined {
  return protocolHandlers.get(scheme)
}

const FILE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

export const app = {
  getPath(name: string): string {
    if (name === 'userData') return process.env.OSL_USER_DATA ?? process.cwd()
    return process.cwd()
  },
  setPath(_name: string, _path: string): void {},
  getVersion(): string {
    return process.env.OSL_VERSION ?? '0.0.0-server'
  },
  isPackaged: false,
  setLoginItemSettings(_settings: unknown): void {},
  requestSingleInstanceLock(): boolean {
    return true
  },
  on(_event: string, _listener: unknown): void {},
  whenReady(): Promise<void> {
    return Promise.resolve()
  },
  quit(): void {}
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return false
  },
  encryptString(plain: string): Buffer {
    return Buffer.from(`plain:${plain}`, 'utf8')
  },
  decryptString(buf: Buffer): string {
    const s = buf.toString('utf8')
    if (!s.startsWith('plain:')) throw new Error('stub cannot decrypt non-plain blobs')
    return s.slice(6)
  }
}

export const net = {
  async fetch(url: string | URL): Promise<Response> {
    const u = url.toString()
    if (u.startsWith('file://')) {
      const data = await readFile(fileURLToPath(u))
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': FILE_MIME[extname(u).toLowerCase()] ?? 'application/octet-stream' }
      })
    }
    return fetch(u)
  }
}

export const protocol = {
  handle(scheme: string, handler: ProtocolHandler): void {
    protocolHandlers.set(scheme, handler)
  }
}

export const powerMonitor = {
  getSystemIdleTime(): number {
    return 0
  },
  on(_event: string, _listener: unknown): void {}
}

export const powerSaveBlocker = {
  start(_type: string): number {
    return 0
  },
  stop(_id: number): void {},
  isStarted(_id: number): boolean {
    return false
  }
}

export const dialog = {
  showOpenDialog(_options: unknown): Promise<{ canceled: boolean; filePaths: string[] }> {
    return Promise.resolve({ canceled: true, filePaths: [] })
  }
}

export const shell = {
  openExternal(url: string): Promise<void> {
    console.log(`[server] open this URL on any device to continue: ${url}`)
    return Promise.resolve()
  }
}

export const ipcMain = {
  handle(_channel: string, _listener: unknown): void {}
}

export const BrowserWindow = {
  getAllWindows(): unknown[] {
    return []
  }
}

export const contextBridge = {
  exposeInMainWorld(_key: string, _value: unknown): void {}
}

export const ipcRenderer = {
  invoke(_channel: string, _payload: unknown): Promise<never> {
    return Promise.reject(new Error('ipcRenderer is not available in server mode'))
  },
  on(_channel: string, _listener: unknown): void {},
  removeListener(_channel: string, _listener: unknown): void {}
}
