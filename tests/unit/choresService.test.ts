import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../../src/main/db/client'
import { createChoresService, type ChoresService } from '../../src/main/services/choresService'
import { createRewardsService, type RewardsService } from '../../src/main/services/rewardsService'

const CHI = 'America/Chicago'

describe('chores + rewards', () => {
  let handle: DbHandle
  let chores: ChoresService
  let rewards: RewardsService

  beforeEach(() => {
    handle = openDatabase(':memory:')
    chores = createChoresService(handle.db, () => CHI)
    rewards = createRewardsService(handle.db, chores)
    handle.sqlite
      .prepare(
        "INSERT INTO people (id, name, color, role, sort_order, created_at) VALUES ('kid1','Emma','#46A758','child',0,'2026-01-01T00:00:00Z')"
      )
      .run()
  })

  it('daily chores are due every day from their anchor', () => {
    chores.create({ title: 'Make bed', personId: 'kid1', starsValue: 2, recurrence: { freq: 'daily' }, anchorDate: '2026-06-08' })
    expect(chores.getDay('2026-06-07')).toHaveLength(0) // before anchor
    expect(chores.getDay('2026-06-08')).toHaveLength(1)
    expect(chores.getDay('2026-06-20')).toHaveLength(1)
  })

  it('weekly chores are due only on their weekdays', () => {
    // 2026-06-08 is a Monday; byWeekdays 0=Mon, 4=Fri
    chores.create({
      title: 'Trash out',
      personId: 'kid1',
      starsValue: 5,
      recurrence: { freq: 'weekly', byWeekdays: [0, 4] },
      anchorDate: '2026-06-08'
    })
    expect(chores.getDay('2026-06-08')).toHaveLength(1) // Mon
    expect(chores.getDay('2026-06-09')).toHaveLength(0) // Tue
    expect(chores.getDay('2026-06-12')).toHaveLength(1) // Fri
    expect(chores.getDay('2026-06-15')).toHaveLength(1) // next Mon
  })

  it('one-time chores appear only on the anchor date', () => {
    chores.create({ title: 'Clean garage', personId: 'kid1', starsValue: 10, recurrence: null, anchorDate: '2026-06-10' })
    expect(chores.getDay('2026-06-10')).toHaveLength(1)
    expect(chores.getDay('2026-06-11')).toHaveLength(0)
  })

  it('completing awards stars exactly once and uncompleting reverses', () => {
    const chore = chores.create({
      title: 'Dishes',
      personId: 'kid1',
      starsValue: 3,
      recurrence: { freq: 'daily' },
      anchorDate: '2026-06-01' // fixed: getDay below uses fixed dates, so the anchor must not be "today"
    })
    expect(chores.complete(chore.id, '2026-06-10').balance).toBe(3)
    expect(chores.complete(chore.id, '2026-06-10').balance).toBe(3) // idempotent
    expect(chores.complete(chore.id, '2026-06-11').balance).toBe(6) // different day counts
    expect(chores.getDay('2026-06-10')[0].completed).toBe(true)
    expect(chores.uncomplete(chore.id, '2026-06-10').balance).toBe(3)
    expect(chores.getDay('2026-06-10')[0].completed).toBe(false)
  })

  it('balance equals the ledger sum across chores and redemptions', () => {
    const chore = chores.create({ title: 'Dishes', personId: 'kid1', starsValue: 10, recurrence: { freq: 'daily' } })
    chores.complete(chore.id, '2026-06-10')
    chores.complete(chore.id, '2026-06-11')
    const reward = rewards.create({ title: 'Ice cream', costStars: 15 })
    rewards.redeem(reward.id, 'kid1')
    expect(chores.balanceOf('kid1')).toBe(5)
  })

  it('refuses redemptions the balance cannot cover', () => {
    const reward = rewards.create({ title: 'Bike', costStars: 100 })
    expect(() => rewards.redeem(reward.id, 'kid1')).toThrow(/Not enough stars/)
    expect(chores.balanceOf('kid1')).toBe(0)
  })

  it('tracks pending redemptions until granted', () => {
    const chore = chores.create({ title: 'Dishes', personId: 'kid1', starsValue: 20, recurrence: { freq: 'daily' } })
    chores.complete(chore.id, '2026-06-10')
    const reward = rewards.create({ title: 'Ice cream', costStars: 15 })
    const redemption = rewards.redeem(reward.id, 'kid1')
    expect(rewards.pendingRedemptions()).toHaveLength(1)
    expect(rewards.pendingRedemptions()[0].rewardTitle).toBe('Ice cream')
    rewards.grant(redemption.id)
    expect(rewards.pendingRedemptions()).toHaveLength(0)
  })
})

