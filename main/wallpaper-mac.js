'use strict'

/**
 * wallpaper-mac.js
 * ─────────────────
 * Manages the macOS desktop live wallpaper by spawning the bundled Swift
 * CLI binary (mac-helper).  Communication happens over newline-delimited
 * JSON on stdin/stdout.
 *
 * Multi-monitor strategy:
 *   • Default (mirrorToAll=true): the helper receives a single "set-video"
 *     command which fans out to every NSScreen automatically.
 *   • Per-display (mirrorToAll=false): after the global "set-video" the JS
 *     side sends one "set-display-video" per display that has an override,
 *     identified by its CGDirectDisplayID (Int).
 *
 * Display connect/disconnect:  the helper emits "display-added" /
 * "display-removed" JSON messages.  wallpaper-mac.js re-sends the
 * appropriate video for any newly-added display.
 *
 * Lock-screen note:
 *   On macOS 15+, the lock-screen wallpaper is handled by wallpaper-extension-mac.js
 *   through the system aerial replacement pipeline. This module is desktop-only.
 */

const { app } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')

// ── Helper binary path ────────────────────────────────────────────────────────

function getHelperPath () {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'mac-helper')
  }
  return path.join(__dirname, '..', 'native', 'mac-helper', '.build', 'release', 'mac-helper')
}

// ── State ─────────────────────────────────────────────────────────────────────

let helperProcess = null
let currentSettings = null  // last-applied { videoPath, settings, displays }
let pendingRestart = false

// ── Helper lifecycle ──────────────────────────────────────────────────────────

function isHelperAvailable () {
  return fs.existsSync(getHelperPath())
}

function ensureExecutable (p) {
  try { fs.chmodSync(p, 0o755) } catch (e) {}
}

/**
 * Spawn the Swift helper for the given global videoPath + settings.
 * After the helper is ready, sends per-display overrides when needed.
 */
function spawnHelper (videoPath, settings) {
  const helperPath = getHelperPath()
  if (!isHelperAvailable()) {
    console.warn('[wallpaper-mac] mac-helper not found — run: npm run build:mac-helper')
    return
  }

  ensureExecutable(helperPath)

  if (helperProcess) {
    try { helperProcess.kill('SIGTERM') } catch (e) {}
    helperProcess = null
  }

  // Pass the live muted state so a display reconnect doesn't reset audio.
  const muted = settings.muted !== false  // default true if not provided
  const args = [
    '--video',  videoPath,
    '--fit',    settings.fitMode || 'cover',
    '--speed',  String(settings.playbackSpeed || 1.0),
    '--muted',  muted ? '1' : '0'
  ]

  helperProcess = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  helperProcess.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      try {
        const msg = JSON.parse(line)
        handleHelperMessage(msg)
      } catch (_) {
        console.log('[mac-helper]', line)
      }
    }
  })

  helperProcess.stderr.on('data', (data) => {
    console.error('[mac-helper stderr]', data.toString().trim())
  })

  helperProcess.on('exit', (code, signal) => {
    console.log(`[wallpaper-mac] helper exited code=${code} signal=${signal}`)
    helperProcess = null
    if (code !== 0 && !app.isQuitting && !pendingRestart && currentSettings) {
      pendingRestart = true
      setTimeout(() => {
        pendingRestart = false
        const { videoPath: vp, settings: s } = currentSettings
        if (vp) spawnHelper(vp, s)
      }, 2000)
    }
  })
}

/**
 * Handle JSON messages emitted by the helper on stdout.
 */
function handleHelperMessage (msg) {
  if (msg.type === 'ready') {
    // Apply per-display overrides now that the helper is fully initialised
    if (currentSettings) applyPerDisplayOverrides(currentSettings)
  } else if (msg.type === 'display-added') {
    // A new display was connected while running — send its video
    if (currentSettings) {
      const { settings: s, displays } = currentSettings
      const display = (displays || []).find(d => d.nativeId === msg.displayId)
      if (display) {
        const vp = videoForDisplay(display, s)
        if (vp) {
          sendToHelper({
            type: 'set-display-video',
            displayId: msg.displayId,
            videoPath: vp,
            fitMode: s.fitMode || 'cover',
            speed: s.playbackSpeed || 1.0
            // muted/volume omitted — audio always off
          })
        }
      }
    }
  } else {
    console.log('[mac-helper msg]', msg)
  }
}

/**
 * Returns the effective video path for a display object.
 * `display.nativeId` is the CGDirectDisplayID (set by index.js from screen.getAllDisplays()).
 */
function videoForDisplay (display, settings) {
  if (settings.mirrorToAll !== false) return settings.videoPath || ''
  const perDisplay = settings.perDisplay || {}
  // Try by Electron display id first, then by CGDirectDisplayID (nativeId)
  return perDisplay[String(display.id)] || perDisplay[String(display.nativeId)] || settings.videoPath || ''
}

/**
 * Send per-display overrides to the already-running helper.
 * Only sends for displays that differ from the global videoPath.
 */
function applyPerDisplayOverrides ({ settings, displays }) {
  if (settings.mirrorToAll !== false) return  // nothing to do
  for (const display of (displays || [])) {
    const vp = videoForDisplay(display, settings)
    if (vp && vp !== settings.videoPath && display.nativeId) {
      sendToHelper({
        type: 'set-display-video',
        displayId: display.nativeId,
        videoPath: vp,
        fitMode: settings.fitMode || 'cover',
        speed: settings.playbackSpeed || 1.0
        // muted/volume omitted — audio always off
      })
    }
  }
}

function sendToHelper (msg) {
  if (!helperProcess || helperProcess.killed) return
  try {
    helperProcess.stdin.write(JSON.stringify(msg) + '\n')
  } catch (e) {
    console.error('[wallpaper-mac] stdin write error:', e.message)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start or restart the wallpaper.
 * @param {object} opts
 * @param {string} opts.videoPath    Global / primary video path.
 * @param {object} opts.settings     Full wallpaper settings from store.
 * @param {Array}  opts.displays     Electron display objects, each augmented
 *                                   with `nativeId` (CGDirectDisplayID).
 */
async function start ({ videoPath, settings, displays }) {
  // Merge any runtime-only keys (e.g. muted) into currentSettings so a
  // helper restart after a crash re-uses the current live state.
  currentSettings = { videoPath, settings, displays }

  if (!isHelperAvailable()) {
    console.warn('[wallpaper-mac] Skipping — mac-helper not built.')
    return
  }

  spawnHelper(videoPath, settings)
  // Per-display overrides are sent when helper emits "ready" (see handleHelperMessage)
}

function pause ()  { sendToHelper({ type: 'pause' }) }
function resume () { sendToHelper({ type: 'resume' }) }

function broadcast (cmd) { sendToHelper(cmd) }

async function stop () {
  currentSettings = null
  if (!helperProcess) return
  sendToHelper({ type: 'quit' })
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { helperProcess?.kill('SIGKILL') } catch (e) {}
      resolve()
    }, 2000)
    helperProcess.once('exit', () => { clearTimeout(t); resolve() })
  })
  helperProcess = null
}

module.exports = { start, pause, resume, stop, broadcast }
