import { describe, expect, it } from 'vitest'
import { parseReceiptText } from '../../src/shared/groceries/receiptParse'

const SAMPLE = `
FRY'S FOOD STORES
1234 MAIN ST
PHOENIX AZ 85001
(602) 555-0100
06/10/2026  18:42

MILK 2% WHOLE GAL        4.99
2 @ 1.49  EGGS LARGE     2.98
BANANAS  1.38 LB @ 0.99  1.37
ORG BROCCOLI             2.49 B
BREAD WHEAT LOAF         3.29

SUBTOTAL                 14.52
TAX                       1.16
TOTAL                    15.68
VISA **** 1234           15.68
APPROVAL 123456  AUTH
CASH BACK                 0.00
CHANGE                    0.00
THANK YOU FOR SHOPPING
`

describe('parseReceiptText', () => {
  it('detects the store and grand total, skipping subtotal/tax/change', () => {
    const r = parseReceiptText(SAMPLE)
    expect(r.store).toContain("FRY'S")
    expect(r.total).toBe(15.68)
  })

  it('parses item lines with plain prices, qty@price, and weight lines', () => {
    const r = parseReceiptText(SAMPLE)
    const byName = new Map(r.items.map((i) => [i.nameKey, i]))
    expect(byName.get('milk whole gal')?.price).toBe(4.99)
    expect(byName.get('milk whole gal')?.quantity).toBe(1)
    const eggs = byName.get('eggs large')
    expect(eggs?.quantity).toBe(2)
    expect(eggs?.price).toBeCloseTo(2.98)
    const bananas = byName.get('bananas')
    expect(bananas?.quantity).toBeCloseTo(1.38)
    expect(bananas?.unit).toBe('lb')
    expect(byName.get('org broccoli')?.price).toBe(2.49)
    expect(byName.get('bread wheat loaf')?.price).toBe(3.29)
    expect(r.items).toHaveLength(5)
  })

  it('drops boilerplate lines (card auth, addresses, phones, dates)', () => {
    const r = parseReceiptText(SAMPLE)
    const names = r.items.map((i) => i.nameKey).join(' ')
    expect(names).not.toMatch(/visa|approval|thank|subtotal|tax|total|change|cash|602|main st/i)
  })

  it('handles empty and garbage input without throwing', () => {
    expect(parseReceiptText('')).toEqual({ store: null, total: null, items: [] })
    const r = parseReceiptText('asdkjh \n 123 \n !!!!')
    expect(r.items).toHaveLength(0)
    expect(r.total).toBeNull()
  })

  it('folds price-only continuation lines into the previous item', () => {
    const r = parseReceiptText('STORE\nMILK\n  2 @ 2.50  5.00\nEGGS  3.00\nTOTAL 8.00\n')
    const milk = r.items.find((i) => i.nameKey === 'milk')
    expect(milk?.quantity).toBe(2)
    expect(milk?.price).toBeCloseTo(5.0)
    expect(r.items.find((i) => i.nameKey === 'eggs')?.price).toBe(3.0)
  })
})
