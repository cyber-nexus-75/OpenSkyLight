import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { ALLOWED_CHANNEL_PREFIXES, type IpcChannel, type IpcResult } from '@shared/ipc/contract'
import { addBroadcastSink } from '../main/ipc/bus'
import type { ProtocolHandler } from './electronStub'

const MAX_BODY_BYTES = 25 * 1024 * 1024 // avatar uploads ride the RPC pipeline as base64
const SSE_HEARTBEAT_MS = 25_000
const PUSH_PREFIX = 'push:'
const SESSION_COOKIE = 'osl_session'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

export interface WebServerDeps {
  version: string
  /** Directory holding the built renderer web app (out/renderer). */
  staticRoot: string
  /** The shared IPC pipeline with gate:'pin' — same enforcement as the desktop app. */
  dispatch: (channel: IpcChannel, payload: unknown) => Promise<IpcResult<unknown>>
  /** Custom-scheme handlers registered via the electron stub (osl-photo, osl-avatar, osl-bird). */
  protocolHandler: (scheme: string) => ProtocolHandler | undefined
  /** Camera WebSocket upgrade handler (noServer WSS attached to this HTTP server). */
  handleUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** Google OAuth redirect handler for /__oauth/google (server mode). */
  oauthCallback?: (query: { code: string | null; error: string | null; state: string | null }) => boolean
  /** When set, every route except /api/health, /api/login and /__oauth/google needs the session cookie. */
  token?: string
  onListen?: (port: number) => void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function cookieValue(headers: IncomingMessage['headers'], name: string): string | null {
  const raw = headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * The server-mode web app: serves the built renderer as a static SPA and
 * bridges the full IPC contract over HTTP (POST /api/rpc/:channel) plus an
 * SSE push stream (GET /api/events) — the same channel table and PIN gate the
 * desktop app uses. Custom osl-*:// media URLs are served under /media/ and
 * camera streams upgrade on /camera-ws, so one port serves everything.
 */
export function createWebServer(deps: WebServerDeps) {
  const expectedSession = deps.token ? tokenHash(deps.token) : null

  function authorized(req: IncomingMessage): boolean {
    if (!expectedSession) return true
    return tokensEqual(cookieValue(req.headers, SESSION_COOKIE) ?? '', expectedSession)
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse, channelRaw: string): Promise<void> {
    const channel = decodeURIComponent(channelRaw) as IpcChannel
    if (!ALLOWED_CHANNEL_PREFIXES.some((p) => channel.startsWith(p))) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown channel' } })
      return
    }
    const body = await readBody(req)
    if (body === null) {
      sendJson(res, 413, { ok: false, error: { code: 'TOO_LARGE', message: 'Request too large' } })
      return
    }
    let payload: unknown
    try {
      payload = body.trim() === '' ? undefined : JSON.parse(body)
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'INVALID', message: 'Body must be JSON' } })
      return
    }
    const result = await deps.dispatch(channel, payload)
    sendJson(res, 200, result)
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    res.write('retry: 3000\n\n')
    const off = addBroadcastSink((channel, payload) => {
      if (!channel.startsWith(PUSH_PREFIX)) return
      res.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)
    })
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS)
    req.on('close', () => {
      clearInterval(heartbeat)
      off()
    })
  }

  async function handleMedia(res: ServerResponse, urlPath: string): Promise<void> {
    // /media/<scheme>/<rest...> -> protocol handler for <scheme> with url <scheme>://<rest...>
    const rest = urlPath.replace(/^\/media\//, '')
    const slash = rest.indexOf('/')
    const scheme = slash === -1 ? rest : rest.slice(0, slash)
    const tail = slash === -1 ? '' : rest.slice(slash + 1)
    const handler = deps.protocolHandler(scheme)
    if (!handler || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
      res.writeHead(404).end('Not found')
      return
    }
    try {
      const response = await handler(new Request(`${scheme}://${tail}`))
      const headers: Record<string, string> = {}
      const contentType = response.headers.get('content-type')
      if (contentType) headers['Content-Type'] = contentType
      headers['Cache-Control'] = 'no-cache'
      res.writeHead(response.status, headers)
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (err) {
      console.error(`[server] /media/${scheme} failed:`, err)
      res.writeHead(502).end('Upstream error')
    }
  }

  async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
    const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
    let filePath = join(deps.staticRoot, clean)
    if (!filePath.startsWith(deps.staticRoot + sep) && filePath !== deps.staticRoot) {
      res.writeHead(403).end()
      return
    }
    if (urlPath === '/' || urlPath === '') filePath = join(deps.staticRoot, 'index.html')
    let data: Buffer
    try {
      data = await fs.readFile(filePath)
    } catch {
      if (extname(filePath) === '') {
        try {
          data = await fs.readFile(join(deps.staticRoot, 'index.html'))
          filePath = 'index.html'
        } catch {
          res.writeHead(404).end('Not found')
          return
        }
      } else {
        res.writeHead(404).end('Not found')
        return
      }
    }
    const ext = extname(filePath) || '.html'
    const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }
    if (ext === '.html') headers['Cache-Control'] = 'no-store'
    else if (clean.includes('assets')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    else headers['Cache-Control'] = 'no-cache'
    res.writeHead(200, headers)
    res.end(data)
  }

  function handleLogin(res: ServerResponse, url: string): void {
    if (!deps.token) {
      res.writeHead(302, { Location: '/' }).end()
      return
    }
    const t = new URL(url, 'http://server').searchParams.get('t') ?? ''
    if (!tokensEqual(t, deps.token)) {
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
      return
    }
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `${SESSION_COOKIE}=${expectedSession}; Path=/; HttpOnly; SameSite=Strict`
    })
    res.end()
  }

  function handleOauth(res: ServerResponse, url: string): void {
    if (!deps.oauthCallback) {
      res.writeHead(404).end('Not found')
      return
    }
    const u = new URL(url, 'http://server')
    const handled = deps.oauthCallback({
      code: u.searchParams.get('code'),
      error: u.searchParams.get('error'),
      state: u.searchParams.get('state')
    })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(
      `<html><body style="font-family:sans-serif;text-align:center;padding-top:4rem">
         <h2>${handled ? 'Connected!' : 'Sign-in failed'}</h2>
         <p>You can close this tab and return to the OpenSkyLight display.</p>
       </body></html>`
    )
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const path = url.split('?')[0]
    if (path === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { app: 'openskylight', mode: 'server', version: deps.version })
      return
    }
    if (path === '/__oauth/google' && req.method === 'GET') {
      handleOauth(res, url)
      return
    }
    if (path === '/api/login' && req.method === 'GET') {
      handleLogin(res, url)
      return
    }
    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Open /api/login?t=<token> first' } })
      return
    }
    if (path === '/api/events' && req.method === 'GET') {
      handleEvents(req, res)
      return
    }
    const rpcMatch = path.match(/^\/api\/rpc\/([^/]+)$/)
    if (rpcMatch) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } })
        return
      }
      await handleRpc(req, res, rpcMatch[1])
      return
    }
    if (path.startsWith('/media/') && req.method === 'GET') {
      await handleMedia(res, path)
      return
    }
    if (path.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } })
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    await serveStatic(res, url)
  }

  const server: Server = createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      console.error('[server] request failed:', err)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Server error' } })
      else res.end()
    })
  })

  server.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0].startsWith('/camera-ws') && deps.handleUpgrade) {
      deps.handleUpgrade(req, socket, head)
    } else {
      socket.destroy()
    }
  })

  function listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        const addr = server.address()
        const bound = typeof addr === 'object' && addr ? addr.port : port
        deps.onListen?.(bound)
        resolve(bound)
      })
    })
  }

  function close(): void {
    server.close()
  }

  return { listen, close }
}

export type WebServer = ReturnType<typeof createWebServer>
