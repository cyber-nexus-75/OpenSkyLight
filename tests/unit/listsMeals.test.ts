import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../../src/main/db/client'
import { createListsService, type ListsService } from '../../src/main/services/listsService'
import { createMealsService, type MealsService } from '../../src/main/services/mealsService'

describe('lists', () => {
  let handle: DbHandle
  let lists: ListsService

  beforeEach(() => {
    handle = openDatabase(':memory:')
    lists = createListsService(handle.db)
  })

  it('creates lists and adds items in order', () => {
    const list = lists.create({ name: 'Groceries', color: '#46A758', kind: 'grocery' })
    lists.addItem(list.id, 'Milk')
    lists.addItem(list.id, 'Eggs')
    const [loaded] = lists.getAll()
    expect(loaded.items.map((i) => i.text)).toEqual(['Milk', 'Eggs'])
  })

  it('toggling sinks checked items to the bottom', () => {
    const list = lists.create({ name: 'Groceries', color: '#46A758', kind: 'grocery' })
    const milk = lists.addItem(list.id, 'Milk')
    lists.addItem(list.id, 'Eggs')
    lists.toggleItem(milk.id)
    const [loaded] = lists.getAll()
    expect(loaded.items.map((i) => i.text)).toEqual(['Eggs', 'Milk'])
    expect(loaded.items[1].checked).toBe(true)
    lists.toggleItem(milk.id)
    expect(lists.getAll()[0].items[0].checked).toBe(false)
  })

  it('clearChecked removes only checked items', () => {
    const list = lists.create({ name: 'Todo', color: '#0091FF', kind: 'todo' })
    const a = lists.addItem(list.id, 'A')
    lists.addItem(list.id, 'B')
    lists.toggleItem(a.id)
    lists.clearChecked(list.id)
    const [loaded] = lists.getAll()
    expect(loaded.items.map((i) => i.text)).toEqual(['B'])
  })

  it('soft-deletes lists', () => {
    const list = lists.create({ name: 'Temp', color: '#0091FF', kind: 'custom' })
    lists.remove(list.id)
    expect(lists.getAll()).toHaveLength(0)
  })
})

describe('meals', () => {
  let handle: DbHandle
  let lists: ListsService
  let meals: MealsService

  beforeEach(() => {
    handle = openDatabase(':memory:')
    lists = createListsService(handle.db)
    meals = createMealsService(handle.db, lists)
    handle.sqlite
      .prepare(
        "INSERT INTO people (id, name, color, role, sort_order, created_at) VALUES ('kid1','Emma','#46A758','child',0,'2026-01-01T00:00:00Z')"
      )
      .run()
  })

  it('sets, overwrites, and clears slots with one row per (date, slot)', () => {
    meals.set('2026-06-10', 'dinner', { text: 'Tacos' })
    meals.set('2026-06-10', 'dinner', { text: 'Pizza' })
    meals.set('2026-06-10', 'lunch', { text: 'Sandwiches' })
    expect(meals.getRange('2026-06-10', '2026-06-10')).toHaveLength(2)
    expect(meals.getRange('2026-06-10', '2026-06-10').find((m) => m.slot === 'dinner')?.text).toBe('Pizza')
    meals.set('2026-06-10', 'dinner', { text: null })
    expect(meals.getRange('2026-06-10', '2026-06-10')).toHaveLength(1)
  })

  it('range queries are inclusive and date-scoped', () => {
    meals.set('2026-06-08', 'dinner', { text: 'Soup' })
    meals.set('2026-06-14', 'dinner', { text: 'Stew' })
    meals.set('2026-06-15', 'dinner', { text: 'Out of range' })
    const week = meals.getRange('2026-06-08', '2026-06-14')
    expect(week.map((m) => m.text).sort()).toEqual(['Soup', 'Stew'])
  })
})

