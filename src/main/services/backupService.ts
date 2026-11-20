import type Database from 'better-sqlite3'
import { AppError, invalid } from './errors'

/**
 * Family-data backup and restore, designed for swapping systems.
 *
 * A backup is one JSON file: every domain table plus non-secret settings.
 * Credentials are EXCLUDED on purpose — they're DPAPI-encrypted per machine
 * and must be re-entered on the new system. The parental PIN, pairing tokens,
 * and webhook hashes are excluded too: a backup must never be a way to
 * transplant trust.
 */

export const BACKUP_VERSION = 1

/** Domain tables that make this kiosk the family's. */
export const BACKUP_TABLES = [
  'people',
  'calendars',
  'events',
  'event_people',
  'chores',
  'chore_completions',
  'star_ledger',
  'rewards',
  'reward_redemptions',
  'lists',
  'list_items',
  'recipes',
  'meal_slots'
] as const

/** Raw settings keys that are safe to move between machines. */
export const PORTABLE_SETTING_KEYS = [
  'weekStartsOn',
  'defaultView',
  'timeFormat',
  'temperatureUnit',
  'theme',
  'weather',
  'sleep',
  'homeLayout',
  'companion',
  'syncIntervalMinutes'
] as const

export interface BackupFile {
  version: number
  exportedAt: string
  tables: Record<string, unknown[]>
  settings: Record<string, unknown>
}

const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Pure shape validation — testable without a database. */
export function validateBackupShape(raw: unknown): BackupFile {
  if (raw === null || typeof raw !== 'object') throw invalid('Not a backup file')
  const b = raw as Partial<BackupFile>
  if (b.version !== BACKUP_VERSION) {
    throw new AppError('BACKUP_VERSION', `Unsupported backup version: ${String(b.version)}`)
  }
  if (typeof b.exportedAt !== 'string' || b.tables === null || typeof b.tables !== 'object' || b.settings === null || typeof b.settings !== 'object') {
    throw invalid('Backup file is malformed')
  }
  for (const table of BACKUP_TABLES) {
    if (!Array.isArray((b.tables as Record<string, unknown>)[table])) {
      throw invalid(`Backup is missing the ${table} table`)
    }
  }
  return b as BackupFile
}

export function createBackupService(deps: {
  sqlite: Database.Database
  getAllSettings: () => Record<string, unknown>
  /** store raw settings keys for the auto-backup bookkeeping */
  getRaw: (key: string) => string | null
  setRaw: (key: string, value: string) => void
}) {
  const { sqlite, getAllSettings, getRaw, setRaw } = deps
  const KEY_LAST_AUTO = 'backup.lastAutoAt'
  const KEY_LAST_ERROR = 'backup.lastError'

  /** Serialize the family dataset to a backup object. */
  function exportBackup(): BackupFile {
    const tables: Record<string, unknown[]> = {}
    for (const table of BACKUP_TABLES) {
      tables[table] = (sqlite.prepare(`SELECT * FROM ${table}`).all() as unknown[]).map(stripNulls)
    }
    const all = getAllSettings()
    const settings: Record<string, unknown> = {}
    for (const key of PORTABLE_SETTING_KEYS) {
      if (all[key] !== undefined) settings[key] = all[key]
    }
    return {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      tables,
      settings
    }
  }

  /**
   * Restore inside one transaction: wipe the domain tables and rebuild them
   * from the backup. A failure mid-restore rolls everything back.
   */
  function restoreBackup(raw: unknown): { counts: Record<string, number> } {
    const backup = validateBackupShape(raw)
    const counts: Record<string, number> = {}
    sqlite.transaction(() => {
      // ordering matters only for the wipe; FKs are ON so children first
      const wipeOrder = ['event_people', 'chore_completions', 'star_ledger', 'reward_redemptions', 'list_items', 'meal_slots', 'events', 'chores', 'rewards', 'lists', 'recipes', 'calendars', 'people']
      for (const table of wipeOrder) sqlite.exec(`DELETE FROM ${table}`)
      for (const table of BACKUP_TABLES) {
        const rows = backup.tables[table] as Record<string, unknown>[]
        for (const row of rows) {
          const cols = Object.keys(row)
          if (cols.length === 0) continue
          const placeholders = cols.map(() => '?').join(',')
          const values = cols.map((c) => {
            const v = row[c]
            // better-sqlite3 wants booleans as 0/1
            if (typeof v === 'boolean') return v ? 1 : 0
            return v
          })
          sqlite.prepare(`INSERT INTO ${table} (${cols.map(quoteIdent).join(',')}) VALUES (${placeholders})`).run(...values)
        }
        counts[table] = rows.length
      }
    })()
    return { counts }
  }

  function autoStatus(): { lastAutoBackupAt: string | null; lastAutoBackupError: string | null } {
    const raw = getRaw(KEY_LAST_AUTO)
    return {
      lastAutoBackupAt: raw ? new Date(Number(raw)).toISOString() : null,
      lastAutoBackupError: getRaw(KEY_LAST_ERROR) || null
    }
  }

  /**
   * Scheduled upload to the configured WebDAV folder. Returns true when a
   * backup was written. Failures are recorded, never thrown — a backup
   * outage must not break the sync loop.
   */
  async function autoBackup(
    uploadFile: (fileName: string, bytes: Buffer) => Promise<void>,
    now = Date.now()
  ): Promise<boolean> {
    // stored as epoch ms so the cadence check is a plain number compare
    const last = Number(getRaw(KEY_LAST_AUTO) ?? 0)
    if (Number.isFinite(last) && now - last < AUTO_INTERVAL_MS) return false
    try {
      const file = exportBackup()
      const fileName = `openskylight-backup-${new Date(now).toISOString().slice(0, 10)}.json`
      await uploadFile(fileName, Buffer.from(JSON.stringify(file)))
      setRaw(KEY_LAST_AUTO, String(now))
      setRaw(KEY_LAST_ERROR, '')
    } catch (err) {
      setRaw(KEY_LAST_ERROR, err instanceof Error ? err.message : 'backup failed')
    }
    return true
  }

  return { exportBackup, validateBackup: validateBackupShape, restoreBackup, autoStatus, autoBackup }
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw invalid('Bad column name in backup')
  return `"${name}"`
}

function stripNulls(row: unknown): unknown {
  // sqlite rows come back with nulls intact; keep them (INSERT needs all cols)
  return row
}

export type BackupService = ReturnType<typeof createBackupService>
