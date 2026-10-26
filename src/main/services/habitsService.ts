import { and, asc, eq, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { habitCompletions, habits } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { buildRRuleString, parseRRuleString } from '@shared/recurrence/build'
import { expandOccurrences } from '@shared/recurrence/expand'
import type { HabitCreateInput, HabitDto, HabitUpdateInput, DayHabitDto } from '@shared/types'
import { notFound } from './errors'

type HabitRow = typeof habits.$inferSelect

/** How far back streaks are computed — guards against pathological recurrences. */
const STREAK_LOOKBACK_DAYS = 366

export function createHabitsService(db: AppDb, deviceTz: () => string) {
  function toDto(row: HabitRow): HabitDto {
    const zone = deviceTz()
    return {
      id: row.id,
      title: row.title,
      icon: row.icon,
      personId: row.personId!,
      recurrence: row.scheduleRrule ? parseRRuleString(row.scheduleRrule, zone) : null,
      anchorDate: row.dueDate ?? DateTime.fromISO(row.createdAt).setZone(zone).toISODate()!,
      routine: row.routine,
      active: row.active,
      sortOrder: row.sortOrder
    }
  }

  function list(): HabitDto[] {
    return db
      .select()
      .from(habits)
      .where(isNull(habits.deletedAt))
      .orderBy(asc(habits.sortOrder), asc(habits.createdAt))
      .all()
      .map(toDto)
  }

  function create(input: HabitCreateInput): HabitDto {
    const zone = deviceTz()
    const anchor = input.anchorDate ?? DateTime.now().setZone(zone).toISODate()!
    const id = uuidv7()
    db.insert(habits)
      .values({
        id,
        title: input.title,
        personId: input.personId,
        scheduleRrule: input.recurrence ? buildRRuleString(input.recurrence, zone) : null,
        dueDate: anchor,
        routine: input.routine ?? null,
        active: true,
        createdAt: isoUtc(DateTime.utc())
      })
      .run()
    const [row] = db.select().from(habits).where(eq(habits.id, id)).all()
    return toDto(row)
  }

  function update(input: HabitUpdateInput): HabitDto {
    const zone = deviceTz()
    const patch: Partial<typeof habits.$inferInsert> = {}
    if (input.title !== undefined) patch.title = input.title
    if (input.personId !== undefined) patch.personId = input.personId
    if (input.recurrence !== undefined) {
      patch.scheduleRrule = input.recurrence ? buildRRuleString(input.recurrence, zone) : null
    }
    if (input.anchorDate !== undefined) patch.dueDate = input.anchorDate
    if (input.routine !== undefined) patch.routine = input.routine
    if (input.active !== undefined) patch.active = input.active
    const result = db
      .update(habits)
      .set(patch)
      .where(and(eq(habits.id, input.id), isNull(habits.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Habit')
    const [row] = db.select().from(habits).where(eq(habits.id, input.id)).all()
    return toDto(row)
  }

  function remove(id: string): void {
    const result = db
      .update(habits)
      .set({ deletedAt: isoUtc(DateTime.utc()) })
      .where(and(eq(habits.id, id), isNull(habits.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Habit')
  }

  /** Is this habit due on the given local calendar date? */
  function isDueOn(row: HabitRow, date: string): boolean {
    const zone = deviceTz()
    const anchor = row.dueDate ?? DateTime.fromISO(row.createdAt).setZone(zone).toISODate()!
    if (!row.scheduleRrule) return anchor === date
    if (date < anchor) return false
    const dayStart = DateTime.fromISO(date, { zone }).startOf('day')
    const occurrences = expandOccurrences(
      {
        id: row.id,
        startAt: isoUtc(DateTime.fromISO(anchor, { zone }).startOf('day')),
        endAt: isoUtc(DateTime.fromISO(anchor, { zone }).startOf('day').plus({ days: 1 })),
        tz: zone,
        allDay: true,
        rrule: row.scheduleRrule,
        rdates: null,
        exdates: null
      },
      [],
      isoUtc(dayStart),
      isoUtc(dayStart.plus({ days: 1 }))
    )
    return occurrences.some((o) => DateTime.fromISO(o.start, { zone: 'utc' }).setZone(zone).toISODate() === date)
  }

  /**
   * Streak = consecutive due days completed, counting backwards from `date`
   * (the queried day counts when completed). Days the habit is not due on are
   * skipped, not broken — weekly habits streak across their off days.
   */
  function streakOf(row: HabitRow, completedDates: Set<string>, date: string): number {
    const zone = deviceTz()
    let streak = 0
    let cursor = DateTime.fromISO(date, { zone }).startOf('day')
    const earliest = cursor.minus({ days: STREAK_LOOKBACK_DAYS })
    while (cursor >= earliest) {
      const key = cursor.toISODate()!
      if (isDueOn(row, key)) {
        if (completedDates.has(key)) streak++
        else break
      }
      cursor = cursor.minus({ days: 1 })
    }
    return streak
  }

  function getDay(date: string): DayHabitDto[] {
    const rows = db
      .select()
      .from(habits)
      .where(and(isNull(habits.deletedAt), eq(habits.active, true)))
      .orderBy(asc(habits.sortOrder), asc(habits.createdAt))
      .all()
    const completions = db.select().from(habitCompletions).all()
    const byHabit = new Map<string, { dates: Set<string>; count: number }>()
    for (const c of completions) {
      const entry = byHabit.get(c.habitId) ?? { dates: new Set<string>(), count: 0 }
      entry.dates.add(c.dueDate)
      entry.count++
      byHabit.set(c.habitId, entry)
    }
    const routineOrder = { morning: 0, null: 1, evening: 2 } as Record<string, number>
    return rows
      .filter((row) => row.personId && isDueOn(row, date))
      .map((row) => {
        const entry = byHabit.get(row.id)
        return {
          habitId: row.id,
          title: row.title,
          icon: row.icon,
          personId: row.personId!,
          routine: row.routine,
          completed: entry?.dates.has(date) ?? false,
          streak: streakOf(row, entry?.dates ?? new Set<string>(), date),
          totalDone: entry?.count ?? 0
        }
      })
      .sort((a, b) => routineOrder[String(a.routine)] - routineOrder[String(b.routine)])
  }

  function complete(habitId: string, date: string): void {
    const [habit] = db.select().from(habits).where(and(eq(habits.id, habitId), isNull(habits.deletedAt))).all()
    if (!habit) throw notFound('Habit')
    const [existing] = db
      .select()
      .from(habitCompletions)
      .where(and(eq(habitCompletions.habitId, habitId), eq(habitCompletions.dueDate, date)))
      .all()
    if (!existing) {
      db.insert(habitCompletions)
        .values({
          id: uuidv7(),
          habitId,
          dueDate: date,
          completedAt: isoUtc(DateTime.utc())
        })
        .run()
    }
  }

  function uncomplete(habitId: string, date: string): void {
    const [habit] = db.select().from(habits).where(eq(habits.id, habitId)).all()
    if (!habit) throw notFound('Habit')
    db.delete(habitCompletions)
      .where(and(eq(habitCompletions.habitId, habitId), eq(habitCompletions.dueDate, date)))
      .run()
  }

  return { list, create, update, remove, getDay, complete, uncomplete }
}

export type HabitsService = ReturnType<typeof createHabitsService>
