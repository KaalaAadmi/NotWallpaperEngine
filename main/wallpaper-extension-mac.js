'use strict'

/**
 * wallpaper-extension-mac.js
 * ──────────────────────────
 * Sets a video as the macOS live lock-screen wallpaper on macOS 26 (Tahoe)+
 * by replacing the active aerial slot under the user-writable Tahoe path and
 * updating entries.json so WallpaperAgent accepts the new asset.
 *
 * How it works (PRD §6.3):
 *   1. Request conversion of the source video to aerial-spec HEVC .mov via the
 *      bundled Swift mac-helper (VideoToolbox 2-layer temporal hierarchy).
 *      The same converted asset is reused for the desktop AVPlayer window.
 *   2. Locate the active aerial's .mov under:
 *        ~/Library/Application Support/com.apple.wallpaper/aerials/videos/
 *      (per-user, user-writable, not a SIP-protected DataVault — no sudo).
 *   3. Atomically replace that slot's .mov (same-volume rename).
 *   4. Update the matching entry in entries.json (NOT Index.plist) so
 *      WallpaperAgent does not reject the asset during validation.
 *   5. Restart WallpaperAgent (and WallpaperAerialsExtension) so the lock
 *      screen picks up the change without a reboot.
 *
 * Backs up original .mov (.nwpe_orig) and entries.json (.nwpe_orig) before
 * overwriting; restores both on deactivate — fully idempotent.
 *
 * Must run as the logged-in user, never via sudo. No admin password required,
 * no SIP disable needed. All target paths are user-writable.
 *
 * Requires macOS 26 (Tahoe) or later. On older macOS the paths will not exist
 * and checkPrerequisites() will report the slot missing.
 *
 * References: AerialWall, LivePaper (Tahoe entries.json injection pipeline).
 */

const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const crypto = require('crypto')
const { execSync, execFileSync, spawnSync } = require('child_process')

// ── Constants ─────────────────────────────────────────────────────────────────

// Tahoe-specific path: ~/Library/Application Support/com.apple.wallpaper/aerials/videos/
// .mov files are stored FLAT here as <UUID>.mov — not inside UUID subdirectories.
const AERIAL_VIDEOS_DIR = path.join(
  os.homedir(), 'Library', 'Application Support',
  'com.apple.wallpaper', 'aerials', 'videos'
)

// entries.json lives in the manifest/ subdirectory (Tahoe layout).
// NOT alongside videos/ and NOT Index.plist (that is the Sonoma/Sequoia layout).
const ENTRIES_JSON_PATH = path.join(
  os.homedir(), 'Library', 'Application Support',
  'com.apple.wallpaper', 'aerials', 'manifest', 'entries.json'
)

// Index.plist — controls which provider/asset is used for Desktop AND Idle
// (lock screen) per display and space.  We patch all Idle entries to point to
// the aerials provider so the lock screen plays our slot instead of the static
// Sequoia wallpaper.
const INDEX_PLIST_PATH = path.join(
  os.homedir(), 'Library', 'Application Support',
  'com.apple.wallpaper', 'Store', 'Index.plist'
)

// Cache dir for the converted HEVC .mov, keyed on source-file hash
const CONVERTED_DIR = path.join(
  os.homedir(), 'Library', 'Application Support',
  'com.notwallpaperengine', 'aerials'
)

// State file — persists which slot we overwrote so we can restore on deactivate
const STATE_FILE = path.join(
  os.homedir(), 'Library', 'Application Support',
  'com.notwallpaperengine', 'lockscreen-state.json'
)

// ── State helpers ─────────────────────────────────────────────────────────────

function loadState () {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}

