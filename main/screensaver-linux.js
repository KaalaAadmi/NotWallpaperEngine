'use strict'

/**
 * screensaver-linux.js
 * ─────────────────────
 * Configures xscreensaver on Linux to use mpv as a video screensaver.
 *
 * Strategy:
 *  - Writes/updates ~/.xscreensaver to add a custom "program" hack entry
 *    that runs `mpv --fs --loop --no-audio <videoPath>`.
 *  - Sets the idle timeout in the same config file.
 *  - Optionally enables xss-lock (if installed) for lock-on-screensaver.
 *  - Requires xscreensaver and mpv to be installed.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { exec, execSync } = require('child_process')

const XSCREENSAVER_CONFIG = path.join(os.homedir(), '.xscreensaver')
const HACK_NAME = 'NotWallpaperEngine'

// ── Helpers ───────────────────────────────────────────────────────────────────

function execAsync (cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout?.trim(), stderr: stderr?.trim() })
    })
  })
}

function checkDependency (bin) {
  try {
    execSync(`which ${bin}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ── .xscreensaver config manipulation ────────────────────────────────────────

/**
 * Read existing ~/.xscreensaver config or return a minimal default.
 */
function readConfig () {
  if (!fs.existsSync(XSCREENSAVER_CONFIG)) {
    return getDefaultConfig()
  }
  return fs.readFileSync(XSCREENSAVER_CONFIG, 'utf8')
}

function getDefaultConfig () {
  return `# .xscreensaver preferences (managed by NotWallpaperEngine)

timeout: 0:05:00
mode: one
selected: 0

programs: \\
`
}

/**
 * Set or replace a key: value line in the config.
 */
function setConfigValue (config, key, value) {
  const regex = new RegExp(`^${key}:.*$`, 'm')
  if (regex.test(config)) {
    return config.replace(regex, `${key}: ${value}`)
  }
  return config + `\n${key}: ${value}`
}

/**
 * Format minutes as xscreensaver timeout string: H:MM:SS
 */
function formatTimeout (minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}:${String(m).padStart(2, '0')}:00`
}

/**
 * Build the mpv hack program line for .xscreensaver.
 */
function buildProgramLine (videoPath) {
  // Escape double quotes in path
  const escaped = videoPath.replace(/"/g, '\\"')
  return `  ${HACK_NAME}: mpv --fs --loop=inf --no-audio --no-osc --no-input-default-bindings "${escaped}" \\n\\`
}

/**
 * Inject or update the NotWallpaperEngine program entry in the programs block.
 */
function upsertProgramEntry (config, videoPath) {
  const programLine = buildProgramLine(videoPath)
  const hackRegex = new RegExp(`^  ${HACK_NAME}:.*$`, 'm')

  if (hackRegex.test(config)) {
    return config.replace(hackRegex, programLine)
  }

  // Append to programs block
  if (/^programs:/m.test(config)) {
    return config.replace(/^(programs:.*(?:\n.*\\n\\)*)$/m, `$1\n${programLine}`)
  }

  // No programs block — add one
  return config + `\nprograms: \\\n${programLine}\n`
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check that all required external binaries are present.
 * Returns { ok, missing } where missing is an array of human-readable strings.
 */
function checkPrerequisites () {
  const missing = []
  if (!checkDependency('xscreensaver')) {
    missing.push(
      '<code>xscreensaver</code> is not installed. ' +
      'Install it: <code>sudo apt install xscreensaver</code> ' +
      '(Debian/Ubuntu) or <code>sudo dnf install xscreensaver</code> (Fedora).'
    )
  }
  if (!checkDependency('mpv')) {
    missing.push(
      '<code>mpv</code> is not installed. ' +
      'Install it: <code>sudo apt install mpv</code> ' +
      '(Debian/Ubuntu) or <code>sudo dnf install mpv</code> (Fedora).'
    )
  }
  return { ok: missing.length === 0, missing }
}

async function install (screensaverSettings) {
  const { videoPath, idleTimeoutMinutes, requirePasswordOnResume } = screensaverSettings

  const prereqs = checkPrerequisites()
  if (!prereqs.ok) {
    prereqs.missing.forEach(m => console.warn('[screensaver-linux]', m))
    return
  }

  let config = readConfig()

  // Set timeout
  config = setConfigValue(config, 'timeout', formatTimeout(idleTimeoutMinutes || 5))

  // Set mode to "one" (single screensaver)
  config = setConfigValue(config, 'mode', 'one')
  config = setConfigValue(config, 'selected', '0')

  // Inject program entry
  config = upsertProgramEntry(config, videoPath)

  fs.writeFileSync(XSCREENSAVER_CONFIG, config, 'utf8')
  console.log('[screensaver-linux] Updated ~/.xscreensaver')

  // Restart xscreensaver to pick up new config
  await execAsync('xscreensaver-command -restart 2>/dev/null || pkill xscreensaver; xscreensaver -no-splash &')

  // Lock on screensaver via xss-lock (if available)
  if (requirePasswordOnResume && checkDependency('xss-lock')) {
    await execAsync('xss-lock -- xscreensaver-command -lock &')
    console.log('[screensaver-linux] xss-lock activated for lock-on-screensaver')
  }
}

async function uninstall () {
  if (!fs.existsSync(XSCREENSAVER_CONFIG)) return

  let config = fs.readFileSync(XSCREENSAVER_CONFIG, 'utf8')
  // Remove our program line
  const hackRegex = new RegExp(`^  ${HACK_NAME}:.*$\n?`, 'm')
  config = config.replace(hackRegex, '')
  fs.writeFileSync(XSCREENSAVER_CONFIG, config, 'utf8')

  // Stop xss-lock if running
  await execAsync('pkill -f "xss-lock" 2>/dev/null').catch(() => {})
  console.log('[screensaver-linux] NotWallpaperEngine screensaver entry removed')
}

module.exports = { install, uninstall, checkPrerequisites }
