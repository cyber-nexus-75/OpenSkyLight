import { request, type RequestOptions } from 'node:https'
import { safeStorage } from 'electron'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SettingsService } from './settingsService'
import { AppError, invalid, notFound } from './errors'

const KEY_HOST = 'unifi.host'
const KEY_API_KEY_ENC = 'unifi.apiKeyEnc'
const KEY_IMPORTS = 'unifi.imports.v1' // unifi camera id -> local camera id

export interface UnifiDiscoveredCamera {
  id: string
  name: string
  model: string
  online: boolean
  /** already imported into the kiosk camera store */
  imported: boolean
}

export type UnifiFetchJson = (host: string, apiKey: string, path: string) => Promise<unknown>

/** UniFi OS consoles ship self-signed certificates; pin nothing, trust nothing, but connect. */
export function httpsGetJson(
  host: string,
  apiKey: string,
  path: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = {
      hostname: host,
      port: 443,
      path,
      method: 'GET',
      headers: { Accept: 'application/json', 'X-API-Key': apiKey },
      rejectUnauthorized: false, // self-signed console cert
      timeout: 10_000
    }
    const req = request(opts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new AppError('UNIFI_AUTH', 'Invalid UniFi API key'))
          return
        }
        if (res.statusCode !== 200) {
          reject(new AppError('UNIFI_ERROR', `UniFi console returned HTTP ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(new AppError('UNIFI_ERROR', 'UniFi console returned invalid JSON'))
        }
      })
    })
    req.on('timeout', () => {
      req.destroy(new AppError('UNIFI_ERROR', 'UniFi console timed out — check the host address'))
    })
    req.on('error', (err) => {
      if (err instanceof AppError) reject(err)
      else reject(new AppError('UNIFI_ERROR', `Cannot reach the UniFi console: ${err.message}`))
    })
    req.end()
  })
}

function encryptSecret(plain: string): string {
  const available = (() => {
    try {
      return safeStorage?.isEncryptionAvailable() ?? false
    } catch {
      return false // outside Electron (unit tests): plain fallback, same as camera service in dev
    }
  })()
  const buf = available ? safeStorage.encryptString(plain) : Buffer.from(`plain:${plain}`, 'utf8')
  return buf.toString('base64')
}

export function decryptSecret(b64: string): string {
  const buf = Buffer.from(b64, 'base64')
  const asString = buf.toString('utf8')
  if (asString.startsWith('plain:')) return asString.slice(6)
  return safeStorage.decryptString(buf)
}

interface RawProtectCamera {
  id?: string
  name?: string
  modelKey?: string
  type?: string
  isOnline?: boolean
  rtspUrl?: string
  rtspsUrl?: string
}

/** Fetch the camera's current snapshot as JPEG bytes (integration API). */
export async function fetchSnapshot(
  host: string,
  apiKey: string,
  unifiCameraId: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: host.split(':')[0],
        port: host.includes(':') ? Number(host.split(':')[1]) : 443,
        path: `/proxy/protect/integration/v1/cameras/${encodeURIComponent(unifiCameraId)}/snapshot`,
        method: 'GET',
        headers: { Accept: 'image/jpeg', 'X-API-Key': apiKey },
        rejectUnauthorized: false,
        timeout: 10_000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new AppError('UNIFI_ERROR', `Snapshot failed: HTTP ${res.statusCode}`))
            return
          }
          resolve(Buffer.concat(chunks))
        })
      }
    )
    req.on('timeout', () => req.destroy(new AppError('UNIFI_ERROR', 'Snapshot timed out')))
    req.on('error', (err) => reject(err instanceof AppError ? err : new AppError('UNIFI_ERROR', err.message)))
    req.end()
  })
}

export function createUnifiService(deps: {
  settings: SettingsService
  /** add a camera to the shared store; returns the local camera id */
  addCamera: (name: string, rtspUrl: string) => string
  /** transport override for tests; defaults to the console HTTPS client */
  fetchJson?: UnifiFetchJson
}) {
  const { settings, addCamera } = deps
  const fetchJson = deps.fetchJson ?? httpsGetJson

  function getStatus(): { configured: boolean; host: string | null } {
    const host = settings.getRaw(KEY_HOST)
    const key = settings.getRaw(KEY_API_KEY_ENC)
    return { configured: host !== null && key !== null, host }
  }

  /** Verify the key by listing cameras; store credentials only if it works. */
  async function connect(input: { host: string; apiKey: string }): Promise<{ host: string }> {
    const host = input.host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    // hostname, hostname:port, [IPv6 literal], or [IPv6]:port
    if (!/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d+)?$/.test(host)) {
      throw invalid('Enter the console host (e.g. 192.168.1.1 or [fd00::1])')
    }
    const raw = await fetchJson(host, input.apiKey.trim(), '/proxy/protect/integration/v1/cameras')
    const list = Array.isArray(raw) ? raw : ((raw as { cameras?: RawProtectCamera[] }).cameras ?? [])
    if (!Array.isArray(list)) throw invalid('Unexpected response from the UniFi console')
    settings.setRaw(KEY_HOST, host)
    settings.setRaw(KEY_API_KEY_ENC, encryptSecret(input.apiKey.trim()))
    return { host }
  }

  function disconnect(): void {
    settings.deleteRaw(KEY_HOST)
    settings.deleteRaw(KEY_API_KEY_ENC)
    settings.deleteRaw(KEY_IMPORTS)
  }

  async function listCamerasOn(host: string, apiKey: string): Promise<RawProtectCamera[]> {
    const data = (await fetchJson(host, apiKey, '/proxy/protect/integration/v1/cameras')) as
      | RawProtectCamera[]
      | { cameras?: RawProtectCamera[] }
    const list = Array.isArray(data) ? data : (data.cameras ?? [])
    return list.filter((c) => typeof c.id === 'string' && (c.rtspsUrl || c.rtspUrl))
  }

  /** Discover cameras; imported flag reflects the local import map. */
  async function listCameras(): Promise<UnifiDiscoveredCamera[]> {
    const host = settings.getRaw(KEY_HOST)
    const key = settings.getRaw(KEY_API_KEY_ENC)
    if (!host || !key) throw notFound('UniFi Protect account')
    const imports = loadImports()
    const raw = await listCamerasOn(host, decryptSecret(key))
    return raw.map((c) => ({
      id: c.id!,
      name: c.name || 'Unnamed camera',
      model: c.modelKey || c.type || 'camera',
      online: c.isOnline ?? true,
      imported: imports.has(c.id!)
    }))
  }

  function loadImports(): Map<string, string> {
    try {
      const raw = settings.getRaw(KEY_IMPORTS)
      const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {}
      return new Map(Object.entries(parsed))
    } catch {
      return new Map()
    }
  }

  function saveImports(imports: Map<string, string>): void {
    settings.setRaw(KEY_IMPORTS, JSON.stringify(Object.fromEntries(imports)))
  }

  /**
   * Import one discovered camera: resolves its RTSPS URL in main and stores it
   * through the normal encrypted camera store. Returns the local camera id.
   */
  async function importCamera(unifiCameraId: string): Promise<{ cameraId: string }> {
    const host = settings.getRaw(KEY_HOST)
    const key = settings.getRaw(KEY_API_KEY_ENC)
    if (!host || !key) throw notFound('UniFi Protect account')
    const raw = await listCamerasOn(host, decryptSecret(key))
    const cam = raw.find((c) => c.id === unifiCameraId)
    if (!cam) throw notFound('UniFi camera')
    const url = (cam.rtspsUrl || cam.rtspUrl)!.trim()
    const imports = loadImports()
    const existing = imports.get(unifiCameraId)
    if (existing) return { cameraId: existing }
    const cameraId = addCamera(cam.name || 'UniFi camera', url)
    imports.set(unifiCameraId, cameraId)
    saveImports(imports)
    return { cameraId }
  }

  return { getStatus, connect, disconnect, listCameras, importCamera }
}

export type UnifiService = ReturnType<typeof createUnifiService>