function saveState (state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

function clearState () {
  try { fs.unlinkSync(STATE_FILE) } catch { /* ok */ }
}

// ── Aerial slot discovery ─────────────────────────────────────────────────────

/**
 * Find an existing .mov file inside ~/…/aerials/videos/.
 *
 * Tahoe layout: .mov files are stored FLAT as <UUID>.mov directly in videos/
 * (not inside UUID subdirectories).  The UUID stem is the slot ID that matches
 * the "id" field in entries.json.
 *
 * Returns { slotPath, slotId } or null.
 */
function findAerialSlot () {
  if (!fs.existsSync(AERIAL_VIDEOS_DIR)) return null

  const entries = fs.readdirSync(AERIAL_VIDEOS_DIR, { withFileTypes: true })

  // Flat layout: <UUID>.mov directly in videos/
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.mov')) {
      const slotId = path.basename(entry.name, '.mov')  // UUID stem
      return { slotPath: path.join(AERIAL_VIDEOS_DIR, entry.name), slotId }
    }
  }

  // Fallback: UUID subdirectory layout (older Tahoe betas / alternative layouts)
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sub = path.join(AERIAL_VIDEOS_DIR, entry.name)
      const files = fs.readdirSync(sub)
      for (const f of files) {
        if (f.toLowerCase().endsWith('.mov')) {
          return { slotPath: path.join(sub, f), slotId: entry.name }
        }
      }
    }
  }

  return null
}

/**
 * Return all discovered aerial slots (used for diagnostics / UI display).
 */
function listAerialSlots () {
  if (!fs.existsSync(AERIAL_VIDEOS_DIR)) return []
  const slots = []
  const entries = fs.readdirSync(AERIAL_VIDEOS_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.mov')) {
      slots.push({ slotPath: path.join(AERIAL_VIDEOS_DIR, entry.name), slotId: path.basename(entry.name, '.mov') })
    }
  }
  return slots
}

// ── entries.json manipulation ─────────────────────────────────────────────────

/**
 * Update entries.json so the entry matching slotId points to the new file
 * and its metadata (size, hash) matches the new content.
 *
 * entries.json is plain UTF-8 JSON — read with fs.readFileSync, edited with
 * JSON.parse/JSON.stringify, written back (NOT via plutil/plist).
 *
 * Backs up the original to entries.json.nwpe_orig before the first edit.
 */
function updateEntriesJson (slotId, newFilePath) {
  if (!fs.existsSync(ENTRIES_JSON_PATH)) {
    console.warn('[extension-mac] entries.json not found — skipping manifest update:', ENTRIES_JSON_PATH)
    return
  }

  // Back up once
  const backupPath = ENTRIES_JSON_PATH + '.nwpe_orig'
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(ENTRIES_JSON_PATH, backupPath)
    console.log('[extension-mac] Backed up entries.json to:', backupPath)
  }

  let data
  try {
    data = JSON.parse(fs.readFileSync(ENTRIES_JSON_PATH, 'utf8'))
  } catch (e) {
    console.warn('[extension-mac] Could not parse entries.json:', e.message)
    return
  }

  const stat = fs.statSync(newFilePath)
  const fileSize = stat.size

  // Compute SHA-256 of the new file for checksum field
  let sha256 = ''
  try {
    const buf = fs.readFileSync(newFilePath)
    sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  } catch { /* non-fatal */ }

  // entries.json is expected to be an object or array with entries.
  // Walk through all possible structures and patch any entry whose id matches.
  let patched = false

  function patchEntry (entry) {
    if (!entry || typeof entry !== 'object') return
    if (entry.id === slotId || entry.uuid === slotId || entry.assetId === slotId) {
      if (fileSize) entry.fileSize = fileSize
      if (sha256) entry.sha256 = sha256
      // Remove any cached-duration or validity flags that may cause rejection
      delete entry.invalid
      delete entry.needsReencode
      // Remove ALL CDN URL keys so WallpaperAgent has no remote URL to
      // re-validate against. Without this, WallpaperAgent sees the SourceURL
      // xattr (or the url-4K-SDR-240FPS field), fetches the original Apple
      // aerial from the CDN, and silently overwrites our file.
      const urlKeys = Object.keys(entry).filter(k =>
        k.startsWith('url-') || k === 'url' || k === 'downloadURL' || k === 'sourceURL'
      )
      for (const k of urlKeys) delete entry[k]
      patched = true
    }
  }

  if (Array.isArray(data)) {
    data.forEach(patchEntry)
  } else if (data && typeof data === 'object') {
    // Could be { entries: [...] } or { assets: [...] } or similar
    const arrKey = Object.keys(data).find(k => Array.isArray(data[k]))
    if (arrKey) {
      data[arrKey].forEach(patchEntry)
    } else {
      patchEntry(data)
    }
  }

  if (patched) {
    fs.writeFileSync(ENTRIES_JSON_PATH, JSON.stringify(data, null, 2), 'utf8')
    console.log('[extension-mac] entries.json updated for slot:', slotId)
  } else {
    console.warn('[extension-mac] No matching entry found in entries.json for slot id:', slotId, '— file written anyway')
    fs.writeFileSync(ENTRIES_JSON_PATH, JSON.stringify(data, null, 2), 'utf8')
  }
}

