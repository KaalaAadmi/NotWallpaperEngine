'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Expose a minimal API to the wallpaper BrowserWindow (Win/Linux).
// Only exposes the ability to receive commands from the main process.
contextBridge.exposeInMainWorld('nweWallpaper', {
  onCommand: (cb) => ipcRenderer.on('wallpaper-command', (_event, cmd) => cb(cmd))
})
