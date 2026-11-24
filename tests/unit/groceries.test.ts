import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DbHandle } from '../../src/main/db/client'
import { createGroceriesService, type GroceriesService } from '../../src/main/services/groceriesService'
import { createReceiptService, type ReceiptService } from '../../src/main/services/receiptService'

const FAKE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])

const FAKE_RECEIPT_TEXT = `
FRY'S FOOD STORES
MILK 2% GAL  4.99
2 @ 1.49  EGGS LARGE  2.98
SUBTOTAL  7.97
TAX  0.64
TOTAL  8.61
VISA **** 1234  8.61
`

describe('groceriesService', () => {
  let handle: DbHandle
  let svc: GroceriesService

  beforeEach(() => {
    handle = openDatabase(':memory:')
    svc = createGroceriesService(handle.db)
  })

  it('upserts pantry items by normalized name', () => {
    const a = svc.pantryAdd({ name: 'Milk', quantity: 1, unit: 'gallon' })
    const b = svc.pantryAdd({ name: 'MILK 2%', quantity: 1 })
    expect(b.id).toBe(a.id)
    expect(svc.getState().pantry).toHaveLength(1)
    expect(svc.getState().pantry[0].quantity).toBe(2)
  })

  it('adjusts quantity with a floor at zero', () => {
    const item = svc.pantryAdd({ name: 'Eggs', quantity: 3, unit: 'dozen' })
    svc.pantryAdjust(item.id, -1)
    expect(svc.getState().pantry[0].quantity).toBe(2)
    svc.pantryAdjust(item.id, -10)
    expect(svc.getState().pantry[0].quantity).toBe(0)
  })

  it('flags low stock when quantity <= minQuantity', () => {
    const eggs = svc.pantryAdd({ name: 'Eggs', quantity: 2, minQuantity: 6 })
    const milk = svc.pantryAdd({ name: 'Milk', quantity: 1, minQuantity: 0 })
    svc.pantryAdjust(eggs.id, -2) // now 0 <= 6
    svc.pantryAdjust(milk.id, -1) // now 0 <= 0
    const low = svc.getState().lowStock.map((p) => p.name).sort()
    expect(low).toEqual(['Eggs', 'Milk'])
  })

  it('shopping list: add bumps existing unchecked line, toggle sinks, clear removes', () => {
    const a = svc.shoppingAdd({ name: 'Milk', quantity: 1 })
    svc.shoppingAdd({ name: 'milk', quantity: 2 })
    let state = svc.getState()
    expect(state.shopping).toHaveLength(1)
    expect(state.shopping[0].quantity).toBe(3)
    svc.shoppingToggle(a.id)
    svc.shoppingAdd({ name: 'Bread', quantity: 1 })
    state = svc.getState()
    expect(state.shopping.map((i) => i.name)).toEqual(['Bread', 'Milk'])
    svc.shoppingClearChecked()
    expect(svc.getState().shopping.map((i) => i.name)).toEqual(['Bread'])
  })

  it('addLowStock pushes low items onto the order once', () => {
    svc.pantryAdd({ name: 'Eggs', quantity: 0, minQuantity: 6 })
    svc.pantryAdd({ name: 'Milk', quantity: 5, minQuantity: 0 })
    const first = svc.shoppingAddLowStock()
    expect(first.added).toBe(1)
    const second = svc.shoppingAddLowStock()
    expect(second.added).toBe(0)
    expect(svc.getState().shopping[0].name).toBe('Eggs')
  })

  it('soft-deletes pantry items and they leave low-stock', () => {
    const item = svc.pantryAdd({ name: 'Old thing', quantity: 0 })
    svc.pantryRemove(item.id)
    expect(svc.getState().pantry).toHaveLength(0)
    expect(svc.getState().lowStock).toHaveLength(0)
  })
})

describe('receiptService (with injected OCR)', () => {
  let dir: string
  let handle: DbHandle
  let svc: ReceiptService
  let groceries: GroceriesService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'osl-receipts-'))
    handle = openDatabase(':memory:')
    groceries = createGroceriesService(handle.db)
    svc = createReceiptService({
      rootDir: dir,
      db: handle.db,
      ocrText: async () => FAKE_RECEIPT_TEXT
    })
  })

  it('scans, parses, stores the image, and lists the scan', async () => {
    const result = await svc.scan(FAKE_PNG)
    expect(result.scan.store).toContain("FRY'S")
    expect(result.scan.total).toBe(8.61)
    expect(result.scan.itemCount).toBe(2)
    expect(result.parsed.items.map((i) => i.nameKey).sort()).toEqual(['eggs large', 'milk gal'])
    expect(groceries.listReceipts()).toHaveLength(1)
    expect(svc.getImageDataUrl(result.scan.id)).toMatch(/^data:image\/png;base64,/)
    const detail = svc.getScanDetail(result.scan.id)
    expect(detail.parsed.items).toHaveLength(2)
  })

  it('applyReceipt adds parsed items to the pantry and marks the scan applied', async () => {
    const result = await svc.scan(FAKE_PNG)
    const { updated } = groceries.applyReceipt(
      result.scan.id,
      result.parsed.items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit }))
    )
    expect(updated).toBe(2)
    const pantry = groceries.getState().pantry
    expect(pantry.map((p) => p.name).sort()).toEqual(['Eggs Large', 'Milk 2% Gal'])
    expect(pantry.every((p) => p.source === 'receipt')).toBe(true)
    expect(groceries.listReceipts()[0].applied).toBe(true)
  })

  it('rejects non-image payloads', async () => {
    await expect(svc.scan(Buffer.from('not an image'))).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('cleanup', () => {
    rmSync(dir, { recursive: true, force: true })
  })
})
