import { describe, expect, it } from 'vitest'
import { createUnifiService, type UnifiFetchJson } from '../../src/main/services/unifiService'
import type { SettingsService } from '../../src/main/services/settingsService'
import { AppError } from '../../src/main/services/errors'

/**
 * Stub the console transport (the real one is HTTPS against the UniFi OS
 * console with a self-signed cert; the service accepts an injectable
 * transport so tests never need a live console or TLS machinery).
 */

const cameras = [
  {
    id: 'cam-front',
    name: 'Front Door',
    modelKey: 'G4Doorbell',
    isOnline: true,
    rtspsUrl: 'rtsps://192.168.1.2:7441/abc123?camera=front'
  },
  {
    id: 'cam-yard',
    name: 'Backyard',
    modelKey: 'G5Bullet',
    isOnline: false,
    rtspUrl: 'rtsp://192.168.1.3:554/xyz789'
  },
  {
    // no stream URLs → filtered out of discovery
    id: 'cam-nope',
    name: 'Broken',
    modelKey: 'G3Flex',
    isOnline: false
  }
]

function stubTransport(log: string[] = []): UnifiFetchJson {
  return async (host, apiKey) => {
    log.push(`${host}|${apiKey}`)
    if (apiKey !== 'test-api-key-123') throw new AppError('UNIFI_AUTH', 'Invalid UniFi API key')
    return cameras
  }
}

function settingsStub(): SettingsService {
  const store = new Map<string, string>()
  return {
    getRaw: (key: string) => store.get(key) ?? null,
    setRaw: (key: string, value: string) => void store.set(key, value),
    deleteRaw: (key: string) => void store.delete(key),
    getAll: () => ({}) as never,
    set: () => ({}) as never
  } as SettingsService
}

describe('unifiService', () => {
  it('rejects an invalid API key and stores nothing', async () => {
    const settings = settingsStub()
    const unifi = createUnifiService({ settings, addCamera: () => 'x', fetchJson: stubTransport() })
    await expect(unifi.connect({ host: '192.168.1.1', apiKey: 'wrong-key' })).rejects.toThrow(
      /Invalid UniFi API key/
    )
    expect(unifi.getStatus().configured).toBe(false)
    expect(settings.getRaw('unifi.host')).toBeNull()
  })

  it('connects, discovers cameras (streamless ones filtered), and imports one', async () => {
    const settings = settingsStub()
    const added: { name: string; url: string }[] = []
    const unifi = createUnifiService({
      settings,
      addCamera: (name, url) => {
        added.push({ name, url })
        return `local-${added.length}`
      },
      fetchJson: stubTransport()
    })

    expect(await unifi.connect({ host: '192.168.1.1', apiKey: 'test-api-key-123' })).toEqual({
      host: '192.168.1.1'
    })
    expect(unifi.getStatus()).toEqual({ configured: true, host: '192.168.1.1' })

    const list = await unifi.listCameras()
    expect(list.map((c) => c.id)).toEqual(['cam-front', 'cam-yard']) // cam-nope filtered
    expect(list[0]).toMatchObject({ name: 'Front Door', model: 'G4Doorbell', online: true, imported: false })

    const { cameraId } = await unifi.importCamera('cam-front')
    expect(cameraId).toBe('local-1')
    expect(added).toEqual([{ name: 'Front Door', url: 'rtsps://192.168.1.2:7441/abc123?camera=front' }])

    // re-import is idempotent — no duplicate camera
    expect((await unifi.importCamera('cam-front')).cameraId).toBe('local-1')
    expect(added.length).toBe(1)
    expect((await unifi.listCameras())[0].imported).toBe(true)

    // unknown camera id
    await expect(unifi.importCamera('cam-ghost')).rejects.toThrow()

    // disconnect wipes credentials and the import map
    unifi.disconnect()
    expect(unifi.getStatus().configured).toBe(false)
    await expect(unifi.listCameras()).rejects.toThrow()
  })

  it('normalizes host input: strips scheme, port paths, and rejects garbage', async () => {
    const unifi = createUnifiService({ settings: settingsStub(), addCamera: () => 'x', fetchJson: stubTransport() })
    const result = await unifi.connect({ host: 'https://192.168.1.1:8443/', apiKey: 'test-api-key-123' })
    expect(result.host).toBe('192.168.1.1:8443')
    await expect(unifi.connect({ host: 'not a host', apiKey: 'test-api-key-123' })).rejects.toThrow(/host/)
  })

  it('handles { cameras: [...] } wrapper responses', async () => {
    const unifi = createUnifiService({
      settings: settingsStub(),
      addCamera: () => 'x',
      fetchJson: async () => ({ cameras })
    })
    const { host } = await unifi.connect({ host: '192.168.1.1', apiKey: 'test-api-key-123' })
    expect(host).toBe('192.168.1.1')
    expect((await unifi.listCameras()).length).toBe(2)
  })
})
