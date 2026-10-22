import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type os from 'node:os'
import { createCompanionTokens } from '../../src/main/companion/companionTokens'
import { pickLanAddresses } from '../../src/main/companion/lanAddress'
import { createCompanionServer, type CompanionServer } from '../../src/main/companion/companionServer'
import type { SettingsService } from '../../src/main/services/settingsService'
import type { IpcResult } from '../../src/shared/ipc/contract'

function settingsStub(companion = { enabled: true, port: 0 }): SettingsService {
  const store = new Map<string, string>()
  return {
    getRaw: (key: string) => store.get(key) ?? null,
    setRaw: (key: string, value: string) => void store.set(key, value),
    deleteRaw: (key: string) => void store.delete(key),
    getAll: () => ({ companion }) as never,
    set: () => ({}) as never
  } as SettingsService
}

describe('companionTokens', () => {
  it('issues distinct tokens that all verify; unknown tokens fail', () => {
    const tokens = createCompanionTokens(settingsStub())
    const a = tokens.issue()
    const b = tokens.issue()
    expect(a).not.toBe(b)
    expect(tokens.verify(a)).toBe(true)
    expect(tokens.verify(b)).toBe(true)
    expect(tokens.verify('nope')).toBe(false)
    expect(tokens.verify('')).toBe(false)
    expect(tokens.count()).toBe(2)
  })

  it('revokeAll invalidates every issued token', () => {
    const tokens = createCompanionTokens(settingsStub())
    const a = tokens.issue()
    tokens.revokeAll()
    expect(tokens.verify(a)).toBe(false)
    expect(tokens.count()).toBe(0)
  })

  it('prunes the oldest tokens past the cap of 20', () => {
    const tokens = createCompanionTokens(settingsStub())
    const first = tokens.issue()
    for (let i = 0; i < 20; i++) tokens.issue()
    expect(tokens.count()).toBe(20)
    expect(tokens.verify(first)).toBe(false)
  })

  it('survives a corrupt store', () => {
    const settings = settingsStub()
    settings.setRaw('companion.tokens.v1', '{not json')
    const tokens = createCompanionTokens(settings)
    expect(tokens.count()).toBe(0)
    expect(tokens.verify('x')).toBe(false)
    expect(tokens.verify(tokens.issue())).toBe(true)
  })
})

