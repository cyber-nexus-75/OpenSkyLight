import { DateTime } from 'luxon'
import type { SettingsService } from './settingsService'
import type { AiService, AiImportInput } from './aiService'
import type { WebdavService } from './webdavService'
import type { AiEventDraft } from '@shared/types'
import { AppError } from './errors'

const KEY_LAST_SCAN = 'aiScan.lastAt'
const SCAN_INTERVAL_MS = 12 * 60 * 60 * 1000 // roughly twice a day

export interface ScanResult {
  drafts: number
  files: string[]
  error: string | null
}

/**
 * Watches the WebDAV `scan-me/` subfolder: drop a school flyer PDF or a photo
 * of the soccer schedule into Nextcloud, and the kiosk pre-drafts events for
 * review. Drafts are broadcast to the kiosk for the review screen — never
 * auto-committed. Processed files move to `scanned/` so they run once.
 */
export function createAiScanService(deps: {
  settings: SettingsService
  ai: AiService
  webdav: WebdavService
  onDrafts: (drafts: AiEventDraft[], source: string) => void
}) {
  const { settings, ai, webdav, onDrafts } = deps

  async function scanNow(force = false): Promise<ScanResult> {
    const last = Number(settings.getRaw(KEY_LAST_SCAN) ?? 0)
    const now = Date.now()
    if (!force && Number.isFinite(last) && now - last < SCAN_INTERVAL_MS) {
      return { drafts: 0, files: [], error: null }
    }
    settings.setRaw(KEY_LAST_SCAN, String(now))
    try {
      const files = await webdav.listFolder('scan-me')
      let totalDrafts = 0
      const processed: string[] = []
      for (const file of files.slice(0, 10)) {
        const bytes = await webdav.downloadFromFolder('scan-me', file.name)
        const input: AiImportInput = /\.json$/i.test(file.name)
          ? { text: bytes.toString('utf8'), images: [], tz: tzNow() }
          : { text: `Extract the events from this file (${file.name}).`, images: [bytes.toString('base64')], tz: tzNow() }
        const drafts = await ai.importEvents(input)
        if (drafts.length > 0) {
          totalDrafts += drafts.length
          onDrafts(drafts, file.name)
        }
        // move the file aside so it isn't re-scanned
        await webdav.uploadFile(file.name, bytes, { subfolder: 'scanned' })
        processed.push(file.name)
      }
      return { drafts: totalDrafts, files: processed, error: null }
    } catch (err) {
      if (err instanceof AppError && err.code === 'NOT_CONFIGURED') {
        return { drafts: 0, files: [], error: null } // no webdav configured — skip quietly
      }
      return { drafts: 0, files: [], error: err instanceof Error ? err.message : 'scan failed' }
    }
  }

  return { scanNow }
}

function tzNow(): string {
  return DateTime.local().zoneName ?? 'UTC'
}