/**
 * Restore entries.json from backup.
 */
function restoreEntriesJson () {
  const backupPath = ENTRIES_JSON_PATH + '.nwpe_orig'
  if (!fs.existsSync(backupPath)) return
  try {
    fs.copyFileSync(backupPath, ENTRIES_JSON_PATH)
    fs.unlinkSync(backupPath)
    console.log('[extension-mac] entries.json restored from backup')
  } catch (e) {
    console.warn('[extension-mac] Could not restore entries.json:', e.message)
  }
}

// ── Index.plist patching (lock screen provider) ───────────────────────────────

/**
 * Patch Index.plist so every Idle (lock screen) section uses
 * com.apple.wallpaper.choice.aerials pointing at slotId, instead of the
 * default com.apple.wallpaper.choice.sequoia provider.
 *
 * Without this patch WallpaperAgent plays the static Sequoia wallpaper on
 * every lock after the first, because the Idle provider in Index.plist takes
 * precedence over the aerial slot file.
 *
 * Configuration is a binary plist nested inside the outer binary plist.
 * plutil's JSON converter corrupts it, so we use Python's plistlib (always
 * present on macOS) for the full read-modify-write cycle.
 *
 * Backs up to Index.plist.nwpe_orig before the first edit.
 */
function patchIndexPlistIdle (slotId) {
  if (!fs.existsSync(INDEX_PLIST_PATH)) {
    console.warn('[extension-mac] Index.plist not found — skipping idle patch:', INDEX_PLIST_PATH)
    return
  }

  const backupPath = INDEX_PLIST_PATH + '.nwpe_orig'
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(INDEX_PLIST_PATH, backupPath)
    console.log('[extension-mac] Backed up Index.plist to:', backupPath)
  }

  // Python script: read the binary plist, walk every Idle→Content→Choices entry,
  // set Provider to aerials and Configuration to a nested bplist {assetID: slotId}.
  const script = `
import plistlib, sys, os

slot_id = sys.argv[1]
plist_path = sys.argv[2]

with open(plist_path, 'rb') as f:
    data = plistlib.load(f)

# Build the nested Configuration bplist: { assetID: "<UUID>" }
cfg_bytes = plistlib.dumps({'assetID': slot_id}, fmt=plistlib.FMT_BINARY)

patched = 0

def walk(obj):
    global patched
    if not isinstance(obj, dict):
        return
    if 'Idle' in obj:
        idle = obj['Idle']
        if isinstance(idle, dict):
            content = idle.get('Content', {})
            choices = content.get('Choices', [])
            for choice in choices:
                if isinstance(choice, dict):
                    choice['Provider'] = 'com.apple.wallpaper.choice.aerials'
                    choice['Configuration'] = cfg_bytes
                    patched += 1
    for v in obj.values():
        if isinstance(v, dict):
            walk(v)
        elif isinstance(v, list):
            for item in v:
                walk(item)

walk(data)

if patched == 0:
    print('WARN: no Idle choices found', file=sys.stderr)
    sys.exit(0)

tmp = plist_path + '.nwpe_tmp'
with open(tmp, 'wb') as f:
    plistlib.dump(data, f, fmt=plistlib.FMT_BINARY)
os.replace(tmp, plist_path)
print(f'OK: {patched} Idle choice(s) patched')
`

  const tmpScript = path.join(os.tmpdir(), 'nwpe_patch_index.py')
  try {
    fs.writeFileSync(tmpScript, script, 'utf8')
    const result = spawnSync(
      'python3', [tmpScript, slotId, INDEX_PLIST_PATH],
      { encoding: 'utf8', stdio: 'pipe' }
    )
    if (result.status !== 0) {
      console.warn('[extension-mac] Index.plist patch script error:', result.stderr)
    } else {
      console.log('[extension-mac]', result.stdout.trim())
    }
  } catch (e) {
    console.warn('[extension-mac] Index.plist patch failed:', e.message)
  } finally {
    try { fs.unlinkSync(tmpScript) } catch {}
  }
}

