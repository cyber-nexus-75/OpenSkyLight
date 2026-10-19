import { and, asc, eq, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { calendars, events } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import type { CalendarCreateInput, CalendarDto, CalendarUpdateInput } from '@shared/types'
import { invalid, notFound } from './errors'

function toDto(row: typeof calendars.$inferSelect): CalendarDto {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    color: row.color,
    readOnly: row.readOnly,
    visible: row.visible,
    personId: row.personId
  }
}

export function createCalendarService(db: AppDb) {
  function list(): CalendarDto[] {
    return db
      .select()
      .from(calendars)
      .where(isNull(calendars.deletedAt))
      .orderBy(asc(calendars.name))
      .all()
      .map(toDto)
  }

  function create(input: CalendarCreateInput): CalendarDto {
    const row: typeof calendars.$inferInsert = {
      id: uuidv7(),
      provider: 'local',
      name: input.name,
      color: input.color,
      readOnly: false,
      visible: true
    }
    db.insert(calendars).values(row).run()
    const [created] = db.select().from(calendars).where(eq(calendars.id, row.id!)).all()
    return toDto(created)
  }

  function update(input: CalendarUpdateInput): CalendarDto {
    const patch: Partial<typeof calendars.$inferInsert> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.color !== undefined) patch.color = input.color
    if (input.visible !== undefined) patch.visible = input.visible
    const result = db
      .update(calendars)
      .set(patch)
      .where(and(eq(calendars.id, input.id), isNull(calendars.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Calendar')
    const [row] = db.select().from(calendars).where(eq(calendars.id, input.id)).all()
    return toDto(row)
  }

  function remove(id: string): void {
    const visible = db
      .select()
      .from(calendars)
      .where(and(isNull(calendars.deletedAt)))
      .all()
    if (visible.length <= 1) throw invalid('Cannot delete the last calendar')
    const now = isoUtc(DateTime.utc())
    db.transaction((tx) => {
      const result = tx
        .update(calendars)
        .set({ deletedAt: now })
        .where(and(eq(calendars.id, id), isNull(calendars.deletedAt)))
        .run()
      if (result.changes === 0) throw notFound('Calendar')
      tx.update(events).set({ deletedAt: now }).where(and(eq(events.calendarId, id), isNull(events.deletedAt))).run()
    })
  }

  /** Per-person calendar mapping (CalDAV): events inherit this person's assignment. */
  function setCalendarPerson(calendarId: string, personId: string | null): CalendarDto {
    const result = db
      .update(calendars)
      .set({ personId })
      .where(and(eq(calendars.id, calendarId), isNull(calendars.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Calendar')
    const [row] = db.select().from(calendars).where(eq(calendars.id, calendarId)).all()
    return toDto(row)
  }

  return { list, create, update, remove, setCalendarPerson }
}

export type CalendarService = ReturnType<typeof createCalendarService>
