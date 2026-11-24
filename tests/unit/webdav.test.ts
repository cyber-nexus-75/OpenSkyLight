import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWebdavService,
  davList,
  type DavFetch
} from '../../src/main/services/webdavService'
import type { SettingsService } from '../../src/main/services/settingsService'

/**
 * WebDAV pull/upload against a stub transport — no live Nextcloud.
 * The stub models a single photo directory.
 */

function stubServer(files: Map<string, { etag: string; bytes: Buffer }>): DavFetch {
  return async (url, init) => {
    const u = new URL(url)
    const name = decodeURIComponent(u.pathname.replace(/\/$/, '').split('/').pop() ?? '')
    const method = init?.method ?? 'GET'
    if (method === 'PROPFIND') {
      const rows = [...files.entries()]
        .map(
          ([n, f]) =>
            `<d:response><d:href>/${n}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${f.bytes.length}</d:getcontentlength><d:getetag>${f.etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
        )
        .join('')
      return new Response(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${rows}</d:multistatus>`,
        { status: 207 }
      )
    }
    if (method === 'GET') {
      const f = files.get(name)
      if (!f) return new Response('not found', { status: 404 })
      return new Response(new Uint8Array(f.bytes), { status: 200 })
    }
    if (method === 'PUT') {
      const bytes = Buffer.from(await (init!.body as ArrayBuffer))
      files.set(name, { etag: `"e-${files.size + 1}"`, bytes })
      return new Response(null, { status: 201 })
    }
    return new Response('nope', { status: 405 })
  }
}

function settingsStub(): SettingsService & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getRaw: (key: string) => store.get(key) ?? null,
    setRaw: (key: string, value: string) => void store.set(key, value),
    deleteRaw: (key: string) => void store.delete(key),
    getAll: () => ({}) as never,
    set: () => ({}) as never
  } as SettingsService & { store: Map<string, string> }
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

