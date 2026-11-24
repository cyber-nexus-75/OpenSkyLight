import { join, resolve, extname, sep } from 'node:path'

export const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

/**
 * Resolves a renderer-supplied photo name to a full path strictly inside `dir`,
 * or null when the name tries to escape, hide, or smuggle a non-photo file.
 * Pure path logic — no Electron imports — so it is unit-testable.
 */
export function resolvePhotoInDir(dir: string, name: string): string | null {
  const root = resolve(dir)
  const full = resolve(join(root, name))
  // the resolved file must stay strictly inside the dir (trailing-separator
  // check blocks sibling directories whose name merely prefixes the dir name)
  if (!full.startsWith(root + sep)) return null
  if (name.startsWith('.') || name.includes('/') || name.includes('\\')) return null
  if (!PHOTO_EXTENSIONS.has(extname(name).toLowerCase())) return null
  return full
}
