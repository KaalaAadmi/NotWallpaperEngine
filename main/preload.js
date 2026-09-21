'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Expose a safe API to the renderer (settings UI)
contextBridge.exposeInMainWorld('nwe', {
  getAllSettings: () => ipcRenderer.invoke('get-all-settings'),
  saveWallpaperSettings: (patch) => ipcRenderer.invoke('save-wallpaper-settings', patch),
  saveScreensaverSettings: (patch) => ipcRenderer.invoke('save-screensaver-settings', patch),
  savePerformanceSettings: (patch) => ipcRenderer.invoke('save-performance-settings', patch),
  saveGeneralSettings: (patch) => ipcRenderer.invoke('save-general-settings', patch),
  saveHotkeys: (patch) => ipcRenderer.invoke('save-hotkeys', patch),
  pickVideo: (purpose) => ipcRenderer.invoke('pick-video', purpose),
  pauseWallpaper: () => ipcRenderer.invoke('pause-wallpaper'),
  resumeWallpaper: () => ipcRenderer.invoke('resume-wallpaper'),
  getWallpaperState: () => ipcRenderer.invoke('get-wallpaper-state'),
  onSettingsUpdated: (cb) => ipcRenderer.on('settings-updated', (_event, data) => cb(data)),
  // macOS lock screen via aerial slot replacement
  macExtensionStatus: () => ipcRenderer.invoke('mac-extension-status'),
  macExtensionInstall: () => ipcRenderer.invoke('mac-extension-install'),
  macExtensionActivate: (videoPath) => ipcRenderer.invoke('mac-extension-activate', videoPath),
  macExtensionDeactivate: () => ipcRenderer.invoke('mac-extension-deactivate'),
  macExtensionCheckPrereqs: () => ipcRenderer.invoke('mac-extension-check-prereqs'),
  // Check external screensaver dependencies (Linux: xscreensaver + mpv)
  screensaverCheckPrereqs: () => ipcRenderer.invoke('screensaver-check-prereqs'),
  // Start the screensaver immediately (lock-screen shortcut / button)
  startScreensaverNow: () => ipcRenderer.invoke('start-screensaver-now')
})