describe('webdavService', () => {
  let cacheDir: string
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'osl-webdav-'))
    return () => rmSync(cacheDir, { recursive: true, force: true })
  })

  it('connect probes credentials and rejects bad ones', async () => {
    const settings = settingsStub()
    const svc = createWebdavService({ settings, cacheDir })
    // connect() probes with real HTTPS against the (unreachable) host — bad
    // credentials/URL must reject and store nothing
    await expect(svc.connect({ url: 'https://dav.invalid.example/Photos', username: 'a', password: 'wrong' }))
      .rejects.toThrow()
    expect(svc.getStatus().configured).toBe(false)
    expect(settings.store.size).toBe(0)
  })

  it('pull downloads new photos, skips unchanged etags, and removes vanished ones', async () => {
    const settings = settingsStub()
    const svc = createWebdavService({ settings, cacheDir })
    const remote = new Map<string, { etag: string; bytes: Buffer }>([
      ['beach.jpg', { etag: '"e1"', bytes: PNG }],
      ['notes.txt', { etag: '"e2"', bytes: Buffer.from('not a photo') }]
    ])
    const fetchFn = stubServer(remote)

    // seed credentials directly (connect probes over the real network; unit tests inject transport)
    settings.setRaw('screensaver.webdav.url', 'https://dav/Photos/')
    settings.setRaw('screensaver.webdav.username', 'alice')
    settings.setRaw('screensaver.webdav.passwordEnc', Buffer.from('plain:secret').toString('base64'))

    const changed1 = await svc.pull(fetchFn)
    expect(changed1).toBe(1) // only beach.jpg (txt filtered)
    expect(existsSync(join(cacheDir, 'beach.jpg'))).toBe(true)
    expect(readFileSync(join(cacheDir, 'beach.jpg')).equals(PNG)).toBe(true)
    expect(svc.getStatus().cachedCount).toBe(1)

    // unchanged etag → no re-download
    remote.get('beach.jpg')!.bytes = PNG // same content
    const changed2 = await svc.pull(fetchFn)
    expect(changed2).toBe(0)

    // etag change → re-download
    remote.set('beach.jpg', { etag: '"e1b"', bytes: Buffer.from('updated-image') })
    const changed3 = await svc.pull(fetchFn)
    expect(changed3).toBe(1)

    // vanish remotely → removed locally
    remote.delete('beach.jpg')
    const changed4 = await svc.pull(fetchFn)
    expect(changed4).toBe(1)
    expect(existsSync(join(cacheDir, 'beach.jpg'))).toBe(false)
    expect(svc.listCache().length).toBe(0)
  })

  it('upload PUTs to the remote dir and pulls the photo into the cache', async () => {
    const settings = settingsStub()
    const svc = createWebdavService({ settings, cacheDir })
    const remote = new Map<string, { etag: string; bytes: Buffer }>()
    const fetchFn = stubServer(remote)
    settings.setRaw('screensaver.webdav.url', 'https://dav/Photos/')
    settings.setRaw('screensaver.webdav.username', 'alice')
    settings.setRaw('screensaver.webdav.passwordEnc', Buffer.from('plain:secret').toString('base64'))

    await svc.upload('sunset.png', PNG, fetchFn)
    expect(remote.has('sunset.png')).toBe(true)
    expect(remote.get('sunset.png')!.bytes.equals(PNG)).toBe(true)
    // the pull-after-upload landed it in the kiosk cache
    expect(existsSync(join(cacheDir, 'sunset.png'))).toBe(true)
    expect(readdirSync(cacheDir).some((f) => f === 'sunset.png')).toBe(true)
  })

  it('pull skips hostile remote names instead of writing them into the cache', async () => {
    const settings = settingsStub()
    const svc = createWebdavService({ settings, cacheDir })
    const remote = new Map<string, { etag: string; bytes: Buffer }>([
      ['good.jpg', { etag: '"g"', bytes: PNG }],
      ['.hidden.jpg', { etag: '"h"', bytes: PNG }]
    ])
    settings.setRaw('screensaver.webdav.url', 'https://dav/Photos/')
    settings.setRaw('screensaver.webdav.username', 'alice')
    settings.setRaw('screensaver.webdav.passwordEnc', Buffer.from('plain:secret').toString('base64'))

    const changed = await svc.pull(stubServer(remote))
    expect(changed).toBe(1)
    expect(existsSync(join(cacheDir, 'good.jpg'))).toBe(true)
    expect(readdirSync(cacheDir).some((f) => f === '.hidden.jpg')).toBe(false)
  })

  it('upload refuses path-traversal names', async () => {
    const settings = settingsStub()
    const svc = createWebdavService({ settings, cacheDir })
    settings.setRaw('screensaver.webdav.url', 'https://dav/Photos/')
    settings.setRaw('screensaver.webdav.username', 'alice')
    settings.setRaw('screensaver.webdav.passwordEnc', Buffer.from('plain:secret').toString('base64'))
    await expect(svc.upload('../evil.jpg', PNG, stubServer(new Map()))).rejects.toThrow()
    await expect(svc.upload('a/b.jpg', PNG, stubServer(new Map()))).rejects.toThrow()
  })

  it('upload fails clearly when WebDAV is not configured', async () => {
    const svc = createWebdavService({ settings: settingsStub(), cacheDir })
    await expect(svc.upload('x.jpg', PNG, stubServer(new Map()))).rejects.toThrow(/Connect the photo WebDAV folder/)
  })
})

describe('davList', () => {
  it('filters to photo extensions and skips collections', async () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/Photos/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/Photos/beach.jpg</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength><d:getetag>"a"</d:getetag></d:prop></d:propstat></d:response>
      <d:response><d:href>/Photos/readme.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>"b"</d:getetag></d:prop></d:propstat></d:response>
    </d:multistatus>`
    const fetchFn: DavFetch = async () => new Response(xml, { status: 207 })
    const files = await davList(fetchFn, 'https://dav/Photos/')
    expect(files).toEqual([{ name: 'beach.jpg', etag: '"a"', size: 10 }])
  })
})
