'use strict'

/**
 * screensaver-mac.js
 * ───────────────────
 * Installs the .saver bundle for the idle screensaver on macOS.
 *
 * The lock screen wallpaper is handled separately by wallpaper-extension-mac.js.
 * This module must not replace that module's aerial slot: the .saver bundle reads
 * its own selected video from shared UserDefaults.
 */

const path         = require('path')
const fs           = require('fs')
const os           = require('os')
const { exec } = require('child_process')
const { app }      = require('electron')

// ── Constants ─────────────────────────────────────────────────────────────────

const SAVER_NAME             = 'NotWPESaver.saver'
const SHARED_DEFAULTS_DOMAIN = 'com.notwallpaperengine.shared'

// ── Helpers ───────────────────────────────────────────────────────────────────

function execAsync (cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout.trim())
    })
  })
}

function copySaverBundle (src, dest) {
  return new Promise((resolve, reject) => {
    exec(`rm -rf "${dest}"`, () => {
      exec(`cp -R "${src}" "${dest}"`, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })
}

function getSaverSourcePath () {
  if (app.isPackaged) return path.join(process.resourcesPath, SAVER_NAME)
  return path.join(__dirname, '..', 'native', 'mac-saver', 'build', SAVER_NAME)
}

function getSaverDestPath () {
  return path.join(os.homedir(), 'Library', 'Screen Savers', SAVER_NAME)
}


// ── Public API ────────────────────────────────────────────────────────────────

async function install (screensaverSettings) {
  const {
    videoPath,
    idleTimeoutMinutes,
    requirePasswordOnResume
  } = screensaverSettings

  const src  = getSaverSourcePath()
  const dest = getSaverDestPath()

  if (!fs.existsSync(src)) {
    console.warn('[screensaver-mac] .saver bundle not found at:', src)
    console.warn('  Run: npm run build:mac-saver')
    return
  }

  // 1. Write config to shared UserDefaults domain (read by the .saver bundle)
  // Audio is always disabled (PRD §3: No audio)
  await execAsync(`defaults write "${SHARED_DEFAULTS_DOMAIN}" videoPath "${videoPath.replace(/"/g, '\\"')}"`)
  await execAsync(`defaults write "${SHARED_DEFAULTS_DOMAIN}" fitMode "cover"`)
  await execAsync(`defaults write "${SHARED_DEFAULTS_DOMAIN}" screensaverMuted -bool true`)

  // 2. Install .saver bundle only when the source is newer than the installed copy.
  //    Skipping the copy also skips the killall below, avoiding the macOS Automation
  //    permission dialog on every launch when the bundle hasn't changed.
  const needsCopy = !fs.existsSync(dest) ||
    fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs

  if (needsCopy) {
    try {
      await copySaverBundle(src, dest)
      console.log('[screensaver-mac] Installed .saver to:', dest)
    } catch (e) {
      console.error('[screensaver-mac] Failed to install .saver:', e.message)
      return
    }
  }

  // 3. Set as active screensaver (legacy idle timeout + password-on-resume)
  const saverName = path.basename(dest, '.saver')
  await execAsync(
    `defaults -currentHost write com.apple.screensaver moduleDict -dict ` +
    `moduleName "${saverName}" path "${dest}" type -int 0`
  ).catch(e => console.warn('[screensaver-mac] defaults write failed:', e.message))

  const timeoutSeconds = (idleTimeoutMinutes || 5) * 60
  await execAsync(`defaults -currentHost write com.apple.screensaver idleTime -int ${timeoutSeconds}`).catch(() => {})

  if (requirePasswordOnResume) {
    await execAsync(`defaults write com.apple.screensaver askForPassword -int 1`).catch(() => {})
    await execAsync(`defaults write com.apple.screensaver askForPasswordDelay -int 0`).catch(() => {})
  } else {
    await execAsync(`defaults write com.apple.screensaver askForPassword -int 0`).catch(() => {})
  }

  // 4. Reload screensaver engine — only needed when the bundle was (re-)copied.
  //    killall targeting ScreenSaverEngine triggers the macOS Automation dialog;
  //    skipping it on unchanged installs prevents the dialog on every app launch.
  if (needsCopy) {
    await execAsync('killall -9 legacyScreenSaver 2>/dev/null; killall -9 ScreenSaverEngine 2>/dev/null; true').catch(() => {})
    console.log('[screensaver-mac] Screensaver bundle updated and engine reloaded')
  } else {
    console.log('[screensaver-mac] Screensaver config updated (bundle unchanged)')
  }
}

async function uninstall () {
  // Unset from com.apple.screensaver
  await execAsync('defaults -currentHost delete com.apple.screensaver moduleDict').catch(() => {})
  console.log('[screensaver-mac] Screensaver unset.')
}

/**
 * Start the screensaver immediately (used by the "Lock Screen" hotkey).
 * Spawns ScreenSaverEngine in background mode so the active screensaver
 * (NotWPESaver) plays right now, with the password-on-resume intact.
 *
 * Note: Cmd+Ctrl+Q is a system-reserved shortcut that Electron cannot capture.
 * Users bind their own shortcut in the Hotkeys tab.
 */
async function startNow () {
  const engine = '/System/Library/CoreServices/ScreenSaverEngine.app/Contents/MacOS/ScreenSaverEngine'
  const { spawn } = require('child_process')
  // -background keeps it in the same display space as the desktop
  spawn(engine, ['-background'], { detached: true, stdio: 'ignore' }).unref()
  console.log('[screensaver-mac] Screensaver started immediately')
}

module.exports = { install, uninstall, startNow }
