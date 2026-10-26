import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../../src/main/db/client'
import { createHabitsService, type HabitsService } from '../../src/main/services/habitsService'

const CHI = 'America/Chicago'

describe('habits', () => {
  let handle: DbHandle
  let habits: HabitsService

  beforeEach(() => {
    handle = openDatabase(':memory:')
    habits = createHabitsService(handle.db, () => CHI)
    handle.sqlite
      .prepare(
        "INSERT INTO people (id, name, color, role, sort_order, created_at) VALUES ('kid1','Emma','#46A758','child',0,'2026-01-01T00:00:00Z')"
      )
      .run()
  })

  it('daily habits are due every day from their anchor', () => {
    habits.create({ title: 'Read 20 min', personId: 'kid1', recurrence: { freq: 'daily' }, anchorDate: '2026-06-08' })
    expect(habits.getDay('2026-06-07')).toHaveLength(0) // before anchor
    expect(habits.getDay('2026-06-08')).toHaveLength(1)
    expect(habits.getDay('2026-06-20')).toHaveLength(1)
  })

  it('weekly habits are due only on their weekdays', () => {
    // 2026-06-08 is a Monday; byWeekdays 0=Mon, 4=Fri
    habits.create({
      title: 'Piano practice',
      personId: 'kid1',
      recurrence: { freq: 'weekly', byWeekdays: [0, 4] },
      anchorDate: '2026-06-08'
    })
    expect(habits.getDay('2026-06-08')).toHaveLength(1) // Mon
    expect(habits.getDay('2026-06-09')).toHaveLength(0) // Tue
    expect(habits.getDay('2026-06-12')).toHaveLength(1) // Fri
    expect(habits.getDay('2026-06-15')).toHaveLength(1) // next Mon
  })

  it('one-time habits appear only on the anchor date', () => {
    habits.create({ title: 'Write thank-you note', personId: 'kid1', recurrence: null, anchorDate: '2026-06-10' })
    expect(habits.getDay('2026-06-10')).toHaveLength(1)
    expect(habits.getDay('2026-06-11')).toHaveLength(0)
  })

  it('complete marks the day done and uncomplete clears it', () => {
    const habit = habits.create({ title: 'Floss', personId: 'kid1', recurrence: { freq: 'daily' }, anchorDate: '2026-06-01' })
    habits.complete(habit.id, '2026-06-10')
    let day = habits.getDay('2026-06-10')
    expect(day).toHaveLength(1)
    expect(day[0].completed).toBe(true)
    expect(day[0].totalDone).toBe(1)
    habits.uncomplete(habit.id, '2026-06-10')
    day = habits.getDay('2026-06-10')
    expect(day[0].completed).toBe(false)
    expect(day[0].totalDone).toBe(0)
  })

  it('daily streak counts consecutive completed days ending on the queried date', () => {
    const habit = habits.create({ title: 'Practice Spanish', personId: 'kid1', recurrence: { freq: 'daily' }, anchorDate: '2026-06-01' })
    for (const d of ['2026-06-08', '2026-06-09', '2026-06-10']) habits.complete(habit.id, d)
    // 06-08..06-10 done, 06-07 missed
    expect(habits.getDay('2026-06-10')[0].streak).toBe(3)
    expect(habits.getDay('2026-06-11')[0].streak).toBe(0) // gap at 06-11
    // completing the current day extends the streak through it
    habits.complete(habit.id, '2026-06-11')
    expect(habits.getDay('2026-06-11')[0].streak).toBe(4)
  })

  it('weekly habit streaks skip (not break) on off days', () => {
    // Mondays only: 2026-06-08, 06-15, 06-22 are Mondays
    const habit = habits.create({
      title: 'Water plants',
      personId: 'kid1',
      recurrence: { freq: 'weekly', byWeekdays: [0] },
      anchorDate: '2026-06-08'
    })
    habits.complete(habit.id, '2026-06-08')
    habits.complete(habit.id, '2026-06-15')
    // Sunday 06-21 sits between the two completed Mondays — streak must hold
    expect(habits.getDay('2026-06-21')[0].streak).toBe(2)
    expect(habits.getDay('2026-06-22')[0].streak).toBe(0) // this Monday not done yet
    habits.complete(habit.id, '2026-06-22')
    expect(habits.getDay('2026-06-22')[0].streak).toBe(3)
  })

  it("inactive habits are hidden from the day view and can be reactivated", () => {
    const habit = habits.create({ title: 'Journal', personId: 'kid1', recurrence: { freq: 'daily' }, anchorDate: '2026-06-08' })
    habits.complete(habit.id, '2026-06-08')
    expect(habits.getDay('2026-06-07')).toHaveLength(0)
    habits.update({ id: habit.id, active: false })
    expect(habits.getDay('2026-06-08')).toHaveLength(0)
    habits.update({ id: habit.id, active: true })
    expect(habits.getDay('2026-06-08')).toHaveLength(1)
  })

  it('update renames a habit and delete tombstones it', () => {
    const habit = habits.create({ title: 'Meditate', personId: 'kid1', recurrence: { freq: 'daily' }, anchorDate: '2026-06-01' })
    const renamed = habits.update({ id: habit.id, title: 'Meditate 10 min' })
    expect(renamed.title).toBe('Meditate 10 min')
    habits.remove(habit.id)
    expect(habits.getDay('2026-06-10')).toHaveLength(0)
    expect(habits.list().find((h) => h.id === habit.id)).toBeUndefined()
  })
})
