'use strict'

/**
 * wallpaper-linux.js
 * ───────────────────
 * Sets an Electron BrowserWindow as the desktop wallpaper on Linux (X11)
 * by setting _NET_WM_WINDOW_TYPE to _NET_WM_WINDOW_TYPE_DESKTOP via xprop.
 *
 * Electron's BrowserWindow type:'desktop' hint sets the right window type on
 * many compositors automatically. We also call xprop after the window is shown
 * to ensure the property is set on compositors that ignore the hint.
 *
 * Multi-monitor: creates one BrowserWindow per display.
 */

const { BrowserWindow } = require('electron')
const path = require('path')
const { execSync } = require('child_process')

// ── State ─────────────────────────────────────────────────────────────────────

const wallpaperWindows = new Map() // displayId → BrowserWindow

// ── xprop setter ──────────────────────────────────────────────────────────────

function setDesktopTypeViaXprop (xid) {
  const id = typeof xid === 'bigint' ? xid.toString() : String(xid)
  try {
    execSync(`xprop -id ${id} -f _NET_WM_WINDOW_TYPE 32a -set _NET_WM_WINDOW_TYPE _NET_WM_WINDOW_TYPE_DESKTOP`)
    execSync(`xprop -id ${id} -f _NET_WM_STATE 32a -set _NET_WM_STATE _NET_WM_STATE_BELOW`)
  } catch (e) {
    console.error('[wallpaper-linux] xprop failed:', e.message)
  }
}

// ── Per-display video helper ──────────────────────────────────────────────────

function videoForDisplay (display, settings) {
  if (settings.mirrorToAll !== false) return settings.videoPath || ''
  const perDisplay = settings.perDisplay || {}
  return perDisplay[String(display.id)] || settings.videoPath || ''
}

// ── Public API ────────────────────────────────────────────────────────────────

async function start ({ videoPath, settings, displays }) {
  for (const display of displays) {
    const vp = videoForDisplay(display, settings)
    await createWindowForDisplay(display, vp || videoPath, settings)
  }
}

async function createWindowForDisplay (display, videoPath, settings) {
  const { bounds, id } = display

  if (wallpaperWindows.has(id)) {
    const old = wallpaperWindows.get(id)
    if (!old.isDestroyed()) old.destroy()
  }

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    // X11-specific: request below other windows and desktop type
    type: 'desktop',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'wallpaper-preload.js')
    }
  })

  const params = new URLSearchParams({
    videoPath,
    fitMode: settings.fitMode || 'cover',
    speed: String(settings.playbackSpeed || 1)
    // muted/volume omitted — audio is always disabled (PRD §3)
  })

  await win.loadFile(
    path.join(__dirname, '..', 'renderer', 'wallpaper.html'),
    { search: params.toString() }
  )

  win.setIgnoreMouseEvents(true)

  // Get X11 window ID from native handle and set desktop window type
  const handleBuf = win.getNativeWindowHandle()
  const xid = process.arch === 'x64'
    ? handleBuf.readBigUInt64LE(0)
    : BigInt(handleBuf.readUInt32LE(0))

  setDesktopTypeViaXprop(xid)

  win.showInactive()
  wallpaperWindows.set(id, win)
}

function broadcast (cmd) {
  for (const win of wallpaperWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('wallpaper-command', cmd)
  }
}

function pause () { broadcast({ type: 'pause' }) }
function resume () { broadcast({ type: 'resume' }) }

async function stop () {
  for (const win of wallpaperWindows.values()) {
    if (!win.isDestroyed()) win.destroy()
  }
  wallpaperWindows.clear()
}

module.exports = { start, pause, resume, stop, broadcast }
