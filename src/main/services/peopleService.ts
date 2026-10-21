import { and, asc, eq, isNull, max } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { people } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import type { PersonCreateInput, PersonDto, PersonUpdateInput } from '@shared/types'
import { notFound } from './errors'

function toDto(row: typeof people.$inferSelect): PersonDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    role: row.role,
    sortOrder: row.sortOrder,
    avatarUrl: row.avatarPath ? `osl-avatar://${row.id}` : null,
    birthday: row.birthday,
    birthYear: row.birthYear
  }
}

export function createPeopleService(db: AppDb) {
  function list(): PersonDto[] {
    return db
      .select()
      .from(people)
      .where(isNull(people.deletedAt))
      .orderBy(asc(people.sortOrder), asc(people.createdAt))
      .all()
      .map(toDto)
  }

  function create(input: PersonCreateInput): PersonDto {
    const [{ value: maxSort }] = db.select({ value: max(people.sortOrder) }).from(people).all()
    const row: typeof people.$inferInsert = {
      id: uuidv7(),
      name: input.name,
      color: input.color,
      role: input.role,
      sortOrder: (maxSort ?? 0) + 1,
      createdAt: isoUtc(DateTime.utc())
    }
    db.insert(people).values(row).run()
    return toDto({ ...row, avatarPath: null, birthday: null, birthYear: null, deletedAt: null, sortOrder: row.sortOrder! } as typeof people.$inferSelect)
  }

  function update(input: PersonUpdateInput): PersonDto {
    const patch: Partial<typeof people.$inferInsert> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.color !== undefined) patch.color = input.color
    if (input.role !== undefined) patch.role = input.role
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder
    if (input.birthday !== undefined) patch.birthday = input.birthday
    if (input.birthYear !== undefined) patch.birthYear = input.birthYear
    const result = db
      .update(people)
      .set(patch)
      .where(and(eq(people.id, input.id), isNull(people.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Person')
    const [row] = db.select().from(people).where(eq(people.id, input.id)).all()
    return toDto(row)
  }

  /** Flags whether the person has a stored avatar (the bytes live on disk, managed by AvatarService). */
  function markAvatar(id: string, present: boolean): PersonDto {
    const result = db
      .update(people)
      .set({ avatarPath: present ? '1' : null })
      .where(and(eq(people.id, id), isNull(people.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Person')
    const [row] = db.select().from(people).where(eq(people.id, id)).all()
    return toDto(row)
  }

  function exists(id: string): boolean {
    return db.select({ id: people.id }).from(people).where(and(eq(people.id, id), isNull(people.deletedAt))).all().length > 0
  }

  function remove(id: string): void {
    const result = db
      .update(people)
      .set({ deletedAt: isoUtc(DateTime.utc()) })
      .where(and(eq(people.id, id), isNull(people.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Person')
  }

  return { list, create, update, markAvatar, exists, remove }
}

export type PeopleService = ReturnType<typeof createPeopleService>
