import { canonicalUnit, normalizeItemName } from './normalize'

/**
 * Heuristic parser for OCR'd grocery receipt text. Receipts are noisy, so this
 * favors recall on item lines (name + price) and aggressively drops boilerplate
 * (totals, tax, card auth, addresses, dates). Everything it extracts is shown
 * to the user for confirmation before it touches the pantry.
 */

export interface ParsedReceiptItem {
  name: string
  /** normalized key, see normalizeItemName */
  nameKey: string
  quantity: number
  unit: string | null
  /** line total price in dollars, null when unreadable */
  price: number | null
}

export interface ParsedReceipt {
  store: string | null
  /** grand total in dollars, null when not found */
  total: number | null
  items: ParsedReceiptItem[]
}

const STORE_KEYWORDS = [
  "fry's",
  'frys',
  'kroger',
  'fred meyer',
  'safeway',
  'albertsons',
  'trader joe',
  'whole foods',
  'walmart',
  'costco',
  'target',
  'sprouts',
  'winco',
  'grocery'
]

/** Lines that are receipt plumbing, never purchased items. */
const SKIP_PATTERNS: RegExp[] = [
  /\bsub\s*total\b/i,
  /\btax\b/i,
  /\btotal\b/i,
  /\bchange\b/i,
  /\bcash\b/i,
  /\b(credit|debit|visa|mastercard|master card|amex|discover)\b/i,
  /\b(card|pin|auth|approval|aid|tv|tc|trace|terminal|merchant|ref(erence)?|trans)\b/i,
  /\bcash\s*back\b/i,
  /\bcoupon|discount|savings|reward/i,
  /\bthank\s*you\b/i,
  /\bcustomer\s*copy\b/i,
  /\bsurvey\b/i,
  /\bwww\.|https?:\/\//i,
  /^\d{3}[-. ]\d{3}[-. ]\d{4}$/, // phone
  /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/, // date
  /^\d{1,2}:\d{2}\s*(am|pm)?/i, // time
  /\b(st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|suite|ste)\b\.?\s*\d/i, // street address
  /^[*#\-=_~]+$/, // divider lines
  /^\s*$/
]

const MONEY = /\$?\s*(\d+\.\d{2})/

function lastMoney(line: string): number | null {
  const matches = [...line.matchAll(new RegExp(MONEY.source, 'g'))]
  if (matches.length === 0) return null
  return Number(matches[matches.length - 1][1])
}

function titleCase(name: string): string {
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** Pull a trailing price off a line; returns [namePart, price] or null. */
function splitPrice(line: string): [string, number] | null {
  const m = line.match(/^(.*?)[\s.]*\$?(\d+\.\d{2})\s*[A-Za-z]?\s*$/)
  if (!m) return null
  const price = Number(m[2])
  const namePart = m[1].replace(/[\s.]+$/, '')
  if (!namePart) return null
  return [namePart, price]
}

export function parseReceiptText(rawText: string): ParsedReceipt {
  const lines = rawText.split(/\r?\n/)

  // store: first line mentioning a known grocery banner, else first texty line
  let store: string | null = null
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (STORE_KEYWORDS.some((k) => lower.includes(k))) {
      store = line.trim().replace(/[^\x20-\x7E]/g, '').trim()
      break
    }
  }
  if (!store) {
    const first = lines.map((l) => l.trim()).find((l) => /[a-zA-Z]{4,}/.test(l) && !SKIP_PATTERNS.some((p) => p.test(l)))
    store = first ?? null
  }

  // grand total: last money amount on a "total" line that isn't subtotal/tax
  let total: number | null = null
  for (const line of lines) {
    if (/\bsub\s*total\b|\btax\b/i.test(line)) continue
    if (/\b(total|amount due|balance due|grand total)\b/i.test(line)) {
      total = lastMoney(line)
    }
  }

  const items: ParsedReceiptItem[] = []
  // a text line with no price may be the name of an item whose price/qty lands
  // on the following line ("MILK\n  2 @ 2.50  5.00")
  let pendingName: string | null = null
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (SKIP_PATTERNS.some((p) => p.test(line))) continue
    // price/qty-only lines ("2 @ 2.50  5.00") have no letters but are still items
    if (!/[a-zA-Z]/.test(line) && !/\d+\s*[@x]/.test(line)) continue
    const split = splitPrice(line)
    if (!split) {
      pendingName = line
      continue
    }
    let [namePart, price] = split

    // quantity forms: "2 @ 1.49 NAME …", "NAME … 2 @ 1.49", "NAME 3.21 LB @ 0.99"
    let quantity = 1
    let unit: string | null = null
    const trailingQty = namePart.match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*[@x]\s*\$?(\d+\.\d{2})\s*$/i)
    const leadingQty = namePart.match(/^(\d+(?:\.\d+)?)\s*[@x]\s*\$?(\d+\.\d{2})\s+(.+)$/i)
    const onlyQty = namePart.match(/^(\d+(?:\.\d+)?)\s*[@x]\s*\$?(\d+\.\d{2})$/i)
    if (onlyQty) {
      quantity = Number(onlyQty[1])
      namePart = ''
      price = Number(onlyQty[2]) * quantity || price
    } else if (leadingQty) {
      quantity = Number(leadingQty[1])
      namePart = leadingQty[3].trim()
      price = Number(leadingQty[2]) * quantity || price
    } else if (trailingQty) {
      quantity = Number(trailingQty[2])
      namePart = trailingQty[1].trim()
      price = Number(trailingQty[3]) * quantity || price
    } else {
      const weight = namePart.match(/^(.*?)\s+(\d+\.\d+)\s*(lb|lbs|oz|ounce|ounces|kg|gal|qt|pt)\b\.?\s*(?:@\s*\$?\d+\.\d{2})?$/i)
      if (weight) {
        quantity = Number(weight[2])
        unit = canonicalUnit(weight[3])
        namePart = weight[1].trim()
      }
    }

    namePart = namePart.replace(/[\s.]+$/, '').trim()
    if (namePart.length < 2 || !/[a-zA-Z]/.test(namePart)) {
      // price/qty-only continuation line — attach to the pending name, or fold
      // into the previous item when there is no pending name
      if (pendingName) {
        const nameKey = normalizeItemName(pendingName)
        if (nameKey) items.push({ name: titleCase(pendingName), nameKey, quantity, unit, price })
        pendingName = null
      } else {
        const prev = items[items.length - 1]
        if (prev && /\d+\s*[@x]/.test(line)) {
          prev.quantity += quantity
          if (prev.price !== null) prev.price += price
        }
      }
      continue
    }
    const nameKey = normalizeItemName(namePart)
    if (!nameKey) continue
    items.push({ name: titleCase(namePart), nameKey, quantity, unit, price })
    pendingName = null
  }

  return { store, total, items }
}
