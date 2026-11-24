/**
 * Fry's / Kroger order handoff. Kroger (Fry's parent) has no public API for
 * adding items to a cart, and scripting a logged-in session would violate
 * their terms — so instead of driving the site, OpenSkyLight prepares the
 * order and hands it off: per-item deep links into the store's search, a
 * copyable list, and CSV. The store base URL is user-configurable
 * (kroger.com for Fry's, fredmeyer.com for Fred Meyer, ...).
 */

export const DEFAULT_STORE_BASE_URL = 'https://www.kroger.com'

/** Normalize a user-entered store base URL; falls back to the Kroger default. */
export function normalizeStoreBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/.+/i.test(trimmed)) return DEFAULT_STORE_BASE_URL
  return trimmed
}

/** Deep link into the store's product search for one query. */
export function frysSearchUrl(baseUrl: string, query: string): string {
  const base = normalizeStoreBaseUrl(baseUrl)
  return `${base}/search?query=${encodeURIComponent(query.trim())}`
}

export interface FrysLine {
  name: string
  quantity: number
  unit: string | null
}

function formatLine(line: FrysLine): string {
  const qty = line.quantity > 0 && Number.isFinite(line.quantity) ? `${line.quantity}` : ''
  const unit = line.unit ? ` ${line.unit}` : ''
  return `${qty}${unit ? unit : ''}${qty || unit ? ' ' : ''}${line.name}`.trim()
}

/** Plain-text shopping list, one "qty unit name" per line. */
export function frysTextList(lines: FrysLine[]): string {
  return lines.map(formatLine).join('\n')
}

/** CSV export (opens in any spreadsheet); includes a search link per line. */
export function frysCsv(baseUrl: string, lines: FrysLine[]): string {
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const rows = lines.map((l) => [esc(l.name), String(l.quantity), esc(l.unit ?? ''), frysSearchUrl(baseUrl, l.name)])
  return ['item,quantity,unit,store_search_url', ...rows.map((r) => r.join(','))].join('\n')
}
