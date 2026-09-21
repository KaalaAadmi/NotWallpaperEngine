'use strict'

/**
 * screensaver-win.js
 * ───────────────────
 * Installs and configures a video screensaver on Windows.
 *
 * Strategy:
 *  - The .scr file is a copy of the NotWPE-screensaver.exe (a minimal
 *    Electron renderer) bundled with the app and placed in %APPDATA%.
 *  - The screensaver is registered via the Windows registry:
 *      HKCU\Control Panel\Desktop\SCRNSAVE.EXE  → path to .scr
 *      HKCU\Control Panel\Desktop\ScreenSaveActive → "1"
 *      HKCU\Control Panel\Desktop\ScreenSaveTimeOut → seconds
 *      HKCU\Control Panel\Desktop\ScreenSaverIsSecure → "1"/"0"
 *  - SystemParametersInfo(SPI_SETSCREENSAVEACTIVE, TRUE) is called to
 *    activate screensaver mode immediately without a logout.
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const { app } = require('electron')

// Lazy-load Windows-only deps
let winreg = null
let ffi = null
let ref = null

function loadWinDeps () {
  if (winreg) return true
  try {
    winreg = require('winreg')
    ffi = require('ffi-napi')
    ref = require('ref-napi')
    return true
  } catch (e) {
    console.error('[screensaver-win] Windows deps not available:', e.message)
    return false
  }
}

function getUser32 () {
  if (!ffi) return null
  return ffi.Library('user32', {
    SystemParametersInfoA: ['bool', ['uint32', 'uint32', 'pointer', 'uint32']]
  })
}

const SPI_SETSCREENSAVEACTIVE = 0x0011
const SPI_SETSCREENSAVETIMEOUT = 0x000F
const SPIF_UPDATEINIFILE = 0x0001
const SPIF_SENDCHANGE = 0x0002

// ── .scr file management ──────────────────────────────────────────────────────

function getScrSourcePath () {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'NotWPE.scr')
  }
  // In dev, a pre-built .scr doesn't exist yet — log a warning
  return path.join(__dirname, '..', 'native', 'win-screensaver', 'NotWPE.scr')
}

function getScrDestPath () {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'NotWallpaperEngine', 'NotWPE.scr')
}

function getScreensaverDataPath () {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'NotWallpaperEngine', 'screensaver-config.json')
}

function ensureDestDir () {
  const dir = path.dirname(getScrDestPath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function installScrFile () {
  const src = getScrSourcePath()
  const dest = getScrDestPath()
  ensureDestDir()

  if (!fs.existsSync(src)) {
    console.warn('[screensaver-win] .scr source not found at:', src)
    return false
  }
  try {
    fs.copyFileSync(src, dest)
    return true
  } catch (e) {
    console.error('[screensaver-win] Failed to copy .scr:', e.message)
    return false
  }
}

// ── Registry helpers ──────────────────────────────────────────────────────────

function setRegistryValue (key, name, type, value) {
  return new Promise((resolve, reject) => {
    const k = new winreg({ hive: winreg.HKCU, key })
    k.set(name, type, value, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

async function install (screensaverSettings) {
  if (!loadWinDeps()) return

  const { videoPath, idleTimeoutMinutes, requirePasswordOnResume } = screensaverSettings

  // Write screensaver config JSON for the .scr renderer to read
  ensureDestDir()
  fs.writeFileSync(
    getScreensaverDataPath(),
    JSON.stringify({ videoPath, fitMode: 'cover' }),
    'utf8'
  )

  // Copy .scr file into AppData
  const scrInstalled = installScrFile()
  if (!scrInstalled) return

  const scrPath = getScrDestPath()
  const timeoutSeconds = String((idleTimeoutMinutes || 5) * 60)
  const secureFlag = requirePasswordOnResume ? '1' : '0'
  const regKey = '\\Control Panel\\Desktop'

  try {
    await setRegistryValue(regKey, 'SCRNSAVE.EXE', winreg.REG_SZ, scrPath)
    await setRegistryValue(regKey, 'ScreenSaveActive', winreg.REG_SZ, '1')
    await setRegistryValue(regKey, 'ScreenSaveTimeOut', winreg.REG_SZ, timeoutSeconds)
    await setRegistryValue(regKey, 'ScreenSaverIsSecure', winreg.REG_SZ, secureFlag)

    // Notify Windows of the change
    const user32 = getUser32()
    if (user32) {
      user32.SystemParametersInfoA(SPI_SETSCREENSAVEACTIVE, 1, null, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE)
      user32.SystemParametersInfoA(SPI_SETSCREENSAVETIMEOUT, parseInt(timeoutSeconds), null, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE)
    }

    console.log('[screensaver-win] Screensaver installed:', scrPath)
  } catch (e) {
    console.error('[screensaver-win] Registry write failed:', e.message)
  }
}

async function uninstall () {
  if (!loadWinDeps()) return

  const regKey = '\\Control Panel\\Desktop'
  try {
    await setRegistryValue(regKey, 'ScreenSaveActive', winreg.REG_SZ, '0')
    const user32 = getUser32()
    if (user32) {
      user32.SystemParametersInfoA(SPI_SETSCREENSAVEACTIVE, 0, null, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE)
    }
    console.log('[screensaver-win] Screensaver disabled')
  } catch (e) {
    console.error('[screensaver-win] Uninstall failed:', e.message)
  }
}

module.exports = { install, uninstall }
