'use strict'
/* global nwe */

// nwe is exposed via preload.js contextBridge

let settings = null

// ── Init ─────────────────────────────────────────────────────────────────────

async function init () {
  settings = await nwe.getAllSettings()

  // Hide mac-only elements on other platforms
  if (settings.platform !== 'darwin') {
    document.querySelectorAll('.mac-only').forEach(el => { el.style.display = 'none' })
  }

  applySettingsToUI(settings)
  setupNavigation()
  setupWallpaperTab()
  setupLockScreenTab()
  setupScreensaverTab()
  setupPerformanceTab()
  setupMonitorsTab()
  setupHotkeysTab()
  setupGeneralTab()
  setupAboutTab()

  // Listen for settings changes pushed from main process
  nwe.onSettingsUpdated((data) => {
    if (data.wallpaper) {
      settings.wallpaper = data.wallpaper
      applyWallpaperToUI(data.wallpaper)
    }
    if (data.screensaver) {
      settings.screensaver = data.screensaver
      applyScreensaverToUI(data.screensaver)
    }
  })
}

// ── Navigation ────────────────────────────────────────────────────────────────

function setupNavigation () {
  const navItems = document.querySelectorAll('.nav-item')
  const tabs = document.querySelectorAll('.tab')

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      navItems.forEach((n) => n.classList.remove('active'))
      tabs.forEach((t) => t.classList.remove('active'))
      item.classList.add('active')
      document.getElementById(`tab-${item.dataset.tab}`).classList.add('active')
    })
  })
}

// ── Apply all settings to UI ──────────────────────────────────────────────────

function applySettingsToUI (s) {
  applyWallpaperToUI(s.wallpaper)
  applyScreensaverToUI(s.screensaver)

  // Performance
  document.getElementById('pause-on-battery').checked = s.performance.pauseOnBattery
  document.getElementById('pause-on-lock').checked = s.performance.pauseOnLock
  document.getElementById('pause-on-fullscreen').checked = s.performance.pauseOnFullscreen

  // Monitors — mirrorToAll defaults true
  document.getElementById('mirror-all').checked = s.wallpaper.mirrorToAll !== false

  // General
  document.getElementById('launch-at-login').checked = s.general.launchAtLogin
}

function applyWallpaperToUI (w) {
  document.getElementById('wallpaper-filename').textContent = w.videoPath ? basename(w.videoPath) : '—'
  if (w.videoPath) loadVideoPreview('wallpaper-preview', w.videoPath)
  document.getElementById('fit-mode').value = w.fitMode || 'cover'
  const speed = w.playbackSpeed || 1.0
  document.getElementById('playback-speed').value = speed
  document.getElementById('speed-label').textContent = `${speed}×`
}

function applyScreensaverToUI (s) {
  document.getElementById('screensaver-enabled').checked = s.enabled
  document.getElementById('screensaver-filename').textContent = s.videoPath ? basename(s.videoPath) : '—'
  if (s.videoPath) loadVideoPreview('screensaver-preview', s.videoPath)
  document.getElementById('idle-timeout').value = s.idleTimeoutMinutes || 5
  document.getElementById('timeout-label').textContent = s.idleTimeoutMinutes || 5
  document.getElementById('require-password').checked = s.requirePasswordOnResume !== false

  document.getElementById('screensaver-options').style.opacity = s.enabled ? '1' : '0.5'
  document.getElementById('screensaver-options').style.pointerEvents = s.enabled ? '' : 'none'
}

// ── Lock Screen Tab (macOS) ───────────────────────────────────────────────────

