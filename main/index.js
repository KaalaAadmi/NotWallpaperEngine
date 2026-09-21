'use strict'

const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeImage,
  screen,
  powerMonitor
} = require('electron')

// ── Chromium flags — must be set before app is ready ─────────────────────────
// Keep wallpaper video playing even when the window is not focused/visible.
// No audio-autoplay flag needed — all wallpaper video is always muted (PRD §3).
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
const path = require('path')
const storeModule = require('./store')
const performanceMonitor = require('./performance-monitor')
const hotkeys = require('./hotkeys')

// Platform wallpaper + screensaver modules
let wallpaperModule = null
let screensaverModule = null
let wallpaperExtensionMac = null  // macOS 15+ WallpaperAgent extension (lock screen)

switch (process.platform) {
  case 'darwin':
    wallpaperModule = require('./wallpaper-mac')
    screensaverModule = require('./screensaver-mac')
    wallpaperExtensionMac = require('./wallpaper-extension-mac')
    break
  case 'win32':
    wallpaperModule = require('./wallpaper-win')
    screensaverModule = require('./screensaver-win')
    break
  case 'linux':
    wallpaperModule = require('./wallpaper-linux')
    screensaverModule = require('./screensaver-linux')
    break
}

// ── State ─────────────────────────────────────────────────────────────────────

let tray = null
let settingsWindow = null
let isPaused = false
let isMuted = false

// ── App lifecycle ─────────────────────────────────────────────────────────────

// Flag used by wallpaper-mac.js restart logic
app.isQuitting = false

// Prevent second instance
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('second-instance', () => {
  openSettingsWindow()
})

// macOS: don't show in Dock
if (process.platform === 'darwin') {
  app.dock.hide()
}

app.whenReady().then(async () => {
  createTray()

  // Restore wallpaper from saved settings
  const wallpaperSettings = storeModule.getWallpaper()

  if (wallpaperSettings.videoPath) {
    await startWallpaper(wallpaperSettings.videoPath)
  }

  // Restore screensaver if enabled
  const screensaverSettings = storeModule.getScreensaver()
  if (screensaverSettings.enabled && screensaverSettings.videoPath) {
    await screensaverModule.install(screensaverSettings)
  }

  // Lock-screen state is persisted in a JSON file and survives restarts without
  // re-running activate() (which would trigger an admin password dialog at launch).
  // Nothing to do on startup.

  // Start performance monitoring
  performanceMonitor.start({
    onPause:  () => pauseWallpaper(),
    onResume: () => resumeWallpaper(),
    getSettings: storeModule.getPerformance
  })

  // Apply launch-at-login
  const general = storeModule.getGeneral()
  app.setLoginItemSettings({ openAtLogin: general.launchAtLogin })

  // Register global hotkeys
  hotkeys.init({
    pauseResume:   () => { if (isPaused) resumeWallpaper(); else pauseWallpaper() },
    nextWallpaper: () => {}, // placeholder for future playlist feature
    // Start screensaver immediately — functionally equivalent to locking the
    // screen since the screensaver requires a password on resume.
    // (Cmd+Ctrl+Q is system-reserved and cannot be captured by Electron.)
    lockScreen:    () => {
      if (process.platform === 'darwin' && screensaverModule?.startNow) {
        screensaverModule.startNow()
      }
    }
  }, storeModule.getHotkeys())
  // Listen for display connect/disconnect — re-apply wallpaper so new screens
  // get the right video immediately, and disconnected ones don't leave orphans.
  screen.on('display-added', async () => {
    const wp = storeModule.getWallpaper()
    if (wp.videoPath) await startWallpaper(wp.videoPath)
    // Notify settings UI so the monitor list refreshes
    notifySettingsWindow({ displays: getDisplayList() })
  })
  screen.on('display-removed', async () => {
    const wp = storeModule.getWallpaper()
    if (wp.videoPath) await startWallpaper(wp.videoPath)
    notifySettingsWindow({ displays: getDisplayList() })
  })
  // Re-patch Index.plist before every lock so WallpaperAgent picks up our
  // aerial slot on the second (and every subsequent) lock screen.
  if (process.platform === 'darwin' && wallpaperExtensionMac) {
    powerMonitor.on('lock-screen', () => {
      wallpaperExtensionMac.repatchOnLock()
    })
  }
})

app.on('window-all-closed', (e) => {
  // Prevent quitting when settings window is closed — we live in the tray
  e.preventDefault()
})

