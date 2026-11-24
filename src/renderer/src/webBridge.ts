import { ALLOWED_CHANNEL_PREFIXES } from '@shared/ipc/contract'
import { rewriteBridgeUrls } from '@shared/webBridgeUrls'

/**
 * Browser transport for the server-mode web app. When the page is NOT running
 * inside Electron (no preload bridge), install a `window.osl` with the same
 * shape: invoke over POST /api/rpc/:channel, push events over one EventSource
 * on /api/events. osl-*:// media URLs and the loopback camera WebSocket are
 * rewritten to same-origin paths/hosts.
 */

const PUSH_PREFIX = 'push:'
const IDLE_REPORT_MS = 5_000

const reconnectCbs = new Set<() => void>()

/** Fires whenever the push stream reconnects after a drop (callers refetch). */
export function onWebBridgeReconnect(cb: () => void): void {
  reconnectCbs.add(cb)
}

type WakeLockSentinel = { release(): Promise<void> }

export function installWebBridge(): void {
  if (window.osl) return

  const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  let wasOpen = false

  const es = new EventSource('/api/events')
  es.onopen = () => {
    const reconnected = wasOpen
    wasOpen = true
    if (reconnected) for (const cb of [...reconnectCbs]) cb()
  }
  es.onmessage = (ev) => {
    let msg: { channel?: unknown; payload?: unknown }
    try {
      msg = JSON.parse(ev.data) as { channel?: unknown; payload?: unknown }
    } catch {
      return
    }
    if (typeof msg.channel !== 'string') return
    const payload = rewriteBridgeUrls(msg.payload, wsBase)
    for (const cb of listeners.get(msg.channel) ?? []) cb(payload)
  }

  window.osl = {
    async invoke(channel, payload) {
      if (!ALLOWED_CHANNEL_PREFIXES.some((p) => channel.startsWith(p))) {
        throw new Error(`Blocked channel: ${channel}`)
      }
      const res = await fetch(`/api/rpc/${encodeURIComponent(channel)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload === undefined ? null : payload)
      })
      if (res.status === 401) {
        location.reload()
        throw new Error('Session expired')
      }
      const result = (await res.json()) as unknown
      return rewriteBridgeUrls(result, wsBase)
    },
    on(channel, callback) {
      if (!channel.startsWith(PUSH_PREFIX)) return () => {}
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(callback)
      return () => {
        set.delete(callback)
      }
    }
  }

  // Browser kiosks have no OS idle API — report activity so the server-side
  // screensaver timer can fire on this device.
  let lastActive = Date.now()
  const bump = (): void => {
    lastActive = Date.now()
  }
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel']) {
    window.addEventListener(ev, bump, { passive: true })
  }
  setInterval(() => {
    const seconds = Math.floor((Date.now() - lastActive) / 1000)
    void window.osl.invoke('kiosk:reportIdle', { seconds }).catch(() => {})
  }, IDLE_REPORT_MS)

  // Keep the display awake while the sleep schedule says awake (Screen Wake Lock).
  let wakeLock: WakeLockSentinel | null = null
  const wakeLockApi = (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } })
    .wakeLock
  const syncWakeLock = (sleeping: boolean): void => {
    if (sleeping) {
      void wakeLock?.release().catch(() => {})
      wakeLock = null
      return
    }
    if (wakeLock || !wakeLockApi) return
    wakeLockApi
      .request('screen')
      .then((lock) => {
        wakeLock = lock
      })
      .catch(() => {})
  }
  window.osl.on('push:sleepState', (d) => syncWakeLock(Boolean((d as { sleeping?: boolean })?.sleeping)))
}