function setupLockScreenTab () {
  // Only meaningful on macOS
  if (settings.platform !== 'darwin') {
    document.getElementById('lockscreen-unsupported').style.display = ''
    document.getElementById('lockscreen-controls').style.display = 'none'
    return
  }

  const statusText    = document.getElementById('lockscreen-status-text')
  const statusBox     = document.getElementById('lockscreen-status-box')
  const activeInfo    = document.getElementById('lockscreen-active-info')
  const enabledToggle = document.getElementById('lockscreen-enabled')
  const applyBtn      = document.getElementById('lockscreen-apply-btn')
  const deactivateBtn = document.getElementById('lockscreen-deactivate-btn')
  const prereqBox     = document.getElementById('lockscreen-prereq-box')
  const prereqList    = document.getElementById('lockscreen-prereq-list')
  const diagEl        = document.getElementById('lockscreen-diagnostics')
  const refreshBtn    = document.getElementById('lockscreen-refresh-btn')
  const refreshBtnOk  = document.getElementById('lockscreen-refresh-btn-ok')
  const nowBtn        = document.getElementById('lockscreen-now-btn')

  // Check prerequisites and update the warning box + Apply button state.
  async function checkPrereqs () {
    if (!nwe.macExtensionCheckPrereqs) return
    const result = await nwe.macExtensionCheckPrereqs()
    if (!result.ok && result.missing?.length) {
      prereqBox.style.display = ''
      prereqList.innerHTML = result.missing.map(m => `<li>${m}</li>`).join('')
      if (diagEl && result.diagnostics) diagEl.textContent = result.diagnostics
      applyBtn.disabled = true
    } else {
      prereqBox.style.display = 'none'
      applyBtn.disabled = false
    }
  }

  // Refresh both prereqs + status.
  async function refreshAll () {
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '↻ Checking…' }
    if (refreshBtnOk) { refreshBtnOk.disabled = true; refreshBtnOk.textContent = '↻ Checking…' }
    try {
      await checkPrereqs()
      await refreshStatus()
    } finally {
      if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh' }
      if (refreshBtnOk) { refreshBtnOk.disabled = false; refreshBtnOk.textContent = '↻ Refresh' }
    }
  }

  async function refreshStatus () {
    const st = await nwe.macExtensionStatus()
    if (!st.available) {
      statusText.textContent = 'Not available on this platform.'
      statusBox.className = 'info-box'
      return
    }
    if (st.active) {
      statusText.textContent = '✅ Lock screen wallpaper is active — your video plays on the lock screen'
      statusBox.className = 'info-box info-ok'
      activeInfo.style.display = ''
      enabledToggle.checked = true
    } else {
      statusText.textContent = 'Lock screen wallpaper is not active'
      statusBox.className = 'info-box'
      activeInfo.style.display = 'none'
      enabledToggle.checked = false
    }
  }

  // Initial load
  refreshAll()

  // Refresh buttons
  if (refreshBtn) refreshBtn.addEventListener('click', refreshAll)
  if (refreshBtnOk) refreshBtnOk.addEventListener('click', refreshAll)

  applyBtn.addEventListener('click', async () => {
    const videoPath = settings.wallpaper.videoPath
    if (!videoPath) {
      alert('Set a desktop wallpaper video first (Wallpaper tab).')
      return
    }
    applyBtn.disabled = true
    deactivateBtn.disabled = true
    statusText.textContent = '⏳ Converting to HEVC and applying… (may take a moment)'
    statusBox.className = 'info-box'
    try {
      const result = await nwe.macExtensionActivate(videoPath)
      if (result.ok) {
        await refreshStatus()
        showToast('Lock screen wallpaper applied!')
      } else {
        alert(`Failed to activate: ${result.error}`)
        await refreshStatus()
      }
    } finally {
      applyBtn.disabled = false
      deactivateBtn.disabled = false
    }
  })

  deactivateBtn.addEventListener('click', async () => {
    applyBtn.disabled = true
    deactivateBtn.disabled = true
    statusText.textContent = '⏳ Removing…'
    statusBox.className = 'info-box'
    try {
      await nwe.macExtensionDeactivate()
      await refreshAll()
      showToast('Lock screen wallpaper removed.')
    } finally {
      applyBtn.disabled = false
      deactivateBtn.disabled = false
    }
  })

  // "Lock Screen Now" button — starts the screensaver immediately
  if (nowBtn) {
    nowBtn.addEventListener('click', async () => {
      const result = await nwe.startScreensaverNow()
      if (!result.ok) alert(`Could not start screensaver: ${result.error}`)
    })
  }
}

// ── Wallpaper Tab ─────────────────────────────────────────────────────────────

function setupWallpaperTab () {
  document.getElementById('wallpaper-pick-btn').addEventListener('click', async () => {
    const path = await nwe.pickVideo('wallpaper')
    if (!path) return
    settings.wallpaper.videoPath = path
    applyWallpaperToUI(settings.wallpaper)
  })

  document.getElementById('playback-speed').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value)
    document.getElementById('speed-label').textContent = `${v}×`
  })

  document.getElementById('apply-wallpaper-btn').addEventListener('click', async () => {
    const patch = {
      videoPath: settings.wallpaper.videoPath,
      fitMode: document.getElementById('fit-mode').value,
      playbackSpeed: parseFloat(document.getElementById('playback-speed').value)
    }
    await nwe.saveWallpaperSettings(patch)
    settings.wallpaper = { ...settings.wallpaper, ...patch }
    showToast('Wallpaper applied!')
  })
}