app.on('before-quit', async () => {
  app.isQuitting = true
  performanceMonitor.stop()
  if (wallpaperModule) await wallpaperModule.stop()
})

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray () {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)
  tray.setToolTip('NotWallpaperEngine')
  updateTrayMenu()
}

function updateTrayMenu () {
  const wallpaper = storeModule.getWallpaper()
  const hasWallpaper = !!wallpaper.videoPath
  const screensaver = storeModule.getScreensaver()

  const menuTemplate = [
    {
      label: 'NotWallpaperEngine',
      enabled: false
    },
    { type: 'separator' },
    {
      label: hasWallpaper ? `Wallpaper: ${path.basename(wallpaper.videoPath)}` : 'No wallpaper set',
      enabled: false
    },
    {
      label: 'Set Desktop Wallpaper…',
      click: () => pickWallpaperVideo()
    },
    {
      label: 'Set Screensaver…',
      click: () => pickScreensaverVideo()
    },
    { type: 'separator' },
    {
      label: isPaused ? 'Resume Wallpaper' : 'Pause Wallpaper',
      enabled: hasWallpaper,
      click: () => { if (isPaused) resumeWallpaper(); else pauseWallpaper() }
    },
    { type: 'separator' },
    {
      label: 'Settings…',
      click: () => openSettingsWindow()
    },
    { type: 'separator' },
    {
      label: 'Quit NotWallpaperEngine',
      click: () => app.quit()
    }
  ]

  const contextMenu = Menu.buildFromTemplate(menuTemplate)
  tray.setContextMenu(contextMenu)
}

// ── File pickers ──────────────────────────────────────────────────────────────

const VIDEO_FILTERS = [
  {
    name: 'Video Files',
    extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi']
  }
]

async function pickWallpaperVideo () {
  const result = await dialog.showOpenDialog({
    title: 'Select Wallpaper Video',
    filters: VIDEO_FILTERS,
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return
  const videoPath = result.filePaths[0]
  storeModule.setWallpaper({ videoPath })
  await startWallpaper(videoPath)
  updateTrayMenu()
  // Notify settings window if open
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings-updated', { wallpaper: storeModule.getWallpaper() })
  }
}

async function pickScreensaverVideo () {
  const result = await dialog.showOpenDialog({
    title: 'Select Screensaver Video',
    filters: VIDEO_FILTERS,
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return
  const videoPath = result.filePaths[0]
  storeModule.setScreensaver({ videoPath })

  const screensaverSettings = storeModule.getScreensaver()
  if (screensaverSettings.enabled) {
    await screensaverModule.install(screensaverSettings)
  }
  updateTrayMenu()
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings-updated', { screensaver: storeModule.getScreensaver() })
  }
}

// ── Wallpaper control ─────────────────────────────────────────────────────────

/**
 * Build the display list with `nativeId` populated.
 * On macOS, nativeId = CGDirectDisplayID (from `screen.getAllDisplays()[i].id`
 * which Electron derives from the native display ID on macOS).
 * On Win/Linux, nativeId === id (Electron integer id).
 */
function getDisplayList () {
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id || i + 1),
    label: `Display ${i + 1} (${d.size.width}×${d.size.height})`,
    bounds: d.bounds,
    // On macOS, Electron's display.id IS the CGDirectDisplayID (UInt32)
    nativeId: d.id || (i + 1)
  }))
}

async function startWallpaper (videoPath) {
  if (!wallpaperModule) return
  const settings = storeModule.getWallpaper()
  const displays = getDisplayList()
  await wallpaperModule.start({ videoPath, settings, displays })
  isPaused = false
  updateTrayMenu()
}

function pauseWallpaper () {
  if (!wallpaperModule || isPaused) return
  wallpaperModule.pause()
  isPaused = true
  updateTrayMenu()
}

function resumeWallpaper () {
  if (!wallpaperModule || !isPaused) return
  wallpaperModule.resume()
  isPaused = false
  updateTrayMenu()
}

function muteWallpaper () {
  if (!wallpaperModule?.setMuted) return
  wallpaperModule.setMuted(true)
  isMuted = true
}

function unmuteWallpaper () {
  if (!wallpaperModule?.setMuted) return
  wallpaperModule.setMuted(false)
  isMuted = false
}

// Send a command to all open wallpaper BrowserWindows (Win/Linux)
function broadcastToWallpaperWindows (cmd) {
  if (!wallpaperModule || typeof wallpaperModule.broadcast !== 'function') return
  wallpaperModule.broadcast(cmd)
}

function notifySettingsWindow (data) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings-updated', data)
  }
}

// ── Settings window ───────────────────────────────────────────────────────────

