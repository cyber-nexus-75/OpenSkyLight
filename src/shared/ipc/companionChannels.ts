import type { IpcChannel } from './contract'

/**
 * The ONLY channels the companion HTTP API will dispatch. Everything else
 * (settings, auth, google, camera, screensaver, unifi, updater…) returns 404
 * even with a valid bearer token — a paired phone edits family data, it does
 * not administer the kiosk. Full calendar CRUD is included per the trust
 * decision: pairing (PIN-gated on the display) IS the credential.
 */
export const COMPANION_CHANNELS: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'lists:getAll',
  'lists:create',
  'lists:update',
  'lists:delete',
  'listItems:add',
  'listItems:toggle',
  'listItems:delete',
  'listItems:clearChecked',
  'meals:getRange',
  'meals:set',
  'chores:list',
  'chores:create',
  'chores:update',
  'chores:getDay',
  'chores:complete',
  'chores:uncomplete',
  'stars:balances',
  'events:getOccurrences',
  'events:get',
  'events:create',
  'events:update',
  'events:delete',
  'calendars:list',
  'people:list',
  'people:setAvatar',
  'ai:importEvents',
  'groceries:getState',
  'pantry:add',
  'pantry:update',
  'pantry:adjust',
  'pantry:remove',
  'shopping:add',
  'shopping:update',
  'shopping:toggle',
  'shopping:remove',
  'shopping:clearChecked',
  'shopping:addLowStock',
  'groceries:listReceipts',
  'groceries:receiptDetail',
  'groceries:applyReceipt'
  // note: groceries:scanReceipt rides the binary /api/receipt endpoint instead
  // (64 KB RPC body cap), and groceries:openFrys/copyList are kiosk-only —
  // phones open store links and use the clipboard directly in the browser
])