// ── Screensaver Tab ───────────────────────────────────────────────────────────

function setupScreensaverTab () {
  const notes = {
    darwin: '🍎 <strong>macOS 15+:</strong> the idle screensaver and lock-screen wallpaper are separate. Configure the animated lock screen in the Lock Screen tab.',
    win32: '🪟 On Windows, enabling "Require password on resume" makes this behave like a lock screen.',
    linux: '🐧 On Linux, requires <code>xscreensaver</code> and <code>mpv</code> to be installed.'
  }
  const note = notes[settings.platform] || ''
  if (note) document.getElementById('screensaver-platform-note').innerHTML = note

  // On Linux, check for xscreensaver + mpv and show a warning if missing.
  const prereqBox  = document.getElementById('screensaver-prereq-box')
  const prereqList = document.getElementById('screensaver-prereq-list')
  const saveBtn    = document.getElementById('apply-screensaver-btn')

  async function checkLinuxPrereqs () {
    if (settings.platform !== 'linux') return
    const result = await nwe.screensaverCheckPrereqs()
    if (!result.ok && result.missing?.length) {
      prereqBox.style.display = ''
      prereqList.innerHTML = result.missing.map(m => `<li>${m}</li>`).join('')
      saveBtn.disabled = true
      saveBtn.title = 'Install missing dependencies first'
    } else {
      prereqBox.style.display = 'none'
      saveBtn.disabled = false
      saveBtn.title = ''
    }
  }
  checkLinuxPrereqs()

  document.getElementById('screensaver-enabled').addEventListener('change', (e) => {
    const enabled = e.target.checked
    settings.screensaver.enabled = enabled
    document.getElementById('screensaver-options').style.opacity = enabled ? '1' : '0.5'
    document.getElementById('screensaver-options').style.pointerEvents = enabled ? '' : 'none'
  })

  document.getElementById('screensaver-pick-btn').addEventListener('click', async () => {
    const path = await nwe.pickVideo('screensaver')
    if (!path) return
    settings.screensaver.videoPath = path
    document.getElementById('screensaver-filename').textContent = basename(path)
    loadVideoPreview('screensaver-preview', path)
  })

  document.getElementById('idle-timeout').addEventListener('input', (e) => {
    document.getElementById('timeout-label').textContent = e.target.value
  })

  document.getElementById('apply-screensaver-btn').addEventListener('click', async () => {
    const patch = {
      enabled: document.getElementById('screensaver-enabled').checked,
      videoPath: settings.screensaver.videoPath,
      idleTimeoutMinutes: parseInt(document.getElementById('idle-timeout').value, 10),
      requirePasswordOnResume: document.getElementById('require-password').checked
    }
    await nwe.saveScreensaverSettings(patch)
    settings.screensaver = { ...settings.screensaver, ...patch }
    showToast('Screensaver settings saved!')
  })
}

// ── Performance Tab ───────────────────────────────────────────────────────────

function setupPerformanceTab () {
  document.getElementById('apply-performance-btn').addEventListener('click', async () => {
    const patch = {
      pauseOnBattery: document.getElementById('pause-on-battery').checked,
      pauseOnLock: document.getElementById('pause-on-lock').checked,
      pauseOnFullscreen: document.getElementById('pause-on-fullscreen').checked
    }
    await nwe.savePerformanceSettings(patch)
    settings.performance = patch
    showToast('Performance settings saved!')
  })
}

// ── Monitors Tab ──────────────────────────────────────────────────────────────

// In-memory map of displayId → chosen video path (for the current UI session).
// Populated from settings.wallpaper.perDisplay on load, updated by the picker.
let _perDisplayDraft = {}

