import { mkdirSync, existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import { AppError } from './errors'

export const AVATAR_SIZE = 256
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

/**
 * Accepts a base64 payload from the renderer (which has already square-cropped
 * and resized it to 256x256 via canvas) and validates it is a real image.
 */
export function decodeBase64Image(data: string): Buffer {
  let buf: Buffer
  try {
    buf = Buffer.from(data, 'base64')
  } catch {
    throw new AppError('INVALID', 'Avatar must be base64')
  }
  if (buf.length === 0) throw new AppError('INVALID', 'Avatar data is empty')
  if (buf.length > MAX_AVATAR_BYTES) throw new AppError('TOO_LARGE', 'Avatar image is too large')
  const isPng = buf.subarray(0, 8).equals(PNG_SIGNATURE)
  const isJpeg = buf.subarray(0, 3).equals(JPEG_SIGNATURE)
  if (!isPng && !isJpeg) throw new AppError('INVALID', 'Avatar must be a PNG or JPEG image')
  return buf
}

export function createAvatarService(deps: { rootDir: string }) {
  const dir = join(deps.rootDir, 'avatars')
  mkdirSync(dir, { recursive: true })

  function pathFor(personId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(personId)) throw new AppError('INVALID', 'Invalid person id')
    const full = resolve(join(dir, `${personId}.png`))
    if (!full.startsWith(resolve(dir))) throw new AppError('INVALID', 'Invalid person id')
    return full
  }

  /** Stores image bytes for a person and returns the osl-avatar:// URL. */
  function set(personId: string, bytes: Buffer): string {
    writeFileSync(pathFor(personId), bytes)
    return `osl-avatar://${personId}`
  }

  /** Returns the stored bytes, or null when the person has no avatar. */
  function get(personId: string): Buffer | null {
    try {
      const full = pathFor(personId)
      return existsSync(full) ? readFileSync(full) : null
    } catch {
      return null
    }
  }

  function remove(personId: string): void {
    try {
      unlinkSync(pathFor(personId))
    } catch {
      // already gone — removing an avatar twice is not an error
    }
  }

  return { set, get, remove }
}

export type AvatarService = ReturnType<typeof createAvatarService>
