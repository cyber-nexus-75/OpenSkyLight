import { and, asc, eq, isNull, max } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { pantryItems, receiptScans, shoppingItems } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { normalizeItemName } from '@shared/groceries/normalize'
import type {
  GroceriesStateDto,
  PantryItemDto,
  PantrySource,
  ReceiptScanDto,
  ShoppingItemDto
} from '@shared/types'
import { notFound } from './errors'

function pantryDto(row: typeof pantryItems.$inferSelect): PantryItemDto {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    quantity: row.quantity,
    minQuantity: row.minQuantity,
    source: row.source,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt
  }
}

function shoppingDto(row: typeof shoppingItems.$inferSelect): ShoppingItemDto {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    note: row.note,
    checked: row.checked,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt
  }
}

function receiptDto(row: typeof receiptScans.$inferSelect): ReceiptScanDto {
  return {
    id: row.id,
    store: row.store,
    total: row.total,
    itemCount: row.itemCount,
    applied: row.appliedAt !== null,
    scannedAt: row.scannedAt
  }
}

export function createGroceriesService(db: AppDb) {
  const now = (): string => isoUtc(DateTime.utc())

  function findPantryByKey(nameKey: string): typeof pantryItems.$inferSelect | undefined {
    return db
      .select()
      .from(pantryItems)
      .where(and(eq(pantryItems.nameKey, nameKey), isNull(pantryItems.deletedAt)))
      .get()
  }

  function listPantry(): PantryItemDto[] {
    return db
      .select()
      .from(pantryItems)
      .where(isNull(pantryItems.deletedAt))
      .orderBy(asc(pantryItems.name))
      .all()
      .map(pantryDto)
  }

  function listShopping(): ShoppingItemDto[] {
    const rows = db.select().from(shoppingItems).orderBy(asc(shoppingItems.sortOrder), asc(shoppingItems.createdAt)).all()
    return rows.map(shoppingDto).sort((a, b) => Number(a.checked) - Number(b.checked))
  }

  function lowStock(): PantryItemDto[] {
    return listPantry().filter((p) => p.quantity <= p.minQuantity)
  }

  function getState(): GroceriesStateDto {
    return { pantry: listPantry(), shopping: listShopping(), lowStock: lowStock() }
  }

  /** Add to the pantry; an existing item with the same normalized name gets its quantity increased. */
  function pantryAdd(input: {
    name: string
    quantity?: number
    unit?: string | null
    minQuantity?: number
    category?: string | null
    source?: PantrySource
  }): PantryItemDto {
    const name = input.name.trim()
    if (!name) throw notFound('Item')
    const nameKey = normalizeItemName(name)
    const quantity = input.quantity ?? 1
    const existing = findPantryByKey(nameKey)
    if (existing) {
      db.update(pantryItems)
        .set({
          quantity: existing.quantity + quantity,
          unit: input.unit ?? existing.unit,
          minQuantity: input.minQuantity ?? existing.minQuantity,
          category: input.category ?? existing.category,
          updatedAt: now()
        })
        .where(eq(pantryItems.id, existing.id))
        .run()
      return pantryDto(db.select().from(pantryItems).where(eq(pantryItems.id, existing.id)).get()!)
    }
    const id = uuidv7()
    const ts = now()
    db.insert(pantryItems)
      .values({
        id,
        name,
        nameKey,
        category: input.category ?? null,
        unit: input.unit ?? null,
        quantity,
        minQuantity: input.minQuantity ?? 0,
        source: input.source ?? 'manual',
        updatedAt: ts,
        createdAt: ts
      })
      .run()
    return pantryDto(db.select().from(pantryItems).where(eq(pantryItems.id, id)).get()!)
  }

  function pantryUpdate(input: {
    id: string
    name?: string
    quantity?: number
    unit?: string | null
    minQuantity?: number
    category?: string | null
  }): PantryItemDto {
    const [row] = db.select().from(pantryItems).where(and(eq(pantryItems.id, input.id), isNull(pantryItems.deletedAt))).all()
    if (!row) throw notFound('Pantry item')
    const patch: Partial<typeof pantryItems.$inferInsert> = { updatedAt: now() }
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw notFound('Pantry item')
      patch.name = name
      patch.nameKey = normalizeItemName(name)
    }
    if (input.quantity !== undefined) patch.quantity = Math.max(0, input.quantity)
    if (input.unit !== undefined) patch.unit = input.unit
    if (input.minQuantity !== undefined) patch.minQuantity = Math.max(0, input.minQuantity)
    if (input.category !== undefined) patch.category = input.category
    db.update(pantryItems).set(patch).where(eq(pantryItems.id, input.id)).run()
    return pantryDto(db.select().from(pantryItems).where(eq(pantryItems.id, input.id)).get()!)
  }

  /** Relative adjustment (voice "used 2 eggs"); floored at zero. */
  function pantryAdjust(id: string, delta: number): PantryItemDto {
    const [row] = db.select().from(pantryItems).where(and(eq(pantryItems.id, id), isNull(pantryItems.deletedAt))).all()
    if (!row) throw notFound('Pantry item')
    return pantryUpdate({ id, quantity: Math.max(0, row.quantity + delta) })
  }

  function pantryRemove(id: string): void {
    const result = db
      .update(pantryItems)
      .set({ deletedAt: now() })
      .where(and(eq(pantryItems.id, id), isNull(pantryItems.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Pantry item')
  }

  function shoppingAdd(input: { name: string; quantity?: number; unit?: string | null; note?: string | null }): ShoppingItemDto {
    const name = input.name.trim()
    if (!name) throw notFound('Item')
    const nameKey = normalizeItemName(name)
    const quantity = input.quantity ?? 1
    // bump an existing unchecked line instead of duplicating it
    const existing = db
      .select()
      .from(shoppingItems)
      .where(and(eq(shoppingItems.nameKey, nameKey), eq(shoppingItems.checked, false)))
      .get()
    if (existing) {
      db.update(shoppingItems)
        .set({ quantity: existing.quantity + quantity, note: input.note ?? existing.note })
        .where(eq(shoppingItems.id, existing.id))
        .run()
      return shoppingDto(db.select().from(shoppingItems).where(eq(shoppingItems.id, existing.id)).get()!)
    }
    const id = uuidv7()
    const [{ value: maxSort }] = db.select({ value: max(shoppingItems.sortOrder) }).from(shoppingItems).all()
    db.insert(shoppingItems)
      .values({
        id,
        name,
        nameKey,
        quantity,
        unit: input.unit ?? null,
        note: input.note ?? null,
        checked: false,
        sortOrder: (maxSort ?? 0) + 1,
        createdAt: now()
      })
      .run()
    return shoppingDto(db.select().from(shoppingItems).where(eq(shoppingItems.id, id)).get()!)
  }

  function shoppingUpdate(input: { id: string; name?: string; quantity?: number; note?: string | null }): ShoppingItemDto {
    const [row] = db.select().from(shoppingItems).where(eq(shoppingItems.id, input.id)).all()
    if (!row) throw notFound('Shopping item')
    const patch: Partial<typeof shoppingItems.$inferInsert> = {}
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw notFound('Shopping item')
      patch.name = name
      patch.nameKey = normalizeItemName(name)
    }
    if (input.quantity !== undefined) patch.quantity = Math.max(0.5, input.quantity)
    if (input.note !== undefined) patch.note = input.note
    db.update(shoppingItems).set(patch).where(eq(shoppingItems.id, input.id)).run()
    return shoppingDto(db.select().from(shoppingItems).where(eq(shoppingItems.id, input.id)).get()!)
  }

  function shoppingToggle(id: string): void {
    const [row] = db.select().from(shoppingItems).where(eq(shoppingItems.id, id)).all()
    if (!row) throw notFound('Shopping item')
    db.update(shoppingItems).set({ checked: !row.checked }).where(eq(shoppingItems.id, id)).run()
  }

  function shoppingRemove(id: string): void {
    const result = db.delete(shoppingItems).where(eq(shoppingItems.id, id)).run()
    if (result.changes === 0) throw notFound('Shopping item')
  }

  function shoppingClearChecked(): void {
    db.delete(shoppingItems).where(eq(shoppingItems.checked, true)).run()
  }

  /** Push every low-stock pantry item onto the shopping list. */
  function shoppingAddLowStock(): { added: number } {
    let added = 0
    for (const item of lowStock()) {
      const onList = db
        .select({ id: shoppingItems.id })
        .from(shoppingItems)
        .where(and(eq(shoppingItems.nameKey, normalizeItemName(item.name)), eq(shoppingItems.checked, false)))
        .get()
      if (onList) continue
      shoppingAdd({ name: item.name, quantity: Math.max(1, item.minQuantity - item.quantity) || 1, unit: item.unit })
      added++
    }
    return { added }
  }

  /** Confirm parsed receipt items into the pantry (quantities are added on top of what's there). */
  function applyReceipt(scanId: string, items: { name: string; quantity: number; unit?: string | null }[]): { updated: number } {
    const [scan] = db.select().from(receiptScans).where(eq(receiptScans.id, scanId)).all()
    if (!scan) throw notFound('Receipt scan')
    let updated = 0
    for (const item of items) {
      if (!item.name.trim() || !(item.quantity > 0)) continue
      pantryAdd({ name: item.name, quantity: item.quantity, unit: item.unit ?? null, source: 'receipt' })
      updated++
    }
    db.update(receiptScans).set({ appliedAt: now() }).where(eq(receiptScans.id, scanId)).run()
    return { updated }
  }

  function listReceipts(): ReceiptScanDto[] {
    return db.select().from(receiptScans).orderBy(asc(receiptScans.scannedAt)).all().map(receiptDto).reverse()
  }

  return {
    getState,
    pantryAdd,
    pantryUpdate,
    pantryAdjust,
    pantryRemove,
    shoppingAdd,
    shoppingUpdate,
    shoppingToggle,
    shoppingRemove,
    shoppingClearChecked,
    shoppingAddLowStock,
    applyReceipt,
    listReceipts
  }
}

export type GroceriesService = ReturnType<typeof createGroceriesService>