describe('chore upgrades (M7)', () => {
  let handle: DbHandle
  let chores: ChoresService

  beforeEach(() => {
    handle = openDatabase(':memory:')
    chores = createChoresService(handle.db, () => CHI)
    for (const [id, name, color] of [
      ['kid1', 'Emma', '#46A758'],
      ['kid2', 'Liam', '#0091FF']
    ] as const) {
      handle.sqlite
        .prepare(
          `INSERT INTO people (id, name, color, role, sort_order, created_at) VALUES (?, ?, ?, 'child', 0, '2026-01-01T00:00:00Z')`
        )
        .run(id, name, color)
    }
  })

  it('up-for-grabs chores have no owner and are due like any chore', () => {
    const chore = chores.create({
      title: 'Take out trash',
      personId: null,
      starsValue: 4,
      recurrence: { freq: 'daily' },
      upForGrabs: true,
      anchorDate: '2026-06-08'
    })
    expect(chore.personId).toBeNull()
    expect(chore.upForGrabs).toBe(true)
    const day = chores.getDay('2026-06-10')
    expect(day).toHaveLength(1)
    expect(day[0].upForGrabs).toBe(true)
    expect(day[0].completed).toBe(false)
  })

  it('claiming an up-for-grabs chore requires a claimer and pays the claimer', () => {
    const chore = chores.create({ title: 'Vacuum', personId: null, starsValue: 5, recurrence: { freq: 'daily' }, upForGrabs: true, anchorDate: '2026-06-01' })
    expect(() => chores.complete(chore.id, '2026-06-10')).toThrow(/Pick who grabbed/)
    expect(chores.complete(chore.id, '2026-06-10', 'kid2').balance).toBe(5)
    expect(chores.balanceOf('kid1')).toBe(0)
    const day = chores.getDay('2026-06-10')
    expect(day[0].completed).toBe(true)
    expect(day[0].claimerId).toBe('kid2')
    // idempotent: claiming again does not double-pay (balance returned is the new claimer's)
    expect(chores.complete(chore.id, '2026-06-10', 'kid1').balance).toBe(0)
    expect(chores.balanceOf('kid2')).toBe(5)
    expect(chores.balanceOf('kid1')).toBe(0)
    // uncheck reverses
    expect(chores.uncomplete(chore.id, '2026-06-10').balance).toBe(0)
    expect(chores.getDay('2026-06-10')[0].completed).toBe(false)
  })

  it('repeat-after-completion one-time chores are due every day after the anchor', () => {
    chores.create({ title: 'Water plants', personId: 'kid1', starsValue: 1, recurrence: null, anchorDate: '2026-06-08', repeatAfter: true })
    expect(chores.getDay('2026-06-07')).toHaveLength(0)
    expect(chores.getDay('2026-06-08')).toHaveLength(1)
    expect(chores.getDay('2026-06-30')).toHaveLength(1)
    // completing today does not suppress tomorrow
    chores.complete(chores.list()[0].id, '2026-06-10')
    expect(chores.getDay('2026-06-11')).toHaveLength(1)
    expect(chores.getDay('2026-06-11')[0].completed).toBe(false)
  })

  it('linked chores complete together and uncomplete together', () => {
    const a = chores.create({ title: 'Pack lunch', personId: 'kid1', starsValue: 2, recurrence: { freq: 'daily' }, anchorDate: '2026-06-01' })
    const b = chores.create({ title: 'Pack backpack', personId: 'kid1', starsValue: 3, recurrence: { freq: 'daily' }, anchorDate: '2026-06-01', linkedChoreIds: [a.id] })
    expect(chores.list().find((c) => c.id === b.id)?.linkedChoreIds).toEqual([a.id])
    expect(chores.list().find((c) => c.id === a.id)?.linkedChoreIds).toEqual([b.id])
    expect(chores.complete(a.id, '2026-06-10').balance).toBe(5) // 2 + 3
    const day = chores.getDay('2026-06-10')
    expect(day.every((c) => c.completed)).toBe(true)
    expect(chores.uncomplete(a.id, '2026-06-10').balance).toBe(0)
    expect(chores.getDay('2026-06-10').every((c) => !c.completed)).toBe(true)
  })

  it('linking is replaced wholesale on update', () => {
    const a = chores.create({ title: 'A', personId: 'kid1', starsValue: 1, recurrence: { freq: 'daily' }, anchorDate: '2026-06-01' })
    const b = chores.create({ title: 'B', personId: 'kid1', starsValue: 1, recurrence: { freq: 'daily' }, anchorDate: '2026-06-01' })
    const c = chores.create({ title: 'C', personId: 'kid1', starsValue: 1, recurrence: { freq: 'daily' }, anchorDate: '2026-06-01' })
    chores.update({ id: a.id, linkedChoreIds: [b.id, c.id] })
    expect(chores.list().find((x) => x.id === a.id)?.linkedChoreIds.sort()).toEqual([b.id, c.id].sort())
    chores.update({ id: a.id, linkedChoreIds: [c.id] })
    expect(chores.list().find((x) => x.id === a.id)?.linkedChoreIds).toEqual([c.id])
    expect(chores.list().find((x) => x.id === b.id)?.linkedChoreIds).toEqual([])
  })

  it('getTasks flags due-today and overdue one-time chores', () => {
    chores.create({ title: 'Daily', personId: 'kid1', starsValue: 1, recurrence: { freq: 'daily' }, anchorDate: '2026-06-01' })
    chores.create({ title: 'One-time past', personId: 'kid1', starsValue: 1, recurrence: null, anchorDate: '2026-06-01' })
    const done = chores.create({ title: 'One-time done', personId: 'kid1', starsValue: 1, recurrence: null, anchorDate: '2026-06-01' })
    chores.complete(done.id, '2026-06-01')
    const tasks = chores.getTasks('2026-06-10')
    const byTitle = new Map(tasks.map((t) => [t.title, t]))
    expect(byTitle.get('Daily')?.dueToday).toBe(true)
    expect(byTitle.get('Daily')?.overdue).toBe(false)
    expect(byTitle.get('One-time past')?.dueToday).toBe(false)
    expect(byTitle.get('One-time past')?.overdue).toBe(true)
    expect(byTitle.get('One-time done')?.overdue).toBe(false)
  })

  it('afternoon routines sort between morning and evening', () => {
    chores.create({ title: 'Eve', personId: 'kid1', starsValue: 1, recurrence: { freq: 'daily' }, routine: 'evening', anchorDate: '2026-06-01' })
    chores.create({ title: 'Aft', personId: 'kid1', starsValue: 1, recurrence: { freq: 'daily' }, routine: 'afternoon', anchorDate: '2026-06-01' })
    chores.create({ title: 'Morn', personId: 'kid1', starsValue: 1, recurrence: { freq: 'daily' }, routine: 'morning', anchorDate: '2026-06-01' })
    expect(chores.getDay('2026-06-10').map((c) => c.title)).toEqual(['Morn', 'Aft', 'Eve'])
  })
})
