import { describe, expect, it } from 'vitest'
import { DEFAULT_STORE_BASE_URL, frysCsv, frysSearchUrl, frysTextList, normalizeStoreBaseUrl } from '../../src/shared/groceries/frys'

describe('frys handoff', () => {
  it('normalizes the store base url', () => {
    expect(normalizeStoreBaseUrl('')).toBe(DEFAULT_STORE_BASE_URL)
    expect(normalizeStoreBaseUrl('not a url')).toBe(DEFAULT_STORE_BASE_URL)
    expect(normalizeStoreBaseUrl('https://www.fredmeyer.com/')).toBe('https://www.fredmeyer.com')
    expect(normalizeStoreBaseUrl(' https://www.kroger.com/// ')).toBe('https://www.kroger.com')
  })

  it('builds per-item search deep links', () => {
    expect(frysSearchUrl('https://www.kroger.com', '2% milk')).toBe(
      'https://www.kroger.com/search?query=2%25%20milk'
    )
    expect(frysSearchUrl('', 'eggs')).toContain(`${DEFAULT_STORE_BASE_URL}/search?query=eggs`)
  })

  it('formats a plain text list', () => {
    expect(
      frysTextList([
        { name: 'Milk', quantity: 2, unit: 'gallon' },
        { name: 'Eggs', quantity: 1, unit: null }
      ])
    ).toBe('2 gallon Milk\n1 Eggs')
  })

  it('emits CSV with a search url per row and escapes commas', () => {
    const csv = frysCsv('https://www.kroger.com', [{ name: 'Ice cream, vanilla', quantity: 1, unit: null }])
    const lines = csv.split('\n')
    expect(lines[0]).toBe('item,quantity,unit,store_search_url')
    expect(lines[1]).toBe('"Ice cream, vanilla",1,,https://www.kroger.com/search?query=Ice%20cream%2C%20vanilla')
  })
})
