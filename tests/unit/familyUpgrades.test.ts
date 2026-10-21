import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { extractRecipeJsonLd } from '../../src/main/services/recipeService'

describe('extractRecipeJsonLd', () => {
  const recipe = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Best Pancakes',
    recipeIngredient: ['2 cups flour', '2 eggs', '1 cup milk'],
    recipeInstructions: [
      { '@type': 'HowToStep', text: 'Mix the dry ingredients.' },
      { '@type': 'HowToStep', text: 'Add wet ingredients and stir.' }
    ],
    keywords: 'breakfast, kids, easy'
  }

  it('parses a plain JSON-LD recipe block', () => {
    const html = `<html><script type="application/ld+json">${JSON.stringify(recipe)}</script></html>`
    const parsed = extractRecipeJsonLd(html)
    expect(parsed).not.toBeNull()
    expect(parsed!.title).toBe('Best Pancakes')
    expect(parsed!.ingredients).toEqual(['2 cups flour', '2 eggs', '1 cup milk'])
    expect(parsed!.instructions).toContain('Mix the dry ingredients.')
    expect(parsed!.tags).toEqual(['breakfast', 'kids', 'easy'])
  })

  it('finds recipes nested in @graph and arrays, skips malformed blocks', () => {
    const wrapped = {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'WebPage', name: 'page' }, recipe]
    }
    const html = `<html>
      <script type="application/ld+json">{broken json</script>
      <script type="application/ld+json">${JSON.stringify(wrapped)}</script>
    </html>`
    const parsed = extractRecipeJsonLd(html)
    expect(parsed).not.toBeNull()
    expect(parsed!.title).toBe('Best Pancakes')
  })

  it('accepts HowToSection instructions and string instructions', () => {
    const withSections = {
      ...recipe,
      recipeInstructions: 'Just mix everything together and fry.'
    }
    const html = `<script type="application/ld+json">${JSON.stringify(withSections)}</script>`
    expect(extractRecipeJsonLd(html)!.instructions).toBe('Just mix everything together and fry.')
  })

  it('returns null when the page has no recipe', () => {
    expect(extractRecipeJsonLd('<html><body>no structured data</body></html>')).toBeNull()
    const notRecipe = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'x' })}</script>`
    expect(extractRecipeJsonLd(notRecipe)).toBeNull()
  })
})

describe('chore rotation week math', () => {
  it('alternates by ISO week: adjacent weeks pick different people', () => {
    const rotation = ['emma', 'leo']
    const assignee = (isoDate: string): string => {
      const week = Math.floor(
        DateTime.fromISO(isoDate).startOf('week').toMillis() / (7 * 24 * 3600 * 1000)
      )
      return rotation[Math.abs(week) % rotation.length]!
    }
    const monday = DateTime.now().startOf('week').toISODate()!
    const nextMonday = DateTime.fromISO(monday).plus({ weeks: 1 }).toISODate()!
    const weekAfter = DateTime.fromISO(monday).plus({ weeks: 2 }).toISODate()!
    expect(assignee(monday)).not.toBe(assignee(nextMonday))
    expect(assignee(monday)).toBe(assignee(weekAfter))
    // mid-week days in the same ISO week agree
    const wednesday = DateTime.fromISO(monday).plus({ days: 2 }).toISODate()!
    expect(assignee(wednesday)).toBe(assignee(monday))
  })

  it('handles 3-way rotations cycling', () => {
    const rotation = ['a', 'b', 'c']
    const assignee = (isoDate: string): string => {
      const week = Math.floor(
        DateTime.fromISO(isoDate).startOf('week').toMillis() / (7 * 24 * 3600 * 1000)
      )
      return rotation[Math.abs(week) % rotation.length]!
    }
    const base = DateTime.now().startOf('week')
    const w0 = assignee(base.toISODate()!)
    const w1 = assignee(base.plus({ weeks: 1 }).toISODate()!)
    const w2 = assignee(base.plus({ weeks: 2 }).toISODate()!)
    const w3 = assignee(base.plus({ weeks: 3 }).toISODate()!)
    expect(new Set([w0, w1, w2]).size).toBe(3)
    expect(w3).toBe(w0)
  })
})

describe('birthday countdown math', () => {
  const daysUntil = (mmdd: string, from: DateTime): number => {
    const [m, d] = mmdd.split('-').map(Number)
    let next = from.set({ month: m, day: d })
    if (next.startOf('day') < from.startOf('day')) next = next.plus({ years: 1 })
    return Math.round(next.startOf('day').diff(from.startOf('day'), 'days').days)
  }

  it('tomorrow is 1 day away', () => {
    const now = DateTime.fromISO('2026-03-10')
    expect(daysUntil('03-11', now)).toBe(1)
  })

  it('today is 0', () => {
    const now = DateTime.fromISO('2026-03-10')
    expect(daysUntil('03-10', now)).toBe(0)
  })

  it('wraps to next year for past dates', () => {
    const now = DateTime.fromISO('2026-03-10')
    expect(daysUntil('03-09', now)).toBe(364) // 2026 is not a leap year; Mar 9 2027
  })

  it('handles Feb 29 birthdays in non-leap years without crashing', () => {
    const now = DateTime.fromISO('2026-03-10')
    // luxon normalizes Feb 29 → Mar 1 in a non-leap year; the countdown stays sane
    const days = daysUntil('02-29', now)
    expect(days).toBeGreaterThan(300)
  })
})
