import { describe, expect, it } from 'vitest'
import {
  createBackupService,
  validateBackupShape,
  BACKUP_VERSION
} from '../../src/main/services/backupService'
import type Database from 'better-sqlite3'

/**
 * Pure-logic backup tests. The SQLite round-trip (exportBackup/restoreBackup)
 * requires better-sqlite3 compiled for Electron's Node ABI, which this
 * sandbox's plain-Node vitest cannot load — those paths are covered by the
 * restore smoke on real hardware. Everything testable without the DB is here.
 */

describe('backup validation', () => {
  it('accepts a well-formed backup of the current version', () => {
    const backup = {
      version: BACKUP_VERSION,
      exportedAt: '2026-01-01T00:00:00.000Z',
      tables: {
        people: [],
        calendars: [],
        events: [],
        event_people: [],
        chores: [],
        chore_completions: [],
        star_ledger: [],
        rewards: [],
        reward_redemptions: [],
        lists: [],
        list_items: [],
        recipes: [],
        meal_slots: []
      },
      settings: { weekStartsOn: 0 }
    }
    expect(() => validateBackupShape(backup)).not.toThrow()
  })

  it('rejects wrong versions, non-objects, and missing tables', () => {
    expect(() => validateBackupShape(null)).toThrow(/Not a backup/)
    expect(() => validateBackupShape('string')).toThrow(/Not a backup/)
    expect(() => validateBackupShape({ version: 99, exportedAt: 'x', tables: {}, settings: {} })).toThrow(/version/i)
    const noPeople = {
      version: BACKUP_VERSION,
      exportedAt: '2026-01-01T00:00:00.000Z',
      tables: {},
      settings: {}
    }
    expect(() => validateBackupShape(noPeople)).toThrow(/missing the people table/)
  })
})

describe('autoBackup cadence', () => {
  function makeService(opts: { lastAutoAt?: string; fail?: boolean }) {
    const store = new Map<string, string>()
    if (opts.lastAutoAt) store.set('backup.lastAutoAt', String(Date.parse(opts.lastAutoAt)))
    const uploads: { name: string; bytes: Buffer }[] = []
    // a stub sqlite good enough for exportBackup: every SELECT returns no rows
    const fakeSqlite = {
      prepare: () => ({ all: () => [] }),
      exec: () => undefined,
      transaction: (fn: () => void) => fn
    } as unknown as Database.Database
    const svc = createBackupService({
      sqlite: fakeSqlite,
      getAllSettings: () => ({}),
      getRaw: (k) => store.get(k) ?? null,
      setRaw: (k, v) => void store.set(k, v)
    })
    return {
      svc,
      uploads,
      store,
      uploadFile: async (name: string, bytes: Buffer) => {
        if (opts.fail) throw new Error('webdav down')
        uploads.push({ name, bytes })
      }
    }
  }

  it('uploads when due and records the timestamp', async () => {
    const { svc, uploads, store, uploadFile } = makeService({})
    const NOW = Date.now()
    const ran = await svc.autoBackup(uploadFile, NOW)
    expect(ran).toBe(true)
    expect(uploads.length).toBe(1)
    expect(uploads[0].name).toMatch(/^openskylight-backup-\d{4}-\d{2}-\d{2}\.json$/)
    expect(store.get('backup.lastAutoAt')).toBeTruthy()
    expect(store.get('backup.lastError')).toBe('')
  })

  it('skips when the last backup is under 24h old', async () => {
    const now = Date.now()
    const { svc, uploads, uploadFile } = makeService({
      lastAutoAt: new Date(now - 60_000).toISOString()
    })
    const ran = await svc.autoBackup(uploadFile, now)
    expect(ran).toBe(false)
    expect(uploads.length).toBe(0)
  })

  it('runs again after 24h', async () => {
    const now = Date.now()
    const { svc, uploads, uploadFile } = makeService({
      lastAutoAt: new Date(now - 25 * 60 * 60 * 1000).toISOString()
    })
    const ran = await svc.autoBackup(uploadFile, now)
    expect(ran).toBe(true)
    expect(uploads.length).toBe(1)
  })

  it('records failures without throwing, and retries next cycle', async () => {
    const { svc, store, uploadFile } = makeService({ fail: true })
    const ran = await svc.autoBackup(uploadFile, Date.now())
    expect(ran).toBe(true)
    expect(store.get('backup.lastError')).toBe('webdav down')
    expect(store.get('backup.lastAutoAt')).toBeFalsy() // no timestamp → retried
  })

  it('autoStatus reports the bookkeeping', async () => {
    const { svc, uploadFile } = makeService({})
    expect(svc.autoStatus()).toEqual({ lastAutoBackupAt: null, lastAutoBackupError: null })
    await svc.autoBackup(uploadFile, Date.now())
    const st = svc.autoStatus()
    expect(st.lastAutoBackupAt).toBeTruthy()
    expect(st.lastAutoBackupError).toBeNull() // clean run → null, not ''
  })
})
