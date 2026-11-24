import { and, asc, eq, isNull, or } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { choreCompletions, choreLinks, chores, starLedger } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { buildRRuleString, parseRRuleString } from '@shared/recurrence/build'
import { expandOccurrences } from '@shared/recurrence/expand'
import type {
  ChoreCreateInput,
  ChoreDto,
  ChoreUpdateInput,
  DayChoreDto,
  StarBalanceDto,
  TaskItemDto
} from '@shared/types'
import { invalid, notFound } from './errors'

type ChoreRow = typeof chores.$inferSelect
type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0]

export function createChoresService(db: AppDb, deviceTz: () => string) {
  function linksFor(choreId: string, linkRows: (typeof choreLinks.$inferSelect)[]): string[] {
    const ids = new Set<string>()
    for (const l of linkRows) {
      if (l.choreId === choreId) ids.add(l.linkedChoreId)
      else if (l.linkedChoreId === choreId) ids.add(l.choreId)
    }
    ids.delete(choreId)
    return [...ids]
  }


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

  function toDto(row: ChoreRow, linkRows: (typeof choreLinks.$inferSelect)[]): ChoreDto {
    const zone = deviceTz()
    return {
      id: row.id,
      title: row.title,
      icon: row.icon,
      personId: row.personId,
      rotationPersonIds: rotationOf(row) ?? [],
      starsValue: row.starsValue,
      recurrence: row.scheduleRrule ? parseRRuleString(row.scheduleRrule, zone) : null,
      anchorDate: row.dueDate ?? DateTime.fromISO(row.createdAt).setZone(zone).toISODate()!,
      routine: row.routine,
      upForGrabs: row.upForGrabs,
      repeatAfter: row.repeatAfter,
      linkedChoreIds: linksFor(row.id, linkRows),
      active: row.active,
      sortOrder: row.sortOrder
    }
  }

  /** Replace the symmetric link set of a chore (stored in both directions). */
  function setLinks(tx: Tx, choreId: string, linkedIds: string[]): void {
    tx.delete(choreLinks).where(or(eq(choreLinks.choreId, choreId), eq(choreLinks.linkedChoreId, choreId))).run()
    const unique = [...new Set(linkedIds.filter((id) => id !== choreId))]
    const now = isoUtc(DateTime.utc())
    for (const other of unique) {
      tx.insert(choreLinks).values({ id: uuidv7(), choreId, linkedChoreId: other, createdAt: now }).run()
      tx.insert(choreLinks).values({ id: uuidv7(), choreId: other, linkedChoreId: choreId, createdAt: now }).run()
    }
  }

  function allLinks(): (typeof choreLinks.$inferSelect)[] {
    return db.select().from(choreLinks).all()
  }

  function list(): ChoreDto[] {
    const linkRows = allLinks()
    return db
      .select()
      .from(chores)
      .where(isNull(chores.deletedAt))
      .orderBy(asc(chores.sortOrder), asc(chores.createdAt))
      .all()
      .map((row) => toDto(row, linkRows))
  }

  function create(input: ChoreCreateInput): ChoreDto {
    const zone = deviceTz()
    const anchor = input.anchorDate ?? DateTime.now().setZone(zone).toISODate()!
    const upForGrabs = input.upForGrabs ?? false
    if (!upForGrabs && !input.personId) throw invalid('Chore needs a person (or mark it up for grabs)')
    const id = uuidv7()
    db.transaction((tx) => {
      tx.insert(chores)
        .values({
          id,
          title: input.title,
          personId: upForGrabs ? null : input.personId,
          starsValue: input.starsValue,
          scheduleRrule: input.recurrence ? buildRRuleString(input.recurrence, zone) : null,
          dueDate: anchor,
          routine: input.routine ?? null,
          upForGrabs,
          repeatAfter: input.repeatAfter ?? false,
          active: true,
          createdAt: isoUtc(DateTime.utc())
        })
        .run()
      if (input.linkedChoreIds?.length) setLinks(tx, id, input.linkedChoreIds)
    })
    const [row] = db.select().from(chores).where(eq(chores.id, id)).all()
    return toDto(row, allLinks())
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
    if (input.upForGrabs !== undefined) {
      patch.upForGrabs = input.upForGrabs
      if (input.upForGrabs) patch.personId = null
    }
    if (input.repeatAfter !== undefined) patch.repeatAfter = input.repeatAfter
    if (input.active !== undefined) patch.active = input.active
    if (Object.keys(patch).length > 0) {
      const result = db
        .update(chores)
        .set(patch)
        .where(and(eq(chores.id, input.id), isNull(chores.deletedAt)))
        .run()
      if (result.changes === 0) throw notFound('Chore')
    } else {
      const [row] = db.select().from(chores).where(and(eq(chores.id, input.id), isNull(chores.deletedAt))).all()
      if (!row) throw notFound('Chore')
    }
    if (input.linkedChoreIds !== undefined) {
      db.transaction((tx) => setLinks(tx, input.id, input.linkedChoreIds!))
    }
    const [row] = db.select().from(chores).where(eq(chores.id, input.id)).all()
    return toDto(row, allLinks())
  }

  function remove(id: string): void {
    const result = db
      .update(chores)
      .set({ deletedAt: isoUtc(DateTime.utc()) })
      .where(and(eq(chores.id, id), isNull(chores.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Chore')
    db.delete(choreLinks).where(or(eq(choreLinks.choreId, id), eq(choreLinks.linkedChoreId, id))).run()
  }

  /** Is this chore due on the given local calendar date? */
  function isDueOn(row: ChoreRow, date: string): boolean {
    const zone = deviceTz()
    const anchor = row.dueDate ?? DateTime.fromISO(row.createdAt).setZone(zone).toISODate()!
    if (!row.scheduleRrule) return row.repeatAfter ? date >= anchor : anchor === date
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

  function completionsOn(date: string): Map<string, typeof choreCompletions.$inferSelect> {
    const map = new Map<string, typeof choreCompletions.$inferSelect>()
    for (const c of db.select().from(choreCompletions).where(eq(choreCompletions.dueDate, date)).all()) {
      map.set(c.choreId, c)
    }
    return map
  }

  function getDay(date: string): DayChoreDto[] {
    const rows = db
      .select()
      .from(chores)
      .where(and(isNull(chores.deletedAt), eq(chores.active, true)))
      .orderBy(asc(chores.sortOrder), asc(chores.createdAt))
      .all()
    const done = completionsOn(date)
    const routineOrder = { morning: 0, afternoon: 1, null: 2, evening: 3 } as Record<string, number>
    return rows
      .filter((row) => (row.upForGrabs || assigneeFor(row, date) !== null) && isDueOn(row, date))
      .map((row) => {
        const completion = done.get(row.id)
        return {
          choreId: row.id,
          title: row.title,
          icon: row.icon,
          personId: row.upForGrabs ? null : assigneeFor(row, date),
          upForGrabs: row.upForGrabs,
          claimerId: row.upForGrabs ? (completion?.personId ?? null) : null,
          starsValue: row.starsValue,
          routine: row.routine,
          completed: completion !== undefined
        }
      })
      .sort((a, b) => routineOrder[String(a.routine)] - routineOrder[String(b.routine)])
  }

  /** All active chores with today/overdue state — the all-tasks view's data. */
  function getTasks(date: string): TaskItemDto[] {
    const zone = deviceTz()
    const rows = db
      .select()
      .from(chores)
      .where(and(isNull(chores.deletedAt), eq(chores.active, true)))
      .orderBy(asc(chores.sortOrder), asc(chores.createdAt))
      .all()
    const done = completionsOn(date)
    const completionsAll = db.select().from(choreCompletions).all()
    const completedAnchors = new Set(completionsAll.map((c) => `${c.choreId}|${c.dueDate}`))
    return rows.map((row) => {
      const anchor = row.dueDate ?? DateTime.fromISO(row.createdAt).setZone(zone).toISODate()!
      const completion = done.get(row.id)
      const overdue = !row.scheduleRrule && !row.repeatAfter && anchor < date && !completedAnchors.has(`${row.id}|${anchor}`)
      return {
        choreId: row.id,
        title: row.title,
        icon: row.icon,
        personId: row.upForGrabs ? null : assigneeFor(row, date),
        upForGrabs: row.upForGrabs,
        claimerId: row.upForGrabs ? (completion?.personId ?? null) : null,
        starsValue: row.starsValue,
        routine: row.routine,
        recurrence: row.scheduleRrule ? parseRRuleString(row.scheduleRrule, zone) : null,
        anchorDate: anchor,
        dueToday: isDueOn(row, date),
        completedToday: completion !== undefined,
        overdue
      }
    })
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

  function linkedChoreIds(choreId: string): string[] {
    const linkRows = db
      .select()
      .from(choreLinks)
      .where(or(eq(choreLinks.choreId, choreId), eq(choreLinks.linkedChoreId, choreId)))
      .all()
    return linksFor(choreId, linkRows)
  }

  /** Insert a completion + star ledger row inside an existing transaction. */
  function recordCompletion(tx: Tx, chore: ChoreRow, personId: string, date: string): void {
    const existing = tx
      .select()
      .from(choreCompletions)
      .where(and(eq(choreCompletions.choreId, chore.id), eq(choreCompletions.dueDate, date)))
      .all()
    if (existing.length > 0) return
    const completionId = uuidv7()
    const now = isoUtc(DateTime.utc())
    tx.insert(choreCompletions)
      .values({
        id: completionId,
        choreId: chore.id,
        personId,
        dueDate: date,
        completedAt: now,
        starsAwarded: chore.starsValue
      })
      .run()
    if (chore.starsValue > 0) {
      tx.insert(starLedger)
        .values({ id: uuidv7(), personId, delta: chore.starsValue, reason: 'chore', refId: completionId, createdAt: now })
        .run()
    }
  }

  function complete(choreId: string, date: string, claimerId?: string): { balance: number } {
    const [chore] = db.select().from(chores).where(and(eq(chores.id, choreId), isNull(chores.deletedAt))).all()
    if (!chore) throw notFound('Chore')
    const personId = chore.upForGrabs ? claimerId : assigneeFor(chore, date)
    if (!personId) throw invalid(chore.upForGrabs ? 'Pick who grabbed this chore' : 'Chore has no person')
    db.transaction((tx) => {
      recordCompletion(tx, chore, personId, date)
      // linked chores complete together with this one
      for (const otherId of linkedChoreIds(choreId)) {
        const [other] = tx.select().from(chores).where(and(eq(chores.id, otherId), isNull(chores.deletedAt))).all()
        if (other && isDueOn(other, date)) recordCompletion(tx, other, personId, date)
      }
    })
    return { balance: balanceOf(personId) }
  }

  function uncomplete(choreId: string, date: string): { balance: number } {
    const [chore] = db.select().from(chores).where(eq(chores.id, choreId)).all()
    if (!chore) throw notFound('Chore')
    const [completion] = db
      .select()
      .from(choreCompletions)
      .where(and(eq(choreCompletions.choreId, choreId), eq(choreCompletions.dueDate, date)))
      .all()
    const personId = completion?.personId ?? (chore.upForGrabs ? null : assigneeFor(chore, date))
    db.transaction((tx) => {
      if (completion) {
        tx.delete(starLedger).where(eq(starLedger.refId, completion.id)).run()
        tx.delete(choreCompletions).where(eq(choreCompletions.id, completion.id)).run()
      }
      for (const otherId of linkedChoreIds(choreId)) {
        const [linkCompletion] = tx
          .select()
          .from(choreCompletions)
          .where(and(eq(choreCompletions.choreId, otherId), eq(choreCompletions.dueDate, date)))
          .all()
        if (linkCompletion) {
          tx.delete(starLedger).where(eq(starLedger.refId, linkCompletion.id)).run()
          tx.delete(choreCompletions).where(eq(choreCompletions.id, linkCompletion.id)).run()
        }
      }
    })
    return { balance: personId ? balanceOf(personId) : 0 }
  }

  return { list, create, update, remove, getDay, getTasks, complete, uncomplete, balances, balanceOf }
}

export type ChoresService = ReturnType<typeof createChoresService>
