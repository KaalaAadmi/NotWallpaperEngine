'use strict'

/**
 * hotkeys.js
 * ───────────
 * Registers and manages global shortcuts via Electron's globalShortcut API.
 *
 * Supported actions:
 *   pauseResume    — toggle wallpaper playback
 *   nextWallpaper  — cycle to next wallpaper (future)
 *   lockScreen     — start screensaver immediately (macOS, §6.4)
 *
 * Hotkey strings use Electron accelerator format:
 *   e.g. "CommandOrControl+Shift+P", "Alt+F9", "MediaPlayPause"
 *   https://www.electronjs.org/docs/latest/api/accelerator
 */

const { globalShortcut, app } = require('electron')

// ── State ─────────────────────────────────────────────────────────────────────

// Callbacks injected by index.js
let _actions = {
  pauseResume:   () => {},
  nextWallpaper: () => {},
  lockScreen:    () => {}
}

// Currently registered accelerators — track so we can unregister selectively
const _registered = new Map() // actionName → accelerator

// ── Registration ──────────────────────────────────────────────────────────────

function registerAll (hotkeys) {
  for (const [action, accelerator] of Object.entries(hotkeys)) {
    register(action, accelerator)
  }
}

function register (action, accelerator) {
  // Unregister previous binding for this action if any
  if (_registered.has(action)) {
    const old = _registered.get(action)
    try { globalShortcut.unregister(old) } catch (e) {}
    _registered.delete(action)
  }

  if (!accelerator || accelerator.trim() === '') return

  const handler = _actions[action]
  if (!handler) {
    console.warn(`[hotkeys] Unknown action: ${action}`)
    return
  }

  try {
    const ok = globalShortcut.register(accelerator, handler)
    if (ok) {
      _registered.set(action, accelerator)
      console.log(`[hotkeys] Registered "${accelerator}" → ${action}`)
    } else {
      console.warn(`[hotkeys] Failed to register "${accelerator}" for ${action} (already in use?)`)
    }
  } catch (e) {
    console.warn(`[hotkeys] Invalid accelerator "${accelerator}" for ${action}:`, e.message)
  }
}

function unregisterAll () {
  for (const accelerator of _registered.values()) {
    try { globalShortcut.unregister(accelerator) } catch (e) {}
  }
  _registered.clear()
}

// ── Accessibility check (macOS) ───────────────────────────────────────────────
// globalShortcut requires Accessibility permission on macOS 10.14+.
// Without it, register() silently returns true but never fires.

function checkAccessibility () {
  if (process.platform !== 'darwin') return true
  try {
    // systemPreferences is only available in Electron — guard for test environments
    const { systemPreferences } = require('electron')
    if (typeof systemPreferences.isTrustedAccessibilityClient !== 'function') return true
    const trusted = systemPreferences.isTrustedAccessibilityClient(false)
    if (!trusted) {
      console.warn(
        '[hotkeys] Accessibility permission NOT granted.\n' +
        '  Global hotkeys will not fire until you grant access:\n' +
        '  System Settings → Privacy & Security → Accessibility → enable NotWallpaperEngine'
      )
      // Prompt once — pass true to show the system dialog
      systemPreferences.isTrustedAccessibilityClient(true)
    }
    return trusted
  } catch (e) {
    return true
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize with action callbacks and initial hotkey map from store.
 * Call once after app.whenReady().
 */
function init (actions, hotkeys) {
  _actions = { ..._actions, ...actions }

  checkAccessibility()
  registerAll(hotkeys)

  // Unregister on quit to be clean
  app.on('will-quit', unregisterAll)
}

/**
 * Apply a new hotkey map (e.g. after user saves settings).
 * Only re-registers keys that changed.
 */
function applyHotkeys (hotkeys) {
  for (const [action, accelerator] of Object.entries(hotkeys)) {
    const current = _registered.get(action) || ''
    if (current !== (accelerator || '')) {
      register(action, accelerator)
    }
  }
}

/**
 * Get the list of registered shortcuts for display in the UI.
 */
function getRegistered () {
  const result = {}
  for (const [action, accelerator] of _registered) {
    result[action] = accelerator
  }
  return result
}

module.exports = { init, applyHotkeys, unregisterAll, getRegistered }
