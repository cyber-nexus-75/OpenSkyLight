import { describe, expect, it } from 'vitest'
import { rewriteBridgeUrl, rewriteBridgeUrls } from '../../src/shared/webBridgeUrls'

const WS = 'ws://192.168.1.10:8080'

describe('rewriteBridgeUrl', () => {
  it('rewrites osl-* custom protocol URLs to same-origin /media paths', () => {
    expect(rewriteBridgeUrl('osl-photo://photos/cat.jpg', WS)).toBe('/media/osl-photo/photos/cat.jpg')
    expect(rewriteBridgeUrl('osl-avatar://abc123', WS)).toBe('/media/osl-avatar/abc123')
    expect(rewriteBridgeUrl('osl-bird://image?base=http%3A%2F%2Fcam&sci=eagle', WS)).toBe(
      '/media/osl-bird/image?base=http%3A%2F%2Fcam&sci=eagle'
    )
  })

  it('rewrites loopback camera websockets to the page host', () => {
    expect(rewriteBridgeUrl('ws://127.0.0.1:41234/camera-ws/cam1?token=t', WS)).toBe(
      'ws://192.168.1.10:8080/camera-ws/cam1?token=t'
    )
  })

  it('leaves other URLs alone', () => {
    expect(rewriteBridgeUrl('https://example.com/x', WS)).toBe('https://example.com/x')
    expect(rewriteBridgeUrl('/already/local', WS)).toBe('/already/local')
    expect(rewriteBridgeUrl('ws://other-host:9/x', WS)).toBe('ws://other-host:9/x')
  })
})

describe('rewriteBridgeUrls', () => {
  it('deep-rewrites strings inside objects and arrays, preserving structure', () => {
    const input = {
      ok: true,
      data: {
        photos: ['osl-photo://photos/a.jpg', 'osl-photo://photos/b.jpg'],
        avatarUrl: 'osl-avatar://p1',
        camera: { wsUrl: 'ws://127.0.0.1:9/camera-ws/c?token=z', sessionId: 's' },
        n: 42,
        nil: null
      }
    }
    const out = rewriteBridgeUrls(input, WS)
    expect(out).toEqual({
      ok: true,
      data: {
        photos: ['/media/osl-photo/photos/a.jpg', '/media/osl-photo/photos/b.jpg'],
        avatarUrl: '/media/osl-avatar/p1',
        camera: { wsUrl: 'ws://192.168.1.10:8080/camera-ws/c?token=z', sessionId: 's' },
        n: 42,
        nil: null
      }
    })
  })
})