function openSettingsWindow () {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 680,
    height: 580,
    minWidth: 560,
    minHeight: 480,
    title: 'NotWallpaperEngine Settings',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'ui.html'))

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-all-settings', () => ({
  wallpaper: storeModule.getWallpaper(),
  screensaver: storeModule.getScreensaver(),
  performance: storeModule.getPerformance(),
  general: storeModule.getGeneral(),
  hotkeys: storeModule.getHotkeys(),
  platform: process.platform,
  displays: getDisplayList()
}))

ipcMain.handle('save-wallpaper-settings', async (_event, patch) => {
  storeModule.setWallpaper(patch)
  const wallpaperSettings = storeModule.getWallpaper()
  if (wallpaperSettings.videoPath) {
    await startWallpaper(wallpaperSettings.videoPath)
  }
  updateTrayMenu()
  return { ok: true }
})

ipcMain.handle('save-screensaver-settings', async (_event, patch) => {
  storeModule.setScreensaver(patch)
  const screensaverSettings = storeModule.getScreensaver()
  if (screensaverSettings.enabled && screensaverSettings.videoPath) {
    await screensaverModule.install(screensaverSettings)
  } else {
    await screensaverModule.uninstall()
  }
  updateTrayMenu()
  return { ok: true }
})

ipcMain.handle('save-performance-settings', (_event, patch) => {
  storeModule.setPerformance(patch)
  return { ok: true }
})

ipcMain.handle('save-general-settings', (_event, patch) => {
  storeModule.setGeneral(patch)
  app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin })
  return { ok: true }
})

ipcMain.handle('pick-video', async (_event, purpose) => {
  const result = await dialog.showOpenDialog(settingsWindow || {}, {
    title: purpose === 'screensaver' ? 'Select Screensaver Video' : 'Select Wallpaper Video',
    filters: VIDEO_FILTERS,
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('pause-wallpaper', () => {
  pauseWallpaper()
  return { isPaused }
})

ipcMain.handle('resume-wallpaper', () => {
  resumeWallpaper()
  return { isPaused }
})

ipcMain.handle('get-wallpaper-state', () => ({ isPaused, isMuted }))

ipcMain.handle('mute-wallpaper', () => {
  muteWallpaper()
  return { isMuted }
})

ipcMain.handle('unmute-wallpaper', () => {
  unmuteWallpaper()
  return { isMuted }
})

ipcMain.handle('save-hotkeys', (_event, patch) => {
  storeModule.setHotkeys(patch)
  hotkeys.applyHotkeys(storeModule.getHotkeys())
  return { ok: true }
})

// ── macOS WallpaperAgent extension IPC ────────────────────────────────────────

ipcMain.handle('mac-extension-status', () => {
  if (!wallpaperExtensionMac) return { available: false }
  const settings = storeModule.getWallpaper()
  const active = settings.videoPath
    ? wallpaperExtensionMac.isActiveFor(settings.videoPath)
    : wallpaperExtensionMac.isActive()
  return {
    available: true,
    installed: true,
    active
  }
})

ipcMain.handle('mac-extension-install', async () => {
  if (!wallpaperExtensionMac) return { ok: false, error: 'Not macOS' }
  try {
    const ok = wallpaperExtensionMac.install()  // no-op, always succeeds
    return { ok }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('mac-extension-activate', async (_event, videoPath) => {
  if (!wallpaperExtensionMac) return { ok: false, error: 'Not macOS' }
  try {
    const settings = storeModule.getWallpaper()
    const vp = videoPath || settings.videoPath
    await wallpaperExtensionMac.activate(vp)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('mac-extension-deactivate', async () => {
  if (!wallpaperExtensionMac) return { ok: false }
  try {
    await wallpaperExtensionMac.deactivate()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('mac-extension-check-prereqs', () => {
  if (!wallpaperExtensionMac?.checkPrerequisites) return { ok: true, missing: [] }
  return wallpaperExtensionMac.checkPrerequisites()
})

ipcMain.handle('screensaver-check-prereqs', () => {
  // Only meaningful on Linux — on other platforms there are no external deps.
  if (process.platform !== 'linux' || !screensaverModule?.checkPrerequisites) {
    return { ok: true, missing: [] }
  }
  return screensaverModule.checkPrerequisites()
})

// Start the screensaver immediately (lock-screen shortcut fallback)
ipcMain.handle('start-screensaver-now', () => {
  if (process.platform === 'darwin' && screensaverModule?.startNow) {
    screensaverModule.startNow()
    return { ok: true }
  }
  return { ok: false, error: 'Not supported on this platform' }
})
