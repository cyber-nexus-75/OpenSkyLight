/**
 * Server-mode stand-in for `electron-updater`. The updater no-ops because the
 * stubbed `app.isPackaged` is false; server deployments update via their package
 * manager and restart the process.
 */
export const autoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on(_event: string, _listener: unknown): void {},
  checkForUpdates(): Promise<null> {
    return Promise.resolve(null)
  },
  quitAndInstall(_isSilent?: boolean, _isForceAfterRun?: boolean): void {}
}
