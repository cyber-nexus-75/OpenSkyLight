import { and, asc, eq, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { choreCompletions, chores, starLedger } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { buildRRuleString, parseRRuleString } from '@shared/recurrence/build'
import { expandOccurrences } from '@shared/recurrence/expand'
import type { ChoreCreateInput, ChoreDto, ChoreUpdateInput, DayChoreDto, StarBalanceDto } from '@shared/types'
import { notFound } from './errors'

type ChoreRow = typeof chores.$inferSelect

export function createChoresService(db: AppDb, deviceTz: () => string) {
  /** 2+ ids = rotation chore. null = fixed assignment. */
  function rotationOf(row: ChoreRow): string[] | null {
    if (!row.rotationPersonIds) return null
    try {
      const parsed = JSON.parse(row.rotationPersonIds) as string[]
      return Array.isArray(parsed) && parsed.length >= 2 ? parsed : null
    } catch {
      return null
    }
  }

  /** Who owes this chore on this date: rotation picks by ISO week, else the fixed person. */
  function assigneeFor(row: ChoreRow, date: string): string | null {
    const rotation = rotationOf(row)
    if (rotation) {
      const week = Math.floor(DateTime.fromISO(date, { zone: deviceTz() }).startOf('week').toMillis() / (7 * 24 * 3600 * 1000))
      return rotation[Math.abs(week) % rotation.length]!
    }
    return row.personId
  }

  function toDto(row: ChoreRow): ChoreDto {
    const zone = deviceTz()
    return {
      id: row.id,
      title: row.title,
      icon: row.icon,
      personId: row.personId!,
      rotationPersonIds: rotationOf(row) ?? [],
      starsValue: row.starsValue,
      recurrence: row.scheduleRrule ? parseRRuleString(row.scheduleRrule, zone) : null,
      anchorDate: row.dueDate ?? DateTime.fromISO(row.createdAt).setZone(zone).toISODate()!,
      routine: row.routine,
      active: row.active,
      sortOrder: row.sortOrder
    }
  }

  function list(): ChoreDto[] {
    return db
      .select()
      .from(chores)
      .where(isNull(chores.deletedAt))
      .orderBy(asc(chores.sortOrder), asc(chores.createdAt))
      .all()
      .map(toDto)
  }

  function create(input: ChoreCreateInput): ChoreDto {
    const zone = deviceTz()
    const anchor = input.anchorDate ?? DateTime.now().setZone(zone).toISODate()!
    const id = uuidv7()
    db.insert(chores)
      .values({
        id,
        title: input.title,
        personId: input.personId,
        starsValue: input.starsValue,
        scheduleRrule: input.recurrence ? buildRRuleString(input.recurrence, zone) : null,
        dueDate: anchor,
        routine: input.routine ?? null,
        active: true,
        createdAt: isoUtc(DateTime.utc())
      })
      .run()
    const [row] = db.select().from(chores).where(eq(chores.id, id)).all()
    return toDto(row)
  }

  function update(input: ChoreUpdateInput): ChoreDto {
    const zone = deviceTz()
    const patch: Partial<typeof chores.$inferInsert> = {}
    if (input.title !== undefined) patch.title = input.title
    if (input.personId !== undefined) patch.personId = input.personId
    if (input.rotationPersonIds !== undefined) {
      patch.rotationPersonIds =
        input.rotationPersonIds.length >= 2 ? JSON.stringify(input.rotationPersonIds) : null
    }
    if (input.starsValue !== undefined) patch.starsValue = input.starsValue
    if (input.recurrence !== undefined) {
      patch.scheduleRrule = input.recurrence ? buildRRuleString(input.recurrence, zone) : null
    }
    if (input.anchorDate !== undefined) patch.dueDate = input.anchorDate
    if (input.routine !== undefined) patch.routine = input.routine
    if (input.active !== undefined) patch.active = input.active
    const result = db
      .update(chores)
      .set(patch)
      .where(and(eq(chores.id, input.id), isNull(chores.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Chore')
    const [row] = db.select().from(chores).where(eq(chores.id, input.id)).all()
    return toDto(row)
  }

  function remove(id: string): void {
    const result = db
      .update(chores)
      .set({ deletedAt: isoUtc(DateTime.utc()) })
      .where(and(eq(chores.id, id), isNull(chores.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Chore')
  }

  /** Is this chore due on the given local calendar date? */
  function isDueOn(row: ChoreRow, date: string): boolean {
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

  function getDay(date: string): DayChoreDto[] {
    const rows = db
      .select()
      .from(chores)
      .where(and(isNull(chores.deletedAt), eq(chores.active, true)))
      .orderBy(asc(chores.sortOrder), asc(chores.createdAt))
      .all()
    const done = new Set(
      db.select().from(choreCompletions).where(eq(choreCompletions.dueDate, date)).all().map((c) => c.choreId)
    )
    const routineOrder = { morning: 0, null: 1, evening: 2 } as Record<string, number>
    return rows
      .filter((row) => isDueOn(row, date))
      .map((row) => ({
        choreId: row.id,
        title: row.title,
        icon: row.icon,
        personId: assigneeFor(row, date)!,
        starsValue: row.starsValue,
        routine: row.routine,
        completed: done.has(row.id)
      }))
      .filter((d) => d.personId !== null)
      .sort((a, b) => routineOrder[String(a.routine)] - routineOrder[String(b.routine)])
  }

  function balanceOf(personId: string): number {
    const rows = db.select().from(starLedger).where(eq(starLedger.personId, personId)).all()
    return rows.reduce((acc, r) => acc + r.delta, 0)
  }

  function balances(): StarBalanceDto[] {
    const totals = new Map<string, number>()
    for (const row of db.select().from(starLedger).all()) {
      totals.set(row.personId, (totals.get(row.personId) ?? 0) + row.delta)
    }
    return [...totals.entries()].map(([personId, balance]) => ({ personId, balance }))
  }

  function complete(choreId: string, date: string): { balance: number } {
    const [chore] = db.select().from(chores).where(and(eq(chores.id, choreId), isNull(chores.deletedAt))).all()
    const assignee = chore ? assigneeFor(chore, date) : null
    if (!chore || !assignee) throw notFound('Chore')
    const [existing] = db
      .select()
      .from(choreCompletions)
      .where(and(eq(choreCompletions.choreId, choreId), eq(choreCompletions.dueDate, date)))
      .all()
    if (!existing) {
      const completionId = uuidv7()
      const now = isoUtc(DateTime.utc())
      db.transaction((tx) => {
        tx.insert(choreCompletions)
          .values({
            id: completionId,
            choreId,
            personId: assignee,
            dueDate: date,
            completedAt: now,
            starsAwarded: chore.starsValue
          })
          .run()
        if (chore.starsValue > 0) {
          tx.insert(starLedger)
            .values({
              id: uuidv7(),
              personId: assignee,
              delta: chore.starsValue,
              reason: 'chore',
              refId: completionId,
              createdAt: now
            })
            .run()
        }
      })
    }
    return { balance: balanceOf(assignee) }
  }

  function uncomplete(choreId: string, date: string): { balance: number } {
    const [chore] = db.select().from(chores).where(eq(chores.id, choreId)).all()
    if (!chore || !chore.personId) throw notFound('Chore')
    const [completion] = db
      .select()
      .from(choreCompletions)
      .where(and(eq(choreCompletions.choreId, choreId), eq(choreCompletions.dueDate, date)))
      .all()
    if (completion) {
      db.transaction((tx) => {
        tx.delete(starLedger).where(eq(starLedger.refId, completion.id)).run()
        tx.delete(choreCompletions).where(eq(choreCompletions.id, completion.id)).run()
      })
    }
    return { balance: balanceOf(chore.personId) }
  }

  return { list, create, update, remove, getDay, complete, uncomplete, balances, balanceOf }
}

export type ChoresService = ReturnType<typeof createChoresService>
