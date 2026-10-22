import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { resolvePhotoInDir } from '../../src/main/kiosk/photoGuard'

const dir = resolve('/home/user/screensaver-cache')

describe('photo guard (osl-photo:// path resolution)', () => {
  it('accepts a plain photo name', () => {
    expect(resolvePhotoInDir(dir, 'sunset.jpg')).toBe(join(dir, 'sunset.jpg'))
    expect(resolvePhotoInDir(dir, 'IMG_0001.webp')).toBe(join(dir, 'IMG_0001.webp'))
  })

  it('blocks traversal out of the dir', () => {
    expect(resolvePhotoInDir(dir, '../secrets.txt')).toBeNull()
    expect(resolvePhotoInDir(dir, '..\\secrets.txt')).toBeNull()
    expect(resolvePhotoInDir(dir, 'sub/../../escape.png')).toBeNull()
  })

  it('blocks sibling directories whose name prefixes the dir name (prefix bug)', () => {
    // resolves to /home/user/screensaver-cache-evil/x.png — used to pass a
    // startsWith(dir) check without a trailing separator
    expect(resolvePhotoInDir(dir, '../screensaver-cache-evil/x.png')).toBeNull()
  })

  it('blocks the dir itself and non-file names', () => {
    expect(resolvePhotoInDir(dir, '')).toBeNull()
    expect(resolvePhotoInDir(dir, '.')).toBeNull()
    expect(resolvePhotoInDir(dir, '.hidden.png')).toBeNull()
  })

  it('blocks non-photo extensions', () => {
    expect(resolvePhotoInDir(dir, 'notes.txt')).toBeNull()
    expect(resolvePhotoInDir(dir, 'db.sqlite')).toBeNull()
    expect(resolvePhotoInDir(dir, 'noext')).toBeNull()
  })
})
