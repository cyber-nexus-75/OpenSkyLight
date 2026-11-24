/** Push events from main -> renderer (sync engine, kiosk state). */
export type MainPushEvents = {
  'push:dataChanged': { domain: 'events' | 'people' | 'calendars' | 'settings' | 'lists' | 'meals' | 'chores' | 'groceries' }
  'push:syncStatus': { state: 'idle' | 'syncing' | 'error'; message?: string }
  'push:syncConflict': { title: string }
  'push:kioskIdle': { state: 'active' | 'screensaver' }
  'push:sleepState': { sleeping: boolean }
  'push:updateReady': { version: string }
}

export type PushChannel = keyof MainPushEvents

export const PUSH_CHANNEL_PREFIX = 'push:'
