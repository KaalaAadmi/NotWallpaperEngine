'use strict'

const Store = require('electron-store')

const schema = {
  wallpaper: {
    type: 'object',
    properties: {
      videoPath: { type: 'string', default: '' },
      fitMode: { type: 'string', enum: ['cover', 'contain', 'stretch'], default: 'cover' },
      playbackSpeed: { type: 'number', minimum: 0.5, maximum: 2.0, default: 1.0 },
      perDisplay: {
        type: 'object',
        additionalProperties: { type: 'string' },
        default: {}
      }
    },
    default: {}
  },
  screensaver: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false },
      videoPath: { type: 'string', default: '' },
      idleTimeoutMinutes: { type: 'number', minimum: 1, maximum: 120, default: 5 },
      requirePasswordOnResume: { type: 'boolean', default: true }
    },
    default: {}
  },
  performance: {
    type: 'object',
    properties: {
      pauseOnBattery: { type: 'boolean', default: true },
      pauseOnLock: { type: 'boolean', default: true },
      pauseOnFullscreen: { type: 'boolean', default: true }
    },
    default: {}
  },
  general: {
    type: 'object',
    properties: {
      launchAtLogin: { type: 'boolean', default: false }
    },
    default: {}
  },
  hotkeys: {
    type: 'object',
    properties: {
      pauseResume:   { type: 'string', default: '' },
      nextWallpaper: { type: 'string', default: '' },
      lockScreen:    { type: 'string', default: '' }
    },
    default: {}
  }
}

let _store = null
function getStore () {
  if (!_store) _store = new Store({ schema, name: 'settings' })
  return _store
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWallpaper () {
  const s = getStore()
  return {
    videoPath: s.get('wallpaper.videoPath', ''),
    fitMode: s.get('wallpaper.fitMode', 'cover'),
    playbackSpeed: s.get('wallpaper.playbackSpeed', 1.0),
    perDisplay: s.get('wallpaper.perDisplay', {})
  }
}

/**
 * Returns the effective video path for a given display.
 * Falls back to the global videoPath when no per-display override is set.
 */
function getVideoPathForDisplay (displayId) {
  const s = getStore()
  const global = s.get('wallpaper.videoPath', '')
  const perDisplay = s.get('wallpaper.perDisplay', {})
  return perDisplay[String(displayId)] || global
}

function setWallpaper (patch) {
  const s = getStore()
  for (const [key, value] of Object.entries(patch)) {
    s.set(`wallpaper.${key}`, value)
  }
}

function getScreensaver () {
  const s = getStore()
  return {
    enabled: s.get('screensaver.enabled', false),
    videoPath: s.get('screensaver.videoPath', ''),
    idleTimeoutMinutes: s.get('screensaver.idleTimeoutMinutes', 5),
    requirePasswordOnResume: s.get('screensaver.requirePasswordOnResume', true)
  }
}

function setScreensaver (patch) {
  const s = getStore()
  for (const [key, value] of Object.entries(patch)) {
    s.set(`screensaver.${key}`, value)
  }
}

function getPerformance () {
  const s = getStore()
  return {
    pauseOnBattery: s.get('performance.pauseOnBattery', true),
    pauseOnLock: s.get('performance.pauseOnLock', true),
    pauseOnFullscreen: s.get('performance.pauseOnFullscreen', true)
  }
}

function setPerformance (patch) {
  const s = getStore()
  for (const [key, value] of Object.entries(patch)) {
    s.set(`performance.${key}`, value)
  }
}

function getGeneral () {
  const s = getStore()
  return {
    launchAtLogin: s.get('general.launchAtLogin', false)
  }
}

function setGeneral (patch) {
  const s = getStore()
  for (const [key, value] of Object.entries(patch)) {
    s.set(`general.${key}`, value)
  }
}

function getHotkeys () {
  const s = getStore()
  return {
    pauseResume:   s.get('hotkeys.pauseResume', ''),
    nextWallpaper: s.get('hotkeys.nextWallpaper', ''),
    lockScreen:    s.get('hotkeys.lockScreen', '')
  }
}

function setHotkeys (patch) {
  const s = getStore()
  for (const [key, value] of Object.entries(patch)) {
    s.set(`hotkeys.${key}`, value)
  }
}

module.exports = {
  getStore,
  getWallpaper,
  getVideoPathForDisplay,
  setWallpaper,
  getScreensaver,
  setScreensaver,
  getPerformance,
  setPerformance,
  getGeneral,
  setGeneral,
  getHotkeys,
  setHotkeys
}
