/**
 * Item-name normalization and spoken/written quantity parsing, shared by the
 * kiosk renderer, the phone companion, and the main-process services so that
 * "Milk", "MILK 2%" and "milk" all land on the same pantry row where possible.
 */

/** Canonical units; everything spoken or scanned maps onto one of these. */
export const CANONICAL_UNITS = [
  'gallon',
  'quart',
  'pint',
  'lb',
  'oz',
  'kg',
  'g',
  'ml',
  'l',
  'dozen',
  'count',
  'pack',
  'box',
  'bag',
  'can',
  'jar',
  'bottle',
  'loaf',
  'bunch',
  'stick'
] as const

const UNIT_ALIASES: Record<string, string> = {
  gal: 'gallon',
  gals: 'gallon',
  gallon: 'gallon',
  gallons: 'gallon',
  qt: 'quart',
  qts: 'quart',
  quart: 'quart',
  quarts: 'quart',
  pt: 'pint',
  pts: 'pint',
  pint: 'pint',
  pints: 'pint',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  kg: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  g: 'g',
  gram: 'g',
  grams: 'g',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  l: 'l',
  liter: 'l',
  litre: 'l',
  liters: 'l',
  litres: 'l',
  dozen: 'dozen',
  doz: 'dozen',
  ct: 'count',
  count: 'count',
  ea: 'count',
  each: 'count',
  pcs: 'count',
  pieces: 'count',
  pack: 'pack',
  packs: 'pack',
  pkg: 'pack',
  package: 'pack',
  packages: 'pack',
  box: 'box',
  boxes: 'box',
  bag: 'bag',
  bags: 'bag',
  can: 'can',
  cans: 'can',
  jar: 'jar',
  jars: 'jar',
  bottle: 'bottle',
  bottles: 'bottle',
  loaf: 'loaf',
  loaves: 'loaf',
  bunch: 'bunch',
  bunches: 'bunch',
  stick: 'stick',
  sticks: 'stick'
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  half: 0.5,
  couple: 2
}

/** Lowercase alphanumeric key used to match the same product across sources. */
export function normalizeItemName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((tok) => tok.length > 0 && !/^\d+$/.test(tok)) // drop pure numbers ("2", "12oz" keeps letters)
    .join(' ')
}

export function canonicalUnit(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = raw.toLowerCase().replace(/[^a-z]/g, '')
  return UNIT_ALIASES[key] ?? null
}

export interface QuantityPhrase {
  quantity: number
  unit: string | null
  /** the remaining text after the quantity/unit was pulled off the front */
  rest: string
}

/**
 * Parses a leading quantity off a phrase: "2 gallons of milk" ->
 * { quantity: 2, unit: 'gallon', rest: 'milk' }; "a dozen eggs" ->
 * { quantity: 12, unit: 'dozen', rest: 'eggs' }. Returns null when the phrase
 * does not start with a quantity.
 */
export function parseQuantityPhrase(text: string): QuantityPhrase | null {
  const tokens = text.trim().toLowerCase().replace(/[,.]/g, ' ').split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  let quantity: number | null = null
  const first = tokens[0]
  if (first in NUMBER_WORDS) quantity = NUMBER_WORDS[first]
  else if (/^\d+(\.\d+)?$/.test(first)) quantity = Number(first)
  if (quantity === null) return null
  let idx = 1
  let unit: string | null = null
  // "a dozen eggs" — the article + dozen is a single quantity of 12
  if ((first === 'a' || first === 'an') && tokens[1] === 'dozen') {
    return { quantity: 12, unit: 'dozen', rest: tokens.slice(2).join(' ') || text.trim() }
  }
  if (idx < tokens.length) {
    const maybeUnit = canonicalUnit(tokens[idx])
    if (maybeUnit) {
      unit = maybeUnit
      idx++
    }
  }
  let rest = tokens.slice(idx).join(' ')
  if (rest.startsWith('of ')) rest = rest.slice(3)
  if (!rest) return null
  return { quantity, unit, rest }
}

/** "two gallons of milk" -> { quantity: 2, unit: 'gallon', rest: 'milk' } */
export function parseSpokenItem(text: string): QuantityPhrase {
  return parseQuantityPhrase(text) ?? { quantity: 1, unit: null, rest: text.trim().toLowerCase() }
}