/**
 * Restore Index.plist from backup.
 */
function restoreIndexPlist () {
  const backupPath = INDEX_PLIST_PATH + '.nwpe_orig'
  if (!fs.existsSync(backupPath)) return
  try {
    fs.copyFileSync(backupPath, INDEX_PLIST_PATH)
    fs.unlinkSync(backupPath)
    console.log('[extension-mac] Index.plist restored from backup')
  } catch (e) {
    console.warn('[extension-mac] Could not restore Index.plist:', e.message)
  }
}

// ── HEVC conversion via mac-helper ────────────────────────────────────────────

/**
 * Request aerial-spec HEVC .mov conversion from the bundled Swift mac-helper.
 *
 * The conversion is done inside the Swift helper using VideoToolbox
 * (VTCompressionSession / AVAssetWriter) with the 2-layer temporal hierarchy
 * required by WallpaperAerialsExtension. A plain libx265 encode from ffmpeg
 * produces a stream that is rejected by the aerial path.
 *
 * The helper is invoked synchronously with the `--convert` flag:
 *   mac-helper --convert <inputPath> --output <outputPath>
 * It exits 0 on success, non-zero on failure.
 *
 * Output is cached keyed on the SHA-256 hash of the source file; re-run only
 * when the source changes.
 */
function getHelperPath () {
  const { app } = require('electron')
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'mac-helper')
  }
  return path.join(__dirname, '..', 'native', 'mac-helper', '.build', 'release', 'mac-helper')
}

async function convertToHevcMov (videoPath) {
  const helperPath = getHelperPath()
  if (!fs.existsSync(helperPath)) {
    throw new Error(
      'mac-helper binary not found.\n' +
      'Run: npm run build:mac-helper\n' +
      'Then restart NotWallpaperEngine.'
    )
  }

  fs.mkdirSync(CONVERTED_DIR, { recursive: true })

  // Cache key = SHA-256 of source file + encode version.
  // Bump ENCODE_VERSION whenever the encoder settings change so stale cached
  // files are ignored automatically (the old file is left in place; it will
  // just never be referenced again).
  const ENCODE_VERSION = 2  // v2: mediaTimeScale=240000, bitrate 12Mbps, srcFPS key-frame
  const srcBuf = fs.readFileSync(videoPath)
  const srcHash = crypto.createHash('sha256').update(srcBuf).digest('hex').slice(0, 16)
  const baseName = path.basename(videoPath, path.extname(videoPath))
  const outPath = path.join(CONVERTED_DIR, `${baseName}_${srcHash}_v${ENCODE_VERSION}_hevc.mov`)

  if (fs.existsSync(outPath)) {
    console.log('[extension-mac] Using cached HEVC conversion:', outPath)
    return outPath
  }

  console.log('[extension-mac] Requesting HEVC conversion from mac-helper…')

  // Ensure helper is executable
  try { fs.chmodSync(helperPath, 0o755) } catch (e) {}

  const result = spawnSync(
    helperPath,
    ['--convert', videoPath, '--output', outPath],
    { encoding: 'utf8', timeout: 15 * 60 * 1000 }
  )

  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim()
    throw new Error(`mac-helper HEVC conversion failed:\n${msg}`)
  }

  if (!fs.existsSync(outPath)) {
    throw new Error('mac-helper reported success but output file not found: ' + outPath)
  }

  console.log('[extension-mac] HEVC conversion complete:', outPath)
  return outPath
}

