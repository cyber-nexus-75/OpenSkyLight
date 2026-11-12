import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { receiptScans } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { parseReceiptText, type ParsedReceipt } from '@shared/groceries/receiptParse'
import type { ReceiptScanDto, ReceiptScanResultDto } from '@shared/types'
import { AppError, notFound } from './errors'
import { DateTime } from 'luxon'

export const MAX_RECEIPT_BYTES = 12 * 1024 * 1024

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

export function decodeReceiptImage(data: string): Buffer {
  let buf: Buffer
  try {
    buf = Buffer.from(data, 'base64')
  } catch {
    throw new AppError('INVALID', 'Receipt must be base64 image data')
  }
  if (buf.length === 0) throw new AppError('INVALID', 'Receipt image is empty')
  if (buf.length > MAX_RECEIPT_BYTES) throw new AppError('TOO_LARGE', 'Receipt image is too large (12 MB max)')
  const isPng = buf.subarray(0, 8).equals(PNG_SIGNATURE)
  const isJpeg = buf.subarray(0, 3).equals(JPEG_SIGNATURE)
  if (!isPng && !isJpeg) throw new AppError('INVALID', 'Receipt must be a PNG or JPEG image')
  return buf
}

export interface ReceiptServiceDeps {
  rootDir: string
  db: AppDb
  /** Injectable OCR engine; defaults to on-device tesseract.js (lazy-loaded). */
  ocrText?: (image: Buffer) => Promise<string>
}

/**
 * Receipt scanning: stores the photo under userData/receipts, runs on-device
 * OCR (tesseract.js, language data cached locally after first run), parses the
 * text into items, and records the scan. Items are only applied to the pantry
 * when the user confirms them (groceries:applyReceipt).
 */
export function createReceiptService(deps: ReceiptServiceDeps) {
  const dir = join(deps.rootDir, 'receipts')
  mkdirSync(dir, { recursive: true })
  const tessdataDir = join(deps.rootDir, 'tessdata')
  mkdirSync(tessdataDir, { recursive: true })

  async function defaultOcr(image: Buffer): Promise<string> {
    const tesseract = await import('tesseract.js')
    const worker = await tesseract.createWorker('eng', tesseract.OEM.LSTM_ONLY, {
      cacheMethod: 'write',
      cachePath: tessdataDir
    })
    try {
      const { data } = await worker.recognize(image)
      return data.text
    } finally {
      await worker.terminate()
    }
  }

  const ocr = deps.ocrText ?? defaultOcr

  function pathFor(scanId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(scanId)) throw new AppError('INVALID', 'Invalid scan id')
    const full = resolve(join(dir, scanId))
    if (!full.startsWith(resolve(dir))) throw new AppError('INVALID', 'Invalid scan id')
    return full
  }

  function imagePathFor(scanId: string): string | null {
    for (const ext of ['.jpg', '.jpeg', '.png']) {
      const full = `${pathFor(scanId)}${ext}`
      if (existsSync(full)) return full
    }
    return null
  }

  function scanDto(row: typeof receiptScans.$inferSelect): ReceiptScanDto {
    return {
      id: row.id,
      store: row.store,
      total: row.total,
      itemCount: row.itemCount,
      applied: row.appliedAt !== null,
      scannedAt: row.scannedAt
    }
  }

  async function scan(imageBytes: Buffer): Promise<ReceiptScanResultDto> {
    // validate here too: the companion /api/receipt path hands us raw bytes
    const isPng = imageBytes.subarray(0, 8).equals(PNG_SIGNATURE)
    const isJpeg = imageBytes.subarray(0, 3).equals(JPEG_SIGNATURE)
    if (imageBytes.length === 0) throw new AppError('INVALID', 'Receipt image is empty')
    if (imageBytes.length > MAX_RECEIPT_BYTES) throw new AppError('TOO_LARGE', 'Receipt image is too large (12 MB max)')
    if (!isPng && !isJpeg) throw new AppError('INVALID', 'Receipt must be a PNG or JPEG image')
    const id = uuidv7()
    const ext = isJpeg ? '.jpg' : '.png'
    const filePath = `${pathFor(id)}${ext}`
    writeFileSync(filePath, imageBytes)
    const rawText = await ocr(imageBytes)
    const parsed: ParsedReceipt = parseReceiptText(rawText)
    const ts = isoUtc(DateTime.utc())
    deps.db
      .insert(receiptScans)
      .values({
        id,
        imagePath: filePath,
        store: parsed.store,
        total: parsed.total,
        rawText,
        itemCount: parsed.items.length,
        scannedAt: ts,
        createdAt: ts
      })
      .run()
    const [row] = deps.db.select().from(receiptScans).where(eq(receiptScans.id, id)).all()
    return { scan: scanDto(row!), rawText, parsed }
  }

  function getScanDetail(scanId: string): { scan: ReceiptScanDto; rawText: string; parsed: ParsedReceipt } {
    const [row] = deps.db.select().from(receiptScans).where(eq(receiptScans.id, scanId)).all()
    if (!row) throw notFound('Receipt scan')
    const parsed = parseReceiptText(row.rawText ?? '')
    return { scan: scanDto(row), rawText: row.rawText ?? '', parsed }
  }

  function getImageDataUrl(scanId: string): string | null {
    const file = imagePathFor(scanId)
    if (!file) return null
    const bytes = readFileSync(file)
    const mime = extname(file) === '.png' ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  return { scan, getScanDetail, getImageDataUrl }
}

export type ReceiptService = ReturnType<typeof createReceiptService>
