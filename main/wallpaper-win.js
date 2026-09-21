'use strict'

/**
 * wallpaper-win.js
 * ─────────────────
 * Injects an Electron BrowserWindow into Windows' WorkerW layer (behind
 * desktop icons, above the static wallpaper) using Win32 APIs via ffi-napi.
 *
 * Win32 technique (same approach used by Wallpaper Engine):
 *  1. Get the Progman window handle.
 *  2. Send 0x052C to Progman to force it to spawn a WorkerW child window.
 *  3. Enumerate top-level windows to find the WorkerW that has a SHELLDLL_DefView child.
 *  4. SetParent(our HWND, workerWHWND) to reparent our BrowserWindow into that layer.
 *
 * Multi-monitor: creates one BrowserWindow per display.
 */

const { BrowserWindow, screen } = require('electron')
const path = require('path')

// Lazy-load ffi-napi (Windows only, optional dep)
let ffi, ref, user32

function loadFfi () {
  if (ffi) return true
  try {
    ffi = require('ffi-napi')
    ref = require('ref-napi')
    const HWND = ref.types.uint64
    const LPARAM = ref.types.int64
    const WPARAM = ref.types.uint64
    const UINT = ref.types.uint32
    const DWORD = ref.types.uint32
    const BOOL = ref.types.int32

    user32 = ffi.Library('user32', {
      FindWindowA: ['uint64', ['string', 'string']],
      SendMessageTimeoutA: ['int64', ['uint64', 'uint32', 'uint64', 'int64', 'uint32', 'uint32', 'pointer']],
      EnumWindows: ['int32', ['pointer', 'int64']],
      FindWindowExA: ['uint64', ['uint64', 'uint64', 'string', 'string']],
      SetParent: ['uint64', ['uint64', 'uint64']],
      ShowWindow: [BOOL, ['uint64', UINT]],
      MoveWindow: [BOOL, ['uint64', 'int32', 'int32', 'int32', 'int32', BOOL]],
      GetForegroundWindow: ['uint64', []],
      IsWindowVisible: [BOOL, ['uint64']]
    })
    return true
  } catch (e) {
    console.error('[wallpaper-win] ffi-napi not available:', e.message)
    return false
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

const wallpaperWindows = new Map() // displayId → BrowserWindow
let workerWHWND = BigInt(0)

// ── WorkerW injection ─────────────────────────────────────────────────────────

function getWorkerWHandle () {
  if (!loadFfi()) return BigInt(0)

  // Step 1: find Progman
  const progman = BigInt(user32.FindWindowA('Progman', null))
  if (!progman) {
    console.error('[wallpaper-win] Could not find Progman window')
    return BigInt(0)
  }

  // Step 2: send 0x052C to spawn WorkerW
  const resultPtr = Buffer.alloc(8)
  user32.SendMessageTimeoutA(progman, 0x052C, BigInt(0), BigInt(0), 0, 1000, resultPtr)

  // Step 3: enumerate windows to find the WorkerW that has a SHELLDLL_DefView child
  let foundWorkerW = BigInt(0)

  const enumCallback = ffi.Callback('int32', ['uint64', 'int64'], (hwnd, _lparam) => {
    const shellView = BigInt(user32.FindWindowExA(hwnd, BigInt(0), 'SHELLDLL_DefView', null))
    if (shellView) {
      // The next WorkerW sibling is our target
      const workerW = BigInt(user32.FindWindowExA(BigInt(0), hwnd, 'WorkerW', null))
      if (workerW) {
        foundWorkerW = workerW
        return 0 // stop enumeration
      }
    }
    return 1 // continue
  })

  user32.EnumWindows(enumCallback, BigInt(0))

  return foundWorkerW
}

// ── Per-display video helper ──────────────────────────────────────────────────

function videoForDisplay (display, settings) {
  const perDisplay = settings.perDisplay || {}
  return perDisplay[String(display.id)] || settings.videoPath || ''
}

// ── Public API ────────────────────────────────────────────────────────────────

async function start ({ videoPath, settings, displays }) {
  if (!loadFfi()) {
    console.warn('[wallpaper-win] ffi-napi unavailable — falling back to transparent BrowserWindow')
  }

  // Get WorkerW handle once
  workerWHWND = getWorkerWHandle()

  // Create a window per display, using per-display video when configured
  for (const display of displays) {
    const vp = videoForDisplay(display, settings)
    await createWindowForDisplay(display, vp || videoPath, settings)
  }
}

async function createWindowForDisplay (display, videoPath, settings) {
  const { bounds, id } = display

  // Destroy existing window for this display if any
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

  // Reparent into WorkerW layer
  if (workerWHWND && user32) {
    const nativeHandle = win.getNativeWindowHandle()
    const hwnd = process.arch === 'x64'
      ? nativeHandle.readBigUInt64LE(0)
      : BigInt(nativeHandle.readUInt32LE(0))

    user32.SetParent(hwnd, workerWHWND)
    user32.ShowWindow(hwnd, 1) // SW_SHOWNORMAL

    // Ensure window fills its display bounds within WorkerW
    user32.MoveWindow(hwnd, bounds.x, bounds.y, bounds.width, bounds.height, 1)
  } else {
    // Fallback: show as always-on-bottom window if WorkerW injection failed
    win.setAlwaysOnTop(false)
    win.showInactive()
  }

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
  workerWHWND = BigInt(0)
}

module.exports = { start, pause, resume, stop, broadcast }
