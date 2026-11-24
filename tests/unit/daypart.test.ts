import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { partOfDay, routinePart } from '../../src/shared/daypart'

const at = (hour: number) => DateTime.fromISO('2026-06-10', { zone: 'America/Chicago' }).set({ hour, minute: 0 })

describe('daypart', () => {
  it('splits the day into morning / afternoon / evening', () => {
    expect(partOfDay(at(0))).toBe('morning')
    expect(partOfDay(at(11))).toBe('morning')
    expect(partOfDay(at(12))).toBe('afternoon')
    expect(partOfDay(at(16))).toBe('afternoon')
    expect(partOfDay(at(17))).toBe('evening')
    expect(partOfDay(at(23))).toBe('evening')
  })

  it('maps routines to their part; anytime matches all', () => {
    expect(routinePart('morning')).toBe('morning')
    expect(routinePart('afternoon')).toBe('afternoon')
    expect(routinePart('evening')).toBe('evening')
    expect(routinePart(null)).toBeNull()
  })
})
