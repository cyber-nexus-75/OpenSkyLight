/**
 * URL rewriting for browser clients of the server-mode web app. The main
 * process mints Electron custom-protocol URLs (osl-photo://, osl-avatar://,
 * osl-bird://) and a loopback camera WebSocket (ws://127.0.0.1:<port>); in a
 * browser those must become same-origin /media/... HTTP paths and a
 * WebSocket on the page's own host. Pure so it is unit-testable in Node.
 */

const OSL_SCHEME = /^osl-(photo|avatar|bird):\/\//
const LOOPBACK_WS = /^ws:\/\/127\.0\.0\.1:\d+/

export function rewriteBridgeUrl(value: string, wsBase: string): string {
  if (OSL_SCHEME.test(value)) return value.replace(OSL_SCHEME, '/media/osl-$1/')
  if (LOOPBACK_WS.test(value)) return value.replace(LOOPBACK_WS, wsBase)
  return value
}

/** Deep-rewrite every string in a JSON payload (invoke results and push messages). */
export function rewriteBridgeUrls<T>(value: T, wsBase: string): T {
  if (typeof value === 'string') return rewriteBridgeUrl(value, wsBase) as T
  if (Array.isArray(value)) return value.map((v) => rewriteBridgeUrls(v, wsBase)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteBridgeUrls(v, wsBase)
    }
    return out as T
  }
  return value
}
