import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SettingsService } from './settingsService'
import { pickLanAddresses } from '../companion/lanAddress'

/**
 * Doorbell alerts. UniFi Protect's Alarm Manager fires a webhook on a ring;
 * the kiosk receives it on an unguessable URL (random 128-bit token, only the
 * sha256 stored — the pairing-token pattern). Protect does not sign webhooks,
 * so the secret path IS the authentication. The main process broadcasts a
 * push event; the renderer shows a chime overlay with the live camera.
 */

const KEY_TOKEN_HASH = 'doorbell.tokenHash'
const KEY_CAMERA = 'doorbell.cameraId'
const RING_DEBOUNCE_MS = 4_000

export interface DoorbellStatus {
  webhookToken: string | null
  webhookUrl: string | null
  cameraId: string | null
}

export function createDoorbellService(deps: {
  settings: SettingsService
  /** kiosk-side port the webhook URL is served on */
  port: () => number
}) {
  const { settings, port } = deps
  let lastRingAt = 0

  function hashOf(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex')
  }

  function mintToken(): string {
    const token = randomBytes(16).toString('hex')
    settings.setRaw(KEY_TOKEN_HASH, hashOf(token))
    return token
  }

  function webhookUrl(token: string): string {
    const [best] = pickLanAddresses()
    const p = port()
    return `http://${best ?? 'localhost'}:${p}/api/doorbell/${token}`
  }

  function getStatus(): DoorbellStatus {
    const has = settings.getRaw(KEY_TOKEN_HASH) !== null
    const cameraId = settings.getRaw(KEY_CAMERA)
    // token plaintext is not retained; the URL is shown once at mint time and
    // stored transiently in memory for the settings UI to re-display
    return {
      webhookToken: has && latestToken !== null ? latestToken : null,
      webhookUrl: has && latestToken !== null ? webhookUrl(latestToken) : null,
      cameraId
    }
  }

  let latestToken: string | null = null

  function setCamera(cameraId: string | null): { webhookToken: string; webhookUrl: string } {
    settings.setRaw(KEY_CAMERA, cameraId ?? '')
    const token = latestToken ?? mintToken()
    latestToken = token
    return { webhookToken: token, webhookUrl: webhookUrl(token) }
  }

  function rotateToken(): { webhookToken: string; webhookUrl: string } {
    const token = mintToken()
    latestToken = token
    return { webhookToken: token, webhookUrl: webhookUrl(token) }
  }

  /** Token check only — for GET probes, which must not consume the ring. */
  function verifyToken(token: string): boolean {
    const stored = settings.getRaw(KEY_TOKEN_HASH)
    if (!stored) return false
    const candidate = Buffer.from(hashOf(token), 'hex')
    const expected = Buffer.from(stored, 'hex')
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
  }

  /** 'ok' = ring accepted; 'debounced' = valid token, duplicate ring ignored;
   * 'invalid' = wrong token (treat as a nonexistent path). POSTs only. */
  function acceptRing(token: string): 'ok' | 'debounced' | 'invalid' {
    if (!verifyToken(token)) return 'invalid'
    const now = Date.now()
    if (now - lastRingAt < RING_DEBOUNCE_MS) return 'debounced'
    lastRingAt = now
    return 'ok'
  }

  return { getStatus, setCamera, rotateToken, verifyToken, acceptRing }
}

export type DoorbellService = ReturnType<typeof createDoorbellService>
