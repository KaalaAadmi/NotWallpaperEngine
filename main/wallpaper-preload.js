'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Exposed to wallpaper.html renderer
contextBridge.exposeInMainWorld('nweWallpaper', {
  onCommand: (cb) => ipcRenderer.on('wallpaper-command', (_event, cmd) => cb(cmd))
})