describe('pickLanAddresses', () => {
  const iface = (
    address: string,
    internal = false,
    family: 'IPv4' | 'IPv6' = 'IPv4'
  ): os.NetworkInterfaceInfo => ({ address, internal, family, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo

  it('prefers real-NIC private addresses over virtual adapters and skips junk', () => {
    const result = pickLanAddresses({
      'Loopback Pseudo-Interface 1': [iface('127.0.0.1', true)],
      'vEthernet (WSL)': [iface('172.27.0.1')],
      'Wi-Fi': [iface('192.168.0.42'), iface('fe80::1', false, 'IPv6')],
      Ethernet: [iface('169.254.10.10')]
    })
    expect(result[0]).toBe('192.168.0.42')
    expect(result).toContain('172.27.0.1') // shown as an alternate
    expect(result).not.toContain('127.0.0.1')
    expect(result).not.toContain('169.254.10.10')
    expect(result).not.toContain('fe80::1')
  })

  it('returns empty for no usable interfaces', () => {
    expect(pickLanAddresses({})).toEqual([])
  })
})

describe('companionServer', () => {
  let server: CompanionServer | null = null
  let staticRoot: string | null = null
  afterEach(() => {
    server?.stop()
    server = null
    if (staticRoot) rmSync(staticRoot, { recursive: true, force: true })
    staticRoot = null
  })

  /** Boot a real server on an OS-assigned port with a stub dispatcher. */
  async function boot(dispatchImpl?: (channel: string, payload: unknown) => Promise<IpcResult<unknown>>) {
    staticRoot = mkdtempSync(join(tmpdir(), 'osl-companion-'))
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>companion</title>')
    mkdirSync(join(staticRoot, 'assets'))
    writeFileSync(join(staticRoot, 'assets', 'app-abc123.js'), 'console.log(1)')
    const settings = settingsStub({ enabled: true, port: 0 }) // port 0 = OS-assigned
    const tokens = createCompanionTokens(settings)
    server = createCompanionServer({
      settings,
      tokens,
      dispatch: dispatchImpl ?? (async () => ({ ok: true, data: 'dispatched' })),
      version: '0.0.0-test',
      staticRoot,
      avatarBytes: () => null,
      uploadPhoto: async () => undefined,
      setAvatar: async () => undefined
    })
    server.applySettings()
    // wait for listen
    for (let i = 0; i < 100 && !server.getStatus().running; i++) await new Promise((r) => setTimeout(r, 10))
    const token = server.issueToken().url.split('#t=')[1]
    const status = server.getStatus()
    // port 0 was requested; recover the bound port from the issued URL
    const port = Number(new URL(server.issueToken().url).port)
    expect(status.running).toBe(true)
    return { base: `http://127.0.0.1:${port}`, token }
  }

  it('health is open, rpc requires a valid bearer token', async () => {
    const { base, token } = await boot()
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
    expect(((await health.json()) as { app: string }).app).toBe('openskylight')

    const noAuth = await fetch(`${base}/api/rpc/lists:getAll`, { method: 'POST' })
    expect(noAuth.status).toBe(401)

    const badAuth = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' }
    })
    expect(badAuth.status).toBe(401)

    const ok = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, data: 'dispatched' })
  })

  it('serves avatar bytes only with a valid token', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    staticRoot = mkdtempSync(join(tmpdir(), 'osl-companion-'))
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html>')
    const settings = settingsStub({ enabled: true, port: 0 })
    const tokens = createCompanionTokens(settings)
    server = createCompanionServer({
      settings,
      tokens,
      dispatch: async () => ({ ok: true, data: null }),
      version: '0.0.0-test',
      staticRoot,
      avatarBytes: (personId) => (personId === 'p1' ? png : null),
      uploadPhoto: async () => undefined,
      setAvatar: async () => undefined
    })
    server.applySettings()
    for (let i = 0; i < 100 && !server.getStatus().running; i++) await new Promise((r) => setTimeout(r, 10))
    const port = Number(new URL(server.issueToken().url).port)
    const base = `http://127.0.0.1:${port}`
    const token = server.issueToken().url.split('#t=')[1]

    const noToken = await fetch(`${base}/api/avatar/p1`)
    expect(noToken.status).toBe(401)
    const badToken = await fetch(`${base}/api/avatar/p1?t=wrong`)
    expect(badToken.status).toBe(401)
    const missing = await fetch(`${base}/api/avatar/nobody?t=${token}`)
    expect(missing.status).toBe(404)
    const ok = await fetch(`${base}/api/avatar/p1?t=${token}`)
    expect(ok.status).toBe(200)
    expect(Buffer.from(await ok.arrayBuffer()).equals(png)).toBe(true)
  })

  it('allows full calendar CRUD for a paired phone, and nothing administrative', async () => {
    const { base, token } = await boot()
    const headers = { Authorization: `Bearer ${token}` }
    for (const channel of ['events:get', 'events:create', 'events:update', 'events:delete', 'calendars:list', 'ai:importEvents']) {
      const res = await fetch(`${base}/api/rpc/${channel}`, { method: 'POST', headers })
      expect(res.status).toBe(200)
    }
    for (const channel of ['settings:set', 'auth:setPin', 'camera:add', 'unifi:connect', 'caldav:connect', 'ai:setConfig', 'webdav:connect', 'app:installUpdate']) {
      const res = await fetch(`${base}/api/rpc/${channel}`, { method: 'POST', headers })
      expect(res.status).toBe(404)
    }
  })

  it('photo upload requires a valid token and forwards bytes to WebDAV', async () => {
    staticRoot = mkdtempSync(join(tmpdir(), 'osl-companion-'))
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html>')
    const settings = settingsStub({ enabled: true, port: 0 })
    const tokens = createCompanionTokens(settings)
    const uploads: { name: string; bytes: Buffer }[] = []
    server = createCompanionServer({
      settings,
      tokens,
      dispatch: async () => ({ ok: true, data: null }),
      version: '0.0.0-test',
      staticRoot,
      avatarBytes: () => null,
      uploadPhoto: async (name, bytes) => {
        uploads.push({ name, bytes })
      },
      setAvatar: async () => undefined
    })
    server.applySettings()
    for (let i = 0; i < 100 && !server.getStatus().running; i++) await new Promise((r) => setTimeout(r, 10))
    const port = Number(new URL(server.issueToken().url).port)
    const base = `http://127.0.0.1:${port}`
    const token = server.issueToken().url.split('#t=')[1]
    const bytes = Buffer.from('fake-jpeg-bytes')

    const noAuth = await fetch(`${base}/api/photo?name=x.jpg`, { method: 'POST', body: bytes })
    expect(noAuth.status).toBe(401)
    expect(uploads.length).toBe(0)

    const badName = await fetch(`${base}/api/photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: bytes
    })
    expect(badName.status).toBe(400)

    const ok = await fetch(`${base}/api/photo?name=sunset.jpg`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: bytes
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, data: null })
    expect(uploads).toEqual([{ name: 'sunset.jpg', bytes }])

    // WebDAV failures surface as a typed error, not a crash
    server.stop()
    server = createCompanionServer({
      settings,
      tokens,
      dispatch: async () => ({ ok: true, data: null }),
      version: '0.0.0-test',
      staticRoot,
      avatarBytes: () => null,
      uploadPhoto: async () => {
        throw new Error('WebDAV not configured')
      },
      setAvatar: async () => undefined
    })
    server.applySettings()
    for (let i = 0; i < 100 && !server.getStatus().running; i++) await new Promise((r) => setTimeout(r, 10))
    const port2 = Number(new URL(server.issueToken().url).port)
    const token2 = server.issueToken().url.split('#t=')[1]
    const fail = await fetch(`http://127.0.0.1:${port2}/api/photo?name=y.jpg`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token2}` },
      body: bytes
    })
    expect(fail.status).toBe(200)
    const json = (await fail.json()) as { ok: boolean; error: { code: string; message: string } }
    expect(json.ok).toBe(false)
    expect(json.error.message).toContain('WebDAV not configured')
  })

  it('avatar upload requires a token and forwards bytes to the setAvatar dep', async () => {
    staticRoot = mkdtempSync(join(tmpdir(), 'osl-companion-'))
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html>')
    const settings = settingsStub({ enabled: true, port: 0 })
    const tokens = createCompanionTokens(settings)
    const received: { personId: string; bytes: Buffer }[] = []
    server = createCompanionServer({
      settings,
      tokens,
      dispatch: async () => ({ ok: true, data: null }),
      version: '0.0.0-test',
      staticRoot,
      avatarBytes: () => null,
      uploadPhoto: async () => undefined,
      setAvatar: async (personId, bytes) => {
        received.push({ personId, bytes })
      }
    })
    server.applySettings()
    for (let i = 0; i < 100 && !server.getStatus().running; i++) await new Promise((r) => setTimeout(r, 10))
    const port = Number(new URL(server.issueToken().url).port)
    const base = `http://127.0.0.1:${port}`
    const token = server.issueToken().url.split('#t=')[1]
    const bytes = Buffer.from('fake-png-bytes')

    const noAuth = await fetch(`${base}/api/avatar-upload?personId=p1`, { method: 'POST', body: bytes })
    expect(noAuth.status).toBe(401)
    expect(received.length).toBe(0)

    const badId = await fetch(`${base}/api/avatar-upload?personId=../evil`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: bytes
    })
    expect(badId.status).toBe(400)

    const ok = await fetch(`${base}/api/avatar-upload?personId=p1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: bytes
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, data: null })
    expect(received).toEqual([{ personId: 'p1', bytes }])
  })

  it('rejects channels outside the allowlist even with a valid token', async () => {
    const { base, token } = await boot()
    for (const channel of ['settings:set', 'auth:setPin', 'camera:add', 'app:installUpdate']) {
      const res = await fetch(`${base}/api/rpc/${channel}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: '{}'
      })
      expect(res.status, channel).toBe(404)
    }
  })

  it('passes the JSON body through to dispatch', async () => {
    let seen: { channel: string; payload: unknown } | null = null
    const { base, token } = await boot(async (channel, payload) => {
      seen = { channel, payload }
      return { ok: true, data: null }
    })
    await fetch(`${base}/api/rpc/listItems:add`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listId: 'l1', text: 'Milk' })
    })
    expect(seen).toEqual({ channel: 'listItems:add', payload: { listId: 'l1', text: 'Milk' } })
  })

  it('serves the static shell with SPA fallback and blocks traversal', async () => {
    const { base } = await boot()
    const index = await fetch(`${base}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'")
    const spa = await fetch(`${base}/lists`)
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('companion')
    const asset = await fetch(`${base}/assets/app-abc123.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const sneaky = await fetch(`${base}/..%2f..%2fpackage.json`)
    expect([403, 404]).toContain(sneaky.status)
  })

  it('rate limits repeated auth failures per IP', async () => {
    const { base } = await boot()
    let lastStatus = 0
    for (let i = 0; i < 35; i++) {
      const res = await fetch(`${base}/api/rpc/lists:getAll`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong' }
      })
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })

  it('unpairAll revokes access', async () => {
    const { base, token } = await boot()
    server!.unpairAll()
    const res = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(res.status).toBe(401)
  })
})