function setupMonitorsTab () {
  // Initialise draft from persisted settings
  _perDisplayDraft = Object.assign({}, settings.wallpaper.perDisplay || {})

  const mirrorToggle = document.getElementById('mirror-all')
  // Default: mirror=true (stored setting wins)
  mirrorToggle.checked = settings.wallpaper.mirrorToAll !== false

  // Show/hide per-display rows based on toggle state
  function syncDisplayListVisibility () {
    const mirroring = mirrorToggle.checked
    const list = document.getElementById('display-list')
    list.style.display = mirroring ? 'none' : ''
    // When toggling back to mirror, grey-out rows to signal they are inactive
    list.style.opacity = mirroring ? '0.4' : '1'
    list.style.pointerEvents = mirroring ? 'none' : ''
  }

  mirrorToggle.addEventListener('change', syncDisplayListVisibility)
  syncDisplayListVisibility()
  renderDisplayList()

  document.getElementById('apply-monitors-btn').addEventListener('click', async () => {
    const mirrorToAll = mirrorToggle.checked
    const patch = { mirrorToAll }
    if (!mirrorToAll) {
      patch.perDisplay = Object.assign({}, _perDisplayDraft)
    }
    await nwe.saveWallpaperSettings(patch)
    settings.wallpaper.mirrorToAll = mirrorToAll
    if (!mirrorToAll) settings.wallpaper.perDisplay = patch.perDisplay
    showToast('Monitor settings saved!')
  })

  // React to display-added / display-removed pushed from main process
  nwe.onSettingsUpdated((data) => {
    if (data.displays) {
      settings.displays = data.displays
      // Preserve draft paths for existing displays; new displays start empty
      renderDisplayList()
      syncDisplayListVisibility()
    }
  })
}

function renderDisplayList () {
  const list = document.getElementById('display-list')
  list.innerHTML = ''

  if (!settings.displays || settings.displays.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">No displays detected.</p>'
    return
  }

  settings.displays.forEach((display, idx) => {
    // Effective video for this display: override → global fallback
    const assignedPath = _perDisplayDraft[display.id] || ''
    const fallbackLabel = settings.wallpaper.videoPath
      ? `Uses main wallpaper (${basename(settings.wallpaper.videoPath)})`
      : 'No main wallpaper set'

    const item = document.createElement('div')
    item.className = 'display-item'
    item.dataset.displayId = display.id

    item.innerHTML = `
      <div class="display-item-header">
        <span class="display-item-label">${display.label}</span>
      </div>
      <div class="display-item-body">
        <span class="display-assigned-path">
          ${assignedPath ? basename(assignedPath) : `<em style="color:var(--text-muted)">${fallbackLabel}</em>`}
        </span>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn btn-secondary display-pick-btn" style="font-size:11px;padding:4px 10px;">Choose…</button>
          <button class="btn btn-secondary display-clear-btn" style="font-size:11px;padding:4px 10px;" ${assignedPath ? '' : 'disabled'}>Clear override</button>
        </div>
      </div>
    `

    const pathLabel = item.querySelector('.display-assigned-path')
    const pickBtn = item.querySelector('.display-pick-btn')
    const clearBtn = item.querySelector('.display-clear-btn')

    pickBtn.addEventListener('click', async () => {
      const p = await nwe.pickVideo('wallpaper')
      if (!p) return
      _perDisplayDraft[display.id] = p
      pathLabel.innerHTML = basename(p)
      clearBtn.disabled = false
    })

    clearBtn.addEventListener('click', () => {
      delete _perDisplayDraft[display.id]
      pathLabel.innerHTML = `<em style="color:var(--text-muted)">${fallbackLabel}</em>`
      clearBtn.disabled = true
    })

    list.appendChild(item)
  })
}

// ── Hotkeys Tab ───────────────────────────────────────────────────────────────

const HOTKEY_ACTIONS = ['pauseResume', 'muteUnmute', 'nextWallpaper', 'lockScreen']

// ── Key recorder ─────────────────────────────────────────────────────────────
// Converts a browser KeyboardEvent into an Electron accelerator string.
// e.g. Ctrl+Shift+M → "CommandOrControl+Shift+M"

const KEY_MAP = {
  // Modifiers are handled separately — these are non-modifier keys
  ' ': 'Space',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  MediaPlayPause: 'MediaPlayPause', MediaStop: 'MediaStop',
  MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack',
  AudioVolumeMute: 'VolumeDown', // best proxy
  Escape: 'Escape', Tab: 'Tab', Delete: 'Delete', Backspace: 'Backspace',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Enter: 'Return', NumpadEnter: 'Return',
  PrintScreen: 'PrintScreen', ScrollLock: 'ScrollLock', Pause: 'Pause',
}