// ── WallpaperAgent reload ─────────────────────────────────────────────────────

/**
 * Restart WallpaperAgent (and WallpaperAerialsExtension) so the lock screen
 * picks up the changed slot without a reboot. Non-fatal.
 */
function reloadWallpaperAgentInternal () {
  const procs = ['WallpaperAgent', 'WallpaperAerialsExtension']
  for (const proc of procs) {
    try {
      execSync(`killall "${proc}" 2>/dev/null; true`, { stdio: 'pipe' })
      console.log(`[extension-mac] Killed ${proc}`)
    } catch { /* not running — ok */ }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function activate (videoPath) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`)
  }

  // 1. Convert to aerial-spec HEVC .mov via bundled Swift helper
  const hevcPath = await convertToHevcMov(videoPath)

  // 2. Find the active aerial slot under ~/…/aerials/videos/
  const slot = findAerialSlot()
  if (!slot) {
    throw new Error(
      'No macOS Aerial video slot found.\n\n' +
      'Requires macOS 26 (Tahoe) or later.\n' +
      'Open System Settings → Wallpaper, download any animated wallpaper ' +
      '(e.g. "Tahoe Day"), set it as your wallpaper, then try again.'
    )
  }

  const { slotPath, slotId } = slot

  // 3. Back up original slot file (idempotent — only if no backup exists)
  const backupPath = slotPath + '.nwpe_orig'
  if (!fs.existsSync(backupPath)) {
    console.log('[extension-mac] Backing up original aerial slot:', slotPath)
    fs.copyFileSync(slotPath, backupPath)
  }

  // 4. Atomic replace: write temp to same directory (same volume), then rename
  const tmpDest = slotPath + '.nwpe_tmp'
  fs.copyFileSync(hevcPath, tmpDest)
  fs.renameSync(tmpDest, slotPath)
  console.log('[extension-mac] Aerial slot replaced:', slotPath)

  // 4a. Strip ALL extended attributes from the slot file.
  //
  // The original Apple aerial has xattrs including:
  //   com.apple.metadata:kMDItemWhereFroms  (SourceURL — CDN URL)
  //   com.apple.quarantine
  //   com.apple.provenance
  //   LastETag
  //
  // When WallpaperAgent restarts, it reads the SourceURL xattr and re-fetches
  // the original file from Apple's CDN if the file size/hash doesn't match
  // what the CDN says.  Stripping xattrs from our replacement file prevents
  // that re-download entirely.
  try {
    execSync(`xattr -c ${JSON.stringify(slotPath)}`, { stdio: 'pipe' })
    console.log('[extension-mac] Cleared xattrs from slot file')
  } catch (e) {
    console.warn('[extension-mac] xattr -c failed (non-fatal):', e.message)
  }

  // 5. Update entries.json so WallpaperAgent accepts the new file
  updateEntriesJson(slotId, slotPath)

  // 6. Patch Index.plist Idle entries to use the aerials provider.
  //    Without this, WallpaperAgent shows the static Sequoia wallpaper on the
  //    lock screen from the second lock onward (Idle overrides the slot file).
  patchIndexPlistIdle(slotId)

  // 7. Restart WallpaperAgent so lock screen picks up the change
  reloadWallpaperAgentInternal()

  // 8. Persist state for deactivate/restore
  saveState({ slotPath, backupPath, hevcPath, videoPath, slotId })
  console.log('[extension-mac] Lock screen activated with:', videoPath)
}

async function deactivate () {
  const state = loadState()
  if (!state?.backupPath || !fs.existsSync(state.backupPath)) {
    console.log('[extension-mac] No backup found; nothing to restore.')
    restoreEntriesJson()
    restoreIndexPlist()
    clearState()
    return
  }

  const { slotPath, backupPath } = state

  // Restore original aerial slot
  const tmpRestore = slotPath + '.nwpe_restore'
  fs.copyFileSync(backupPath, tmpRestore)
  fs.renameSync(tmpRestore, slotPath)
  console.log('[extension-mac] Original aerial slot restored:', slotPath)

  // Remove backup
  try { fs.unlinkSync(backupPath) } catch { /* ok */ }

  // Restore entries.json and Index.plist from backups
  restoreEntriesJson()
  restoreIndexPlist()

  reloadWallpaperAgentInternal()
  clearState()
  console.log('[extension-mac] Lock screen deactivated.')
}

function isActive () {
  const state = loadState()
  if (state?.backupPath) return fs.existsSync(state.backupPath)
  // Fallback: check if any slot has our backup suffix
  const slot = findAerialSlot()
  return slot ? fs.existsSync(slot.slotPath + '.nwpe_orig') : false
}

function isActiveFor (_videoPath) { return isActive() }

function isInstalled () { return isActive() }

/**
 * Check that all prerequisites are met.
 * Returns { ok, missing, diagnostics } where diagnostics is a plain-text
 * summary of what was found on disk (useful for debugging false negatives).
 */
function checkPrerequisites () {
  const missing = []
  const diag = []

  // mac-helper binary (needed for VideoToolbox HEVC encode)
  const helperPath = getHelperPath()
  if (!fs.existsSync(helperPath)) {
    missing.push('mac-helper binary not built (run: npm run build:mac-helper)')
    diag.push(`mac-helper: NOT FOUND at ${helperPath}`)
  } else {
    diag.push(`mac-helper: OK (${helperPath})`)
  }

  // Tahoe aerial videos directory
  if (!fs.existsSync(AERIAL_VIDEOS_DIR)) {
    missing.push(
      'Aerial videos directory not found — requires macOS 26 (Tahoe) or later. ' +
      'Open System Settings → Wallpaper, download an animated wallpaper and set it as active.'
    )
    diag.push(`aerials/videos: NOT FOUND (${AERIAL_VIDEOS_DIR})`)
  } else {
    const slots = listAerialSlots()
    diag.push(`aerials/videos: found ${slots.length} slot(s): ${slots.map(s => path.basename(s.slotPath)).join(', ') || '(none)'}`)
    if (slots.length === 0) {
      missing.push(
        'No .mov files found in aerials/videos — open System Settings → Wallpaper, ' +
        'download at least one animated wallpaper and set it as active.'
      )
    }
  }

  // entries.json
  if (!fs.existsSync(ENTRIES_JSON_PATH)) {
    diag.push(`entries.json: NOT FOUND (${ENTRIES_JSON_PATH})`)
  } else {
    diag.push(`entries.json: OK (${ENTRIES_JSON_PATH})`)
  }

  return { ok: missing.length === 0, missing, diagnostics: diag.join('\n') }
}

// ── Legacy stubs ──────────────────────────────────────────────────────────────

function build    () { console.log('[extension-mac] build() — no-op.') }
function install  () { console.log('[extension-mac] install() — no-op.'); return true }
function uninstall () { console.log('[extension-mac] uninstall() — no-op.') }
function reloadWallpaperAgent () { reloadWallpaperAgentInternal() }

module.exports = {
  build,
  install,
  uninstall,
  reloadWallpaperAgent,
  activate,
  deactivate,
  isActive,
  isActiveFor,
  isInstalled,
  checkPrerequisites,
}