describe('meals upgrades (M6)', () => {
  let handle: DbHandle
  let lists: ListsService
  let meals: MealsService

  beforeEach(() => {
    handle = openDatabase(':memory:')
    lists = createListsService(handle.db)
    meals = createMealsService(handle.db, lists)
    for (const [id, name, color] of [
      ['kid1', 'Emma', '#46A758'],
      ['kid2', 'Liam', '#0091FF']
    ] as const) {
      handle.sqlite
        .prepare(
          `INSERT INTO people (id, name, color, role, sort_order, created_at) VALUES (?, ?, ?, 'child', 0, '2026-01-01T00:00:00Z')`
        )
        .run(id, name, color)
    }
  })

  it('recipe CRUD round-trips ingredients and tags', () => {
    const r = meals.createRecipe({ title: 'Tacos', ingredients: ['Tortillas', 'Cheese'], tags: ['dinner'] })
    expect(meals.listRecipes()[0]).toMatchObject({ title: 'Tacos', ingredients: ['Tortillas', 'Cheese'], tags: ['dinner'] })
    meals.updateRecipe({ id: r.id, ingredients: ['Tortillas', 'Cheese', 'Salsa'] })
    expect(meals.listRecipes()[0].ingredients).toHaveLength(3)
    meals.removeRecipe(r.id)
    expect(meals.listRecipes()).toHaveLength(0)
  })

  it('links a meal to a recipe and assigns people; text falls back to the recipe title', () => {
    const r = meals.createRecipe({ title: 'Pancakes', ingredients: ['Flour', 'Eggs'] })
    meals.set('2026-06-10', 'breakfast', { text: null, recipeId: r.id, personIds: ['kid1', 'kid2'] })
    const [m] = meals.getRange('2026-06-10', '2026-06-10')
    expect(m.text).toBe('Pancakes')
    expect(m.recipeId).toBe(r.id)
    expect(m.personIds.sort()).toEqual(['kid1', 'kid2'])
    // re-assigning replaces the set
    meals.set('2026-06-10', 'breakfast', { text: null, recipeId: r.id, personIds: ['kid1'] })
    expect(meals.getRange('2026-06-10', '2026-06-10')[0].personIds).toEqual(['kid1'])
    // clearing removes the row and its assignments
    meals.set('2026-06-10', 'breakfast', { text: null })
    expect(meals.getRange('2026-06-10', '2026-06-10')).toHaveLength(0)
  })

  it('move swaps with an occupied target slot', () => {
    meals.set('2026-06-10', 'dinner', { text: 'A' })
    meals.set('2026-06-11', 'dinner', { text: 'B' })
    const [a] = meals.getRange('2026-06-10', '2026-06-10')
    meals.move(a.id, '2026-06-11', 'dinner')
    const range = meals.getRange('2026-06-10', '2026-06-11')
    expect(range.find((m) => m.date === '2026-06-10' && m.slot === 'dinner')?.text).toBe('B')
    expect(range.find((m) => m.date === '2026-06-11' && m.slot === 'dinner')?.text).toBe('A')
    // moving to an empty slot just moves
    meals.move(a.id, '2026-06-12', 'lunch')
    expect(meals.getRange('2026-06-12', '2026-06-12')[0]).toMatchObject({ slot: 'lunch', text: 'A' })
  })

  it('addIngredients appends deduped ingredients to the grocery list (creating one if needed)', () => {
    const r = meals.createRecipe({ title: 'Soup', ingredients: ['Carrots', 'Celery', 'Carrots'] })
    meals.set('2026-06-10', 'dinner', { text: null, recipeId: r.id })
    const [m] = meals.getRange('2026-06-10', '2026-06-10')
    expect(meals.addIngredients(m.id).added).toBe(2)
    const groceries = lists.getAll().find((l) => l.kind === 'grocery')
    expect(groceries?.name).toBe('Groceries')
    expect(groceries?.items.map((i) => i.text).sort()).toEqual(['Carrots', 'Celery'])
    // second run adds nothing
    expect(meals.addIngredients(m.id).added).toBe(0)
    // explicit list target
    const todo = lists.create({ name: 'Party', color: '#0091FF', kind: 'todo' })
    expect(meals.addIngredients(m.id, todo.id).added).toBe(2)
  })

  it('rejects ingredients for a meal without a recipe', () => {
    meals.set('2026-06-10', 'lunch', { text: 'Leftovers' })
    const [m] = meals.getRange('2026-06-10', '2026-06-10')
    expect(() => meals.addIngredients(m.id)).toThrow(/no linked recipe/)
  })
})
