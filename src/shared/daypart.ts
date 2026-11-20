import { DateTime } from 'luxon'
import type { ChoreRoutine } from './types'

export type DayPart = 'morning' | 'afternoon' | 'evening'

/** Local hour boundaries: morning < 12, afternoon < 17, evening after. */
export function partOfDay(now: DateTime): DayPart {
  const hour = now.hour
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

/** Map a routine bucket to its day part; null (anytime) matches every part. */
export function routinePart(routine: ChoreRoutine): DayPart | null {
  return routine
}
