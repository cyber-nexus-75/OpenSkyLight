import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcChannel, IpcResult } from '../../src/shared/ipc/contract'
import { broadcast } from '../../src/main/ipc/bus'
import { createWebServer, type WebServer } from '../../src/server/webServer'

let dir: string
let server: WebServer
let base: string

function dispatchStub(channel: IpcChannel, _payload: unknown): Promise<IpcResult<unknown>> {
  if (channel === 'app:getInfo') return Promise.resolve({ ok: true, data: { version: '9.9.9', platform: 'linux', zone: 'UTC' } })
  return Promise.resolve({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown channel' } })
}

async function startServer(opts: { token?: string } = {}): Promise<void> {
  server = createWebServer({
    version: '9.9.9',
    staticRoot: dir,
    dispatch: dispatchStub,
    protocolHandler: (scheme) =>
      scheme === 'osl-photo'
        ? (req) => {
            const name = new URL(req.url).pathname.replace(/^\//, '')
            return Promise.resolve(
              new Response(`photo-bytes:${name}`, { headers: { 'Content-Type': 'image/jpeg' } })
            )
          }
        : undefined,
    token: opts.token
  })
  const port = await server.listen(0, '127.0.0.1')
  base = `http://127.0.0.1:${port}`
}

async function readSseEvent(res: Response, timeoutMs = 3000): Promise<{ channel: string; payload: unknown }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frame = buf.split('\n\n').find((f) => f.startsWith('data: '))
    if (frame) {
      reader.cancel().catch(() => {})
      return JSON.parse(frame.slice('data: '.length)) as { channel: string; payload: unknown }
    }
  }
  throw new Error('no SSE data frame received')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osl-webserver-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<html><body>osl</body></html>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
})

afterEach(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('web server (open LAN mode)', () => {
  beforeEach(async () => {
    await startServer()
  })

  it('serves /api/health without auth', async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ app: 'openskylight', mode: 'server', version: '9.9.9' })
  })

  it('serves the SPA shell at / and falls back to index.html for client routes', async () => {
    const root = await fetch(`${base}/`)
    expect(root.status).toBe(200)
    expect(await root.text()).toContain('osl')
    const spa = await fetch(`${base}/week`)
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('osl')
    const asset = await fetch(`${base}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
  })

  it('dispatches RPC envelopes through the channel pipeline', async () => {
    const res = await fetch(`${base}/api/rpc/app:getInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null'
    })
    expect(res.status).toBe(200)
    const result = (await res.json()) as IpcResult<unknown>
    expect(result.ok).toBe(true)
    expect((result as { data: { version: string } }).data.version).toBe('9.9.9')
  })

  it('rejects non-allowlisted channels and non-JSON bodies', async () => {
    const bad = await fetch(`${base}/api/rpc/evil:channel`, { method: 'POST', body: '{}' })
    expect(bad.status).toBe(404)
    const notJson = await fetch(`${base}/api/rpc/app:getInfo`, { method: 'POST', body: '{oops' })
    expect(notJson.status).toBe(400)
    const unknown = await fetch(`${base}/api/nope`)
    expect(unknown.status).toBe(404)
  })

  it('serves registered custom protocols under /media/<scheme>/', async () => {
    const res = await fetch(`${base}/media/osl-photo/photos/cat.jpg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(await res.text()).toBe('photo-bytes:cat.jpg')
    const missing = await fetch(`${base}/media/osl-avatar/xyz`)
    expect(missing.status).toBe(404)
  })

  it('streams push messages over SSE', async () => {
    const res = await fetch(`${base}/api/events`)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const framePromise = readSseEvent(res)
    broadcast('push:dataChanged', { domain: 'events' })
    const frame = await framePromise
    expect(frame).toEqual({ channel: 'push:dataChanged', payload: { domain: 'events' } })
  })
})

describe('web server (token mode)', () => {
  beforeEach(async () => {
    await startServer({ token: 's3cret' })
  })

  it('blocks everything but health/login without the session cookie', async () => {
    expect((await fetch(`${base}/api/rpc/app:getInfo`, { method: 'POST', body: 'null' })).status).toBe(401)
    expect((await fetch(`${base}/`)).status).toBe(401)
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
  })

  it('rejects a wrong token and sets a session cookie for the right one', async () => {
    const wrong = await fetch(`${base}/api/login?t=nope`, { redirect: 'manual' })
    expect(wrong.status).toBe(401)
    const right = await fetch(`${base}/api/login?t=s3cret`, { redirect: 'manual' })
    expect(right.status).toBe(302)
    const cookie = right.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('osl_session=')
    expect(cookie).toContain('HttpOnly')
    const res = await fetch(`${base}/api/rpc/app:getInfo`, {
      method: 'POST',
      body: 'null',
      headers: { Cookie: cookie.split(';')[0] }
    })
    expect(res.status).toBe(200)
  })
})