function eventToAccelerator (e) {
  const mods = []

  // On macOS, Ctrl = Control, Meta = Command. We use CommandOrControl for cross-platform.
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')

  // Key name
  let key = e.key

  // Pure modifier key press — don't record yet
  if (['Control', 'Meta', 'Alt', 'Shift', 'OS', 'Super'].includes(key)) return null

  // Function keys
  if (/^F\d+$/.test(key)) {
    mods.push(key)
    return mods.join('+')
  }

  // Map special keys
  if (KEY_MAP[key]) key = KEY_MAP[key]
  else if (key.length === 1) key = key.toUpperCase()
  else {
    // Numpad
    const numpad = { '0':'num0','1':'num1','2':'num2','3':'num3','4':'num4',
                     '5':'num5','6':'num6','7':'num7','8':'num8','9':'num9' }
    if (e.code.startsWith('Numpad') && numpad[key]) key = 'num' + key
  }

  mods.push(key)
  return mods.join('+')
}

function attachRecorder (input) {
  let _prevValue = input.value

  input.addEventListener('focus', () => {
    _prevValue = input.value
    input.value = ''
    input.placeholder = '⌨ Press your shortcut…'
    input.classList.add('recording')
    input.classList.remove('error')
  })

  input.addEventListener('keydown', (e) => {
    e.preventDefault()
    e.stopPropagation()

    // Escape = cancel (restore previous)
    if (e.key === 'Escape') {
      input.value = _prevValue
      input.blur()
      return
    }

    // Backspace/Delete on empty = clear binding
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      input.value = ''
      input.blur()
      return
    }

    const accelerator = eventToAccelerator(e)
    if (!accelerator) return // pure modifier key — wait for the actual key

    input.value = accelerator
    input.blur()
  })

  input.addEventListener('blur', () => {
    input.placeholder = input.dataset.placeholder || ''
    input.classList.remove('recording')
    // Validate: must have at least one modifier or be a Function/Media key
    const val = input.value.trim()
    if (!val) return
    const hasMod = val.includes('+')
    const isFnOrMedia = /^(F\d+|Media)/.test(val)
    if (!hasMod && !isFnOrMedia) {
      input.classList.add('error')
      input.value = _prevValue // revert to last good value
    }
  })
}

function setupHotkeysTab () {
  if (settings.hotkeys) {
    for (const action of HOTKEY_ACTIONS) {
      const el = document.getElementById(`hk-${action}`)
      if (el) el.value = settings.hotkeys[action] || ''
    }
  }

  // Attach key recorder to every hotkey input
  document.querySelectorAll('.hotkey-input').forEach((input) => {
    // Stash original placeholder for restoring after record
    input.dataset.placeholder = input.placeholder
    // Make read-only so the user can't type manually
    input.readOnly = true
    attachRecorder(input)
  })

  // Clear buttons
  document.querySelectorAll('.hk-clear-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target)
      if (input) { input.value = ''; input.classList.remove('error') }
    })
  })

  document.getElementById('apply-hotkeys-btn').addEventListener('click', async () => {
    const patch = {}
    for (const action of HOTKEY_ACTIONS) {
      const el = document.getElementById(`hk-${action}`)
      patch[action] = el ? el.value.trim() : ''
    }
    await nwe.saveHotkeys(patch)
    settings.hotkeys = { ...settings.hotkeys, ...patch }
    showToast('Hotkeys saved!')
  })
}

// ── General Tab ───────────────────────────────────────────────────────────────

function setupGeneralTab () {
  document.getElementById('apply-general-btn').addEventListener('click', async () => {
    const patch = {
      launchAtLogin: document.getElementById('launch-at-login').checked
    }
    await nwe.saveGeneralSettings(patch)
    settings.general = patch
    showToast('General settings saved!')
  })
}

// ── About Tab ─────────────────────────────────────────────────────────────────

function setupAboutTab () {
  const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
  document.getElementById('about-platform').textContent =
    `${platformNames[settings.platform] || settings.platform} — Electron ${process?.versions?.electron || ''}`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function basename (filePath) {
  return filePath.split(/[\\/]/).pop()
}

function loadVideoPreview (containerId, videoPath) {
  const container = document.getElementById(containerId)
  let video = container.querySelector('video')
  if (!video) {
    container.innerHTML = ''
    video = document.createElement('video')
    video.autoplay = true
    video.loop = true
    video.muted = true
    video.playsInline = true
    video.style.width = '100%'
    video.style.height = '100%'
    video.style.objectFit = 'cover'
    container.appendChild(video)
  }
  const src = videoPath.startsWith('file://') ? videoPath : `file://${videoPath}`
  if (video.src !== src) {
    video.src = src
    video.play().catch(() => {})
  }
}

let toastTimer = null
function showToast (message) {
  let toast = document.querySelector('.toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.className = 'toast'
    document.body.appendChild(toast)
  }
  toast.textContent = message
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000)
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init)
