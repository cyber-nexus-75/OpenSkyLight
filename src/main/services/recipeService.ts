import { DateTime } from 'luxon'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { recipes } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import type { RecipeDto } from '@shared/types'
import { AppError, invalid, notFound } from './errors'

/**
 * Recipe import: fetches a recipe page and extracts schema.org/Recipe
 * JSON-LD — the structured-data format most recipe sites embed. Pure
 * parsing (extractRecipeJsonLd) is unit-testable without network.
 */

export interface ParsedRecipe {
  title: string
  ingredients: string[]
  instructions: string | null
  tags: string[]
}

/** Find and parse the first schema.org Recipe in a page's JSON-LD blocks. */
export function extractRecipeJsonLd(html: string): ParsedRecipe | null {
  // collect every <script type="application/ld+json"> block
  const blocks: string[] = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) blocks.push(m[1]!)

  const visit = (node: unknown): ParsedRecipe | null => {
    if (node === null || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item)
        if (found) return found
      }
      return null
    }
    const rec = node as Record<string, unknown>
    const types = rec['@type']
    const typeList = Array.isArray(types) ? types.map(String) : [String(types ?? '')]
    if (typeList.some((t) => t.toLowerCase() === 'recipe')) {
      const name = rec.name
      if (typeof name !== 'string' || !name.trim()) return null
      const recipeIngredient = rec.recipeIngredient ?? rec.ingredients
      const ingredients = (Array.isArray(recipeIngredient) ? recipeIngredient : [recipeIngredient])
        .filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
      const recipeInstructions = rec.recipeInstructions
      let instructions: string | null = null
      if (typeof recipeInstructions === 'string') {
        instructions = recipeInstructions
      } else if (Array.isArray(recipeInstructions)) {
        instructions = recipeInstructions
          .map((step) =>
            typeof step === 'string'
              ? step
              : typeof step === 'object' && step !== null && 'text' in step
                ? String((step as Record<string, unknown>).text)
                : ''
          )
          .filter(Boolean)
          .join('\n')
      }
      const keywords = rec.keywords
      const tags = (typeof keywords === 'string' ? keywords.split(',') : Array.isArray(keywords) ? keywords : [])
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 8)
      return { title: name.trim(), ingredients, instructions, tags }
    }
    // @graph wrapper
    const graph = rec['@graph']
    if (graph) {
      const found = visit(graph)
      if (found) return found
    }
    return null
  }

  for (const block of blocks) {
    try {
      const found = visit(JSON.parse(block))
      if (found) return found
    } catch {
      // malformed block — try the next
    }
  }
  return null
}

export function createRecipeService(db: AppDb) {
  function toDto(row: typeof recipes.$inferSelect): RecipeDto {
    return {
      id: row.id,
      title: row.title,
      ingredients: safeParse(row.ingredients),
      instructions: row.instructions,
      tags: safeParse(row.tags),
      sourceUrl: null
    }
  }

  function list(): RecipeDto[] {
    return db
      .select()
      .from(recipes)
      .where(isNull(recipes.deletedAt))
      .orderBy(desc(recipes.createdAt))
      .all()
      .map(toDto)
  }

  async function importUrl(url: string): Promise<RecipeDto> {
    if (!/^https?:\/\//i.test(url)) throw invalid('Recipe URLs must be http(s)')
    let res: Response
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OpenSkyLight/1.0)' },
        signal: AbortSignal.timeout(15_000)
      })
    } catch {
      throw new AppError('RECIPE_FETCH', 'Could not reach that URL')
    }
    if (!res.ok) throw new AppError('RECIPE_FETCH', `The site returned HTTP ${res.status}`)
    const html = await res.text()
    const parsed = extractRecipeJsonLd(html)
    if (!parsed) {
      throw new AppError('RECIPE_PARSE', 'No recipe found on that page (the site may not use structured recipe data)')
    }
    const id = uuidv7()
    db.insert(recipes)
      .values({
        id,
        title: parsed.title,
        ingredients: JSON.stringify(parsed.ingredients),
        instructions: parsed.instructions,
        tags: JSON.stringify(parsed.tags),
        createdAt: isoUtc(DateTime.utc())
      })
      .run()
    const [row] = db.select().from(recipes).where(eq(recipes.id, id)).all()
    return { ...toDto(row), sourceUrl: url }
  }

  function remove(id: string): void {
    const result = db
      .update(recipes)
      .set({ deletedAt: isoUtc(DateTime.utc()) })
      .where(and(eq(recipes.id, id), isNull(recipes.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Recipe')
  }

  return { list, importUrl, remove }
}

export type RecipeService = ReturnType<typeof createRecipeService>

function safeParse(s: string | null): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
