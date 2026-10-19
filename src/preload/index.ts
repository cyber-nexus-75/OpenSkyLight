import { contextBridge, ipcRenderer } from 'electron'

const ALLOWED_INVOKE_PREFIXES = [
  'app:',
  'settings:',
  'people:',
  'calendars:',
  'events:',
  'google:',
  'caldav:',
  'ics:',
  'sync:',
  'weather:',
  'auth:',
  'chores:',
  'stars:',
  'rewards:',
  'lists:',
  'listItems:',
  'meals:',
  'screensaver:',
  'kiosk:',
  'rss:',
  'camera:',
  'companion:',
  'birdnet:'
]
const PUSH_PREFIX = 'push:'

export interface OslBridge {
  invoke(channel: string, payload: unknown): Promise<unknown>
  on(channel: string, callback: (data: unknown) => void): () => void
}

const bridge: OslBridge = {
  invoke(channel, payload) {
    if (!ALLOWED_INVOKE_PREFIXES.some((p) => channel.startsWith(p))) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel, callback) {
    if (!channel.startsWith(PUSH_PREFIX)) return () => {}
    const listener = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('osl', bridge)
