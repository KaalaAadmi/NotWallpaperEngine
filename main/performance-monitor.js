'use strict'

/**
 * performance-monitor.js
 * ───────────────────────
 * Monitors system state and calls onPause/onResume based on:
 *  - Power source (battery vs AC)
 *  - Screen lock state
 *  - Fullscreen app detection (platform-specific polling)
 *
 * All callbacks are debounced to avoid rapid pause/resume cycles.
 */

const { powerMonitor, screen } = require('electron')

// Lazy-load platform-specific fullscreen detection
let ffi = null
let user32 = null

// ── State ─────────────────────────────────────────────────────────────────────

let onPause = () => {}
let onResume = () => {}
let getSettings = () => ({})

let isOnBattery = false
let isLocked = false
let isFullscreen = false
let isPausedByMonitor = false

let fullscreenPollInterval = null
const FULLSCREEN_POLL_MS = 3000

// ── Debounce helper ───────────────────────────────────────────────────────────

let debounceTimer = null
function scheduleCheck () {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(evaluateState, 300)
}

// ── State evaluation ──────────────────────────────────────────────────────────

function evaluateState () {
  const settings = getSettings()
  const shouldPause =
    (settings.pauseOnBattery && isOnBattery) ||
    (settings.pauseOnLock && isLocked) ||
    (settings.pauseOnFullscreen && isFullscreen)

  if (shouldPause && !isPausedByMonitor) {
    isPausedByMonitor = true
    onPause()
  } else if (!shouldPause && isPausedByMonitor) {
    isPausedByMonitor = false
    onResume()
  }
}

// ── Battery ───────────────────────────────────────────────────────────────────

function initBatteryMonitoring () {
  // Check initial state
  try {
    isOnBattery = powerMonitor.onBatteryPower
  } catch (e) {
    isOnBattery = false
  }

  powerMonitor.on('on-battery', () => {
    isOnBattery = true
    scheduleCheck()
  })

  powerMonitor.on('on-ac', () => {
    isOnBattery = false
    scheduleCheck()
  })
}

// ── Lock screen ───────────────────────────────────────────────────────────────

function initLockMonitoring () {
  powerMonitor.on('lock-screen', () => {
    isLocked = true
    scheduleCheck()
  })

  powerMonitor.on('unlock-screen', () => {
    isLocked = false
    scheduleCheck()
  })
}

// ── Fullscreen detection ──────────────────────────────────────────────────────

function initFullscreenMonitoring () {
  if (process.platform === 'darwin') {
    startFullscreenPollMac()
  } else if (process.platform === 'win32') {
    startFullscreenPollWin()
  } else {
    startFullscreenPollLinux()
  }
}

// macOS: check if any window is fullscreen using NSScreen.screens.any { $0.visibleFrame != $0.frame }
// Simplified approach: use screen API to detect fullscreen apps
function startFullscreenPollMac () {
  // Electron's screen API doesn't expose fullscreen app state directly.
  // We use a heuristic: if any display has a window that equals its total frame
  // (i.e., no menu bar space), a fullscreen app is likely active.
  fullscreenPollInterval = setInterval(() => {
    const displays = screen.getAllDisplays()
    const anyFullscreen = displays.some((d) => {
      // workAreaSize excludes menu bar; if a window covers the full bounds, something is fullscreen
      return d.workAreaSize.height < d.size.height - 1
        ? false // Menu bar is still visible — no fullscreen
        : false // Can't reliably detect without native call; use conservative false
    })
    // For now: rely on the Swift helper reporting fullscreen state via stdout
    // (The mac-helper emits { type: "fullscreen", active: true/false } messages)
    // This is handled in wallpaper-mac.js handleHelperMessage
    if (anyFullscreen !== isFullscreen) {
      isFullscreen = anyFullscreen
      scheduleCheck()
    }
  }, FULLSCREEN_POLL_MS)
}

// Windows: use SHQueryUserNotificationState via ffi-napi
function startFullscreenPollWin () {
  try {
    ffi = require('ffi-napi')
    const shell32 = ffi.Library('shell32', {
      SHQueryUserNotificationState: ['int32', ['pointer']]
    })

    const ref = require('ref-napi')
    fullscreenPollInterval = setInterval(() => {
      try {
        const state = ref.alloc(ref.types.uint32)
        shell32.SHQueryUserNotificationState(state)
        // QUNS_RUNNING_D3D_FULL_SCREEN = 3, QUNS_PRESENTATION_MODE = 4
        const val = state.deref()
        const fullscreen = val === 3 || val === 4
        if (fullscreen !== isFullscreen) {
          isFullscreen = fullscreen
          scheduleCheck()
        }
      } catch (e) {
        // ignore poll errors
      }
    }, FULLSCREEN_POLL_MS)
  } catch (e) {
    console.warn('[performance-monitor] SHQueryUserNotificationState unavailable:', e.message)
  }
}

// Linux: check _NET_WM_STATE_FULLSCREEN on the active window via xprop
function startFullscreenPollLinux () {
  const { exec } = require('child_process')
  fullscreenPollInterval = setInterval(() => {
    exec('xprop -id $(xprop -root 32x _NET_ACTIVE_WINDOW | cut -d " " -f 5) _NET_WM_STATE 2>/dev/null', (err, stdout) => {
      const fullscreen = !err && stdout.includes('_NET_WM_STATE_FULLSCREEN')
      if (fullscreen !== isFullscreen) {
        isFullscreen = fullscreen
        scheduleCheck()
      }
    })
  }, FULLSCREEN_POLL_MS)
}

// ── Public API ────────────────────────────────────────────────────────────────

function start (options) {
  onPause    = options.onPause    || (() => {})
  onResume   = options.onResume   || (() => {})
  getSettings = options.getSettings || (() => ({}))

  initBatteryMonitoring()
  initLockMonitoring()
  initFullscreenMonitoring()

  // Initial state check
  scheduleCheck()
}

function stop () {
  if (fullscreenPollInterval) {
    clearInterval(fullscreenPollInterval)
    fullscreenPollInterval = null
  }
  clearTimeout(debounceTimer)
}

// Called by wallpaper-mac.js when the Swift helper reports fullscreen changes
function setFullscreenState (active) {
  if (active !== isFullscreen) {
    isFullscreen = active
    scheduleCheck()
  }
}

module.exports = { start, stop, setFullscreenState }
