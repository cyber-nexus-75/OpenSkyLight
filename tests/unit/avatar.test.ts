import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '../../src/main/services/errors'
import {
  createAvatarService,
  decodeBase64Image,
  MAX_AVATAR_BYTES
} from '../../src/main/services/avatarService'

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

describe('decodeBase64Image', () => {
  it('accepts PNG and JPEG payloads', () => {
    const png = decodeBase64Image(TINY_PNG.toString('base64'))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const jpeg = decodeBase64Image('/9j/4AAQSkZJRg==')
    expect(jpeg.subarray(0, 3).toString('hex')).toBe('ffd8ff')
  })

  it('rejects non-image and empty payloads', () => {
    expect(() => decodeBase64Image(Buffer.from('not an image').toString('base64'))).toThrow(AppError)
    expect(() => decodeBase64Image('')).toThrow(AppError)
    expect(() => decodeBase64Image(Buffer.alloc(0).toString('base64'))).toThrow(AppError)
  })

  it('rejects oversized payloads', () => {
    const big = Buffer.alloc(MAX_AVATAR_BYTES + 1, 0x89)
    expect(() => decodeBase64Image(big.toString('base64'))).toThrow(AppError)
  })
})

describe('avatarService', () => {
  const root = mkdtempSync(join(tmpdir(), 'osl-avatar-'))

  it('stores, reads back, and removes avatars', () => {
    const avatars = createAvatarService({ rootDir: root })
    const url = avatars.set('person-1', TINY_PNG)
    expect(url).toBe('osl-avatar://person-1')
    expect(existsSync(join(root, 'avatars', 'person-1.png'))).toBe(true)
    expect(avatars.get('person-1')?.equals(TINY_PNG)).toBe(true)
    expect(avatars.get('missing')).toBeNull()

    avatars.remove('person-1')
    expect(avatars.get('person-1')).toBeNull()
    // removing twice is not an error
    avatars.remove('person-1')
  })

  it('refuses person ids that would escape the avatar dir', () => {
    const avatars = createAvatarService({ rootDir: root })
    expect(() => avatars.set('../evil', TINY_PNG)).toThrow(AppError)
    expect(() => avatars.set('a/b', TINY_PNG)).toThrow(AppError)
    expect(() => avatars.set('.hidden', TINY_PNG)).toThrow(AppError)
    expect(avatars.get('../evil')).toBeNull()
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })
})
