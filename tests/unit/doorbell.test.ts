import { describe, expect, it } from 'vitest'
import { createDoorbellService } from '../../src/main/services/doorbellService'
import type { SettingsService } from '../../src/main/services/settingsService'

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

describe('doorbellService', () => {
  it('mints an unguessable token; only its sha256 is stored', () => {
    const settings = settingsStub()
    const svc = createDoorbellService({ settings, port: () => 8420 })
    const { webhookToken, webhookUrl } = svc.setCamera('cam-1')
    expect(webhookToken).toMatch(/^[a-f0-9]{32}$/)
    expect(webhookUrl).toMatch(new RegExp(`^http://[^/]+:8420/api/doorbell/${webhookToken}$`))
    // stored value is a hash, not the token
    const stored = settings.store.get('doorbell.tokenHash')!
    expect(stored).not.toBe(webhookToken)
    expect(stored).toHaveLength(64)
  })

  it('accepts a valid ring and debounces rapid duplicates', () => {
    const svc = createDoorbellService({ settings: settingsStub(), port: () => 8420 })
    const { webhookToken } = svc.setCamera(null)
    expect(svc.acceptRing(webhookToken)).toBe('ok')
    // webhook retries / Protect re-fires within the debounce window are dropped
    expect(svc.acceptRing(webhookToken)).toBe('debounced')
    expect(svc.acceptRing(webhookToken)).toBe('debounced')
  })

  it('rejects wrong or missing tokens without revealing existence', () => {
    const settings = settingsStub()
    const svc = createDoorbellService({ settings, port: () => 8420 })
    const { webhookToken } = svc.setCamera(null)
    expect(svc.acceptRing('deadbeef')).toBe('invalid')
    expect(svc.acceptRing('')).toBe('invalid')
    expect(svc.acceptRing(webhookToken.toUpperCase())).toBe('invalid')
    const fresh = createDoorbellService({ settings: settingsStub(), port: () => 8420 })
    expect(fresh.acceptRing(webhookToken)).toBe('invalid') // nothing configured
  })

  it('rotate invalidates the old token immediately', () => {
    const svc = createDoorbellService({ settings: settingsStub(), port: () => 8420 })
    const first = svc.setCamera('cam-1').webhookToken
    const second = svc.rotateToken().webhookToken
    expect(second).not.toBe(first)
    expect(svc.acceptRing(first)).toBe('invalid')
    expect(svc.acceptRing(second)).toBe('ok')
  })

  it('getStatus reflects camera binding and remembers the minted token', () => {
    const svc = createDoorbellService({ settings: settingsStub(), port: () => 8420 })
    expect(svc.getStatus()).toEqual({ webhookToken: null, webhookUrl: null, cameraId: null })
    svc.setCamera('cam-9')
    const st = svc.getStatus()
    expect(st.cameraId).toBe('cam-9')
    expect(st.webhookUrl).toContain('/api/doorbell/')
  })
})
