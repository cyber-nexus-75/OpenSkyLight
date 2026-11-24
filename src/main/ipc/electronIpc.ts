import { ipcMain } from 'electron'
import { dispatch, type ChannelTable, type Services } from './router'

/** Desktop only: wire the channel table into Electron's ipcMain (PIN-gated). */
export function registerIpcHandlers(services: Services, table: ChannelTable): void {
  for (const channel of table.keys()) {
    ipcMain.handle(channel, (_event, payload) => dispatch(services, table, channel, payload, { gate: 'pin' }))
  }
}
