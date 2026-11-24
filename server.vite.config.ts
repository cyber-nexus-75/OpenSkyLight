import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

// Everything the server needs at runtime stays external (node_modules is
// present next to out/server); `electron` and `electron-updater` are bundled
// via alias to the server-mode stubs instead.
const STUBBED = new Set(['electron', 'electron-updater'])
const externals = new Set(
  [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter(
    (d) => !STUBBED.has(d) && !d.startsWith('@types/')
  )
)

/**
 * Headless server bundle: plain Node, no Electron. Aliases `electron` to the
 * stub in src/server so the exact same main-process services run on a server.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: 'electron-updater', replacement: resolve(__dirname, 'src/server/electronUpdaterStub.ts') },
      { find: 'electron', replacement: resolve(__dirname, 'src/server/electronStub.ts') },
      { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
      { find: '@main', replacement: resolve(__dirname, 'src/main') }
    ]
  },
  build: {
    target: 'node22',
    outDir: resolve(__dirname, 'out/server'),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/server/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      external: (id: string) => {
        if (STUBBED.has(id)) return false
        if (id.startsWith('node:')) return true
        return externals.has(id) || [...externals].some((d) => id.startsWith(`${d}/`))
      }
    }
  }
})
