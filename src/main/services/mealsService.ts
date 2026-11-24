import { and, asc, eq, gte, inArray, isNull, lte, max } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { mealSlotPeople, mealSlots, recipes } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import type { ListDto, MealSlotDto, MealSlotKind, RecipeCreateInput, RecipeDto, RecipeUpdateInput } from '@shared/types'
import type { ListsService } from './listsService'
import { invalid, notFound } from './errors'

type MealRow = typeof mealSlots.$inferSelect
type RecipeRow = typeof recipes.$inferSelect

export interface SetInput {
  text: string | null
  recipeId?: string | null
  personIds?: string[]
}

function recipeDto(row: RecipeRow): RecipeDto {
  let ingredients: string[] = []
  let tags: string[] = []
  try {
    ingredients = row.ingredients ? (JSON.parse(row.ingredients) as string[]) : []
  } catch {
    ingredients = []
  }
  try {
    tags = row.tags ? (JSON.parse(row.tags) as string[]) : []
  } catch {
    tags = []
  }
  return { id: row.id, title: row.title, ingredients, instructions: row.instructions, tags, sourceUrl: null }
}

export function createMealsService(db: AppDb, lists: ListsService) {
  function peopleFor(mealIds: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>()
    if (mealIds.length === 0) return map
    for (const row of db.select().from(mealSlotPeople).where(inArray(mealSlotPeople.mealSlotId, mealIds)).all()) {
      const arr = map.get(row.mealSlotId) ?? []
      arr.push(row.personId)
      map.set(row.mealSlotId, arr)
    }
    return map
  }

  function slotDto(row: MealRow, recipeRows: RecipeRow[], people: Map<string, string[]>): MealSlotDto {
    const recipe = row.recipeId ? recipeRows.find((r) => r.id === row.recipeId) : undefined
    const text = row.freeText?.trim() ? row.freeText : (recipe?.title ?? '')
    return {
      id: row.id,
      date: row.date,
      slot: row.slot,
      text,
      recipeId: row.recipeId,
      personIds: people.get(row.id) ?? [],
      sortOrder: row.sortOrder
    }
  }

  /** Inclusive date range of meal entries (free text or recipe-linked). */
  function getRange(start: string, end: string): MealSlotDto[] {
    const rows = db
      .select()
      .from(mealSlots)
      .where(and(gte(mealSlots.date, start), lte(mealSlots.date, end)))
      .orderBy(asc(mealSlots.date), asc(mealSlots.sortOrder), asc(mealSlots.slot))
      .all()
    const recipeIds = [...new Set(rows.map((r) => r.recipeId).filter((id): id is string => !!id))]
    const recipeRows = recipeIds.length
      ? db.select().from(recipes).where(inArray(recipes.id, recipeIds)).all()
      : []
    const people = peopleFor(rows.map((r) => r.id))
    return rows
      .filter((r) => (r.freeText ?? '').trim().length > 0 || r.recipeId)
      .map((r) => slotDto(r, recipeRows, people))
  }

  function set(date: string, slot: MealSlotKind, input: SetInput): void {
    const text = (input.text ?? '').trim()
    const recipeId = input.recipeId ?? null
    if (!text && !recipeId) {
      const [existing] = db.select().from(mealSlots).where(and(eq(mealSlots.date, date), eq(mealSlots.slot, slot))).all()
      if (existing) {
        db.delete(mealSlotPeople).where(eq(mealSlotPeople.mealSlotId, existing.id)).run()
        db.delete(mealSlots).where(eq(mealSlots.id, existing.id)).run()
      }
      return
    }
    if (recipeId) {
      const [recipe] = db.select().from(recipes).where(and(eq(recipes.id, recipeId), isNull(recipes.deletedAt))).all()
      if (!recipe) throw notFound('Recipe')
    }
    const [existing] = db.select().from(mealSlots).where(and(eq(mealSlots.date, date), eq(mealSlots.slot, slot))).all()
    const id = existing?.id ?? uuidv7()
    if (existing) {
      db.update(mealSlots)
        .set({ freeText: text || null, recipeId })
        .where(eq(mealSlots.id, existing.id))
        .run()
    } else {
      const [{ value: maxSort }] = db.select({ value: max(mealSlots.sortOrder) }).from(mealSlots).all()
      db.insert(mealSlots)
        .values({ id, date, slot, freeText: text || null, recipeId, sortOrder: (maxSort ?? 0) + 1 })
        .run()
    }
    if (input.personIds) {
      db.delete(mealSlotPeople).where(eq(mealSlotPeople.mealSlotId, id)).run()
      for (const personId of [...new Set(input.personIds)]) {
        db.insert(mealSlotPeople).values({ mealSlotId: id, personId }).run()
      }
    }
  }

  /** Move a meal to another day/slot; swaps with the occupant if the target is taken. */
  function move(id: string, date: string, slot: MealSlotKind): void {
    const [row] = db.select().from(mealSlots).where(eq(mealSlots.id, id)).all()
    if (!row) throw notFound('Meal')
    if (row.date === date && row.slot === slot) return
    const [occupant] = db
      .select()
      .from(mealSlots)
      .where(and(eq(mealSlots.date, date), eq(mealSlots.slot, slot)))
      .all()
    if (occupant && occupant.id !== id) {
      // three-step swap: UNIQUE(date, slot) forbids moving onto an occupied cell directly
      db.transaction((tx) => {
        tx.update(mealSlots).set({ date: '__swap__' }).where(eq(mealSlots.id, id)).run()
        tx.update(mealSlots).set({ date: row.date, slot: row.slot }).where(eq(mealSlots.id, occupant.id)).run()
        tx.update(mealSlots).set({ date, slot }).where(eq(mealSlots.id, id)).run()
      })
    } else {
      db.update(mealSlots).set({ date, slot }).where(eq(mealSlots.id, id)).run()
    }
  }

  /** Append a meal's recipe ingredients to a list (default: first grocery list, else a new "Groceries"). */
  function addIngredients(mealSlotId: string, listId?: string): { added: number } {
    const [slotRow] = db.select().from(mealSlots).where(eq(mealSlots.id, mealSlotId)).all()
    if (!slotRow?.recipeId) throw invalid('Meal has no linked recipe')
    const [recipe] = db.select().from(recipes).where(and(eq(recipes.id, slotRow.recipeId), isNull(recipes.deletedAt))).all()
    if (!recipe) throw notFound('Recipe')
    const ingredients = recipeDto(recipe).ingredients
    if (ingredients.length === 0) return { added: 0 }

    let target: ListDto | undefined
    if (listId) {
      target = lists.getAll().find((l) => l.id === listId)
      if (!target) throw notFound('List')
    } else {
      target = lists.getAll().find((l) => l.kind === 'grocery') ?? lists.create({ name: 'Groceries', color: '#46A758', kind: 'grocery' })
    }
    const existing = new Set(target.items.map((i) => i.text.trim().toLowerCase()))
    let added = 0
    for (const ingredient of ingredients) {
      const key = ingredient.trim().toLowerCase()
      if (!key || existing.has(key)) continue
      lists.addItem(target.id, ingredient.trim())
      existing.add(key)
      added++
    }
    return { added }
  }

  function listRecipes(): RecipeDto[] {
    return db
      .select()
      .from(recipes)
      .where(isNull(recipes.deletedAt))
      .orderBy(asc(recipes.title))
      .all()
      .map(recipeDto)
  }

  function createRecipe(input: RecipeCreateInput): RecipeDto {
    const id = uuidv7()
    db.insert(recipes)
      .values({
        id,
        title: input.title.trim(),
        ingredients: JSON.stringify(input.ingredients ?? []),
        instructions: input.instructions ?? null,
        tags: JSON.stringify(input.tags ?? []),
        createdAt: isoUtc(DateTime.utc())
      })
      .run()
    const [row] = db.select().from(recipes).where(eq(recipes.id, id)).all()
    return recipeDto(row)
  }

  function updateRecipe(input: RecipeUpdateInput): RecipeDto {
    const patch: Partial<typeof recipes.$inferInsert> = {}
    if (input.title !== undefined) patch.title = input.title.trim()
    if (input.ingredients !== undefined) patch.ingredients = JSON.stringify(input.ingredients)
    if (input.instructions !== undefined) patch.instructions = input.instructions
    if (input.tags !== undefined) patch.tags = JSON.stringify(input.tags)
    const result = db
      .update(recipes)
      .set(patch)
      .where(and(eq(recipes.id, input.id), isNull(recipes.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Recipe')
    const [row] = db.select().from(recipes).where(eq(recipes.id, input.id)).all()
    return recipeDto(row)
  }

  function removeRecipe(id: string): void {
    const result = db
      .update(recipes)
      .set({ deletedAt: isoUtc(DateTime.utc()) })
      .where(and(eq(recipes.id, id), isNull(recipes.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Recipe')
  }

  return { getRange, set, move, addIngredients, listRecipes, createRecipe, updateRecipe, removeRecipe }
}

export type MealsService = ReturnType<typeof createMealsService>
