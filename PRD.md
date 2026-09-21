# NotWallpaperEngine — Product Requirements Document

> *"Legally distinct. Spiritually identical."*

---

## 1. Overview

**NotWallpaperEngine** is a cross-platform desktop application that lets users set videos as live wallpapers on their desktop and as screensavers (with optional lock-screen-equivalent behavior). It targets macOS, Windows, and Linux, and is built with Electron as the UI shell with platform-specific native helpers for wallpaper injection.

Inspired by [Wallper](https://www.wallper.app/) on macOS and [Wallpaper Engine](https://store.steampowered.com/app/431960/Wallpaper_Engine/) on Windows, NotWallpaperEngine is an open, cross-platform alternative with a sarcastic name and zero pretension.

---

## 2. Goals

- Allow users to set any local video file as their desktop live wallpaper on macOS, Windows, and Linux.
- Allow users to set any local video file as their screensaver on macOS and Windows.
- On macOS 26 (Tahoe)+, allow the desktop video to be applied separately as the animated lock-screen wallpaper through the system aerial pipeline.
- On Windows, the screensaver can be combined with "Require sign-in on resume" for a lock-screen-equivalent experience.
- Provide a clean, minimal tray-based UI — stays out of the way.
- Persist user settings across reboots.
- Support multiple monitors.

---

## 3. Non-Goals

- **No Windows lock screen injection** — `LockApp.exe` runs in Session 0 and is not accessible to user-space apps. Out of scope permanently.
- **No Linux lock screen** — too fragmented across lockers; screensaver mode via `xscreensaver` is the limit.
- **No web wallpapers** — video files only (no URLs, no HTML wallpapers, no Shader/WebGL wallpapers in v1).
- **No audio** — all wallpaper video playback is muted. Background audio from wallpapers is universally annoying.
- **No Wayland support in v1** — X11 only on Linux. Wayland support planned for v2 via `wlr-layer-shell`.
- **No built-in video library / marketplace** — users bring their own videos.

---

## 4. Target Users

- Power users and developers who want a clean, open-source live wallpaper tool.
- macOS users who want Wallper-like functionality without paying $9.99.
- Windows users who want Wallpaper Engine-like functionality without Steam.
- Linux users who have been told "just use a script" one too many times.

---

## 5. Platforms & Support Matrix

| Feature | macOS (13+) | Windows (10/11) | Linux (X11) |
|---|---|---|---|
| Desktop live wallpaper | ✅ | ✅ | ✅ |
| Multi-monitor support | ✅ | ✅ | ✅ |
| Screensaver (video) | ✅ | ✅ | ✅ (xscreensaver) |
| Lock screen live wallpaper | ✅ (aerial injection, macOS 26 Tahoe+) | ❌ (OS blocked) | ❌ (OS blocked) |
| "Lock on screensaver" support | ✅ (native macOS) | ✅ (registry flag) | ✅ (xss-lock) |
| Pause on battery | ✅ | ✅ | ✅ |
| Pause when screen locked | ✅ | ✅ | ✅ |
| Pause on fullscreen app | ✅ | ✅ | ⚠️ best-effort |

---

## 6. Features

### 6.1 Core — Desktop Live Wallpaper

- User picks a local video file (MP4, MOV, WebM, MKV).
- **macOS note:** the native helper uses AVFoundation, which cannot play WebM/MKV, so on macOS every input is first normalized to an aerial-spec HEVC `.mov` (§6.3.1) — the *same* asset the lock-screen path reuses.
- The video plays fullscreen behind all windows, above the static desktop background, below desktop icons (window level `kCGDesktopIconWindowLevel - 1` on macOS — see §7.2).
- Video loops seamlessly.
- Video is always muted.
- Playback is hardware-accelerated.
- Works across all connected monitors simultaneously (one video per monitor or same video mirrored).

### 6.2 Screensaver Mode

- User can optionally set the same (or a different) video as the system screensaver.
- **macOS**: Installs a `.saver` bundle to `~/Library/Screen Savers/` and sets it as the active screensaver via `defaults write`. The `.saver` reads the chosen video path from a shared `UserDefaults` suite. This idle screensaver is separate from the macOS 26 lock-screen wallpaper (§6.3) — they are set independently.
- **Windows**: Installs a `.scr` file (a minimal Electron renderer process packaged as an executable, renamed `.scr`) and registers it via the `HKCU\Control Panel\Desktop\SCRNSAVE.EXE` registry key. Optionally sets `ScreenSaverIsSecure=1` for password-on-resume behavior.
- **Linux**: Writes an `xscreensaver` hack config that launches `mpv --fs --loop` with the chosen video. Requires `xscreensaver` and `mpv` to be installed.

### 6.3 macOS Live Lock Screen (aerial injection)

> **Why a separate path from the desktop?** Setting an aerial as the *desktop* wallpaper only plays it once on wake and then holds a still frame — continuous looping happens only on the lock screen and screensaver. So the desktop uses the native `AVPlayer` window (§6.1, loops), and the lock screen uses aerial injection (the only route to video there). The two share a single converted asset (§6.3.1).

- **Requires macOS 26 (Tahoe) or later.** The asset location and manifest format below are Tahoe-specific. The Sonoma/Sequoia layout (`Index.plist` + `.../com.apple.idleassetsd/Customer/4KSDR240FPS/`) is a *different* mechanism and is **not** targeted in v1.
- Requires at least one Aerial/animated wallpaper downloaded **and currently set** as the wallpaper in System Settings → Wallpaper, so there is an active slot to overwrite.
- **Approach — overwrite the currently-active aerial slot** (so no System Settings re-selection is needed):
  1. **Convert** the source video to the aerial-spec HEVC `.mov` (§6.3.1). This is the same file the desktop window plays.
  2. **Locate** the active aerial's `.mov` under `~/Library/Application Support/com.apple.wallpaper/aerials/videos/` — a per-user, user-writable directory (not a SIP-protected DataVault). Files are named by UUID.
  3. **Atomically replace** that slot's `.mov` with the converted file (same-volume temp-file-then-rename).
  4. **Update** the matching entry in Tahoe's **`entries.json`** manifest (edited via `JSONSerialization` or `jq` — **not** `Index.plist`/`plutil`) so the recorded asset metadata matches the new file and `WallpaperAgent` does not reject it during validation.
  5. **Restart** `WallpaperAgent` (and `WallpaperAerialsExtension`) so the lock screen picks up the change without a reboot.
- Backs up the original slot `.mov` (`.nwpe_orig` suffix) **and** the pre-edit `entries.json`; restores both on deactivate — fully idempotent.
- **Must run as the logged-in user, never via `sudo`.** Running as root targets `/var/root/Library` and silently no-ops. No administrator password is required and no SIP disable is needed — all target paths are user-writable.
- The override is lost when the user changes their aerial in System Settings or after some macOS updates; the app detects this and re-applies (or prompts to).
- State is persisted in `~/Library/Application Support/com.notwallpaperengine/lockscreen-state.json`.
- Not compatible with Mac App Store sandboxing (direct download only).
- **Reference implementations:** [AerialWall](https://github.com/CatKinKitKat/AerialWall) and [LivePaper](https://github.com/Raunik2/LivePaper) implement this exact Tahoe pipeline (`entries.json` injection + VideoToolbox HEVC) and are the source of truth for the manifest schema.
- ⚠️ **Undocumented mechanism.** It can break on any macOS point release (the format already changed Sequoia → Tahoe). Treat lock-screen video as best-effort: on failure, fall back to writing a representative still frame as the lock-screen background.

### 6.3.1 macOS Video Conversion (shared by desktop + lock screen)

- **One encode, both surfaces.** The desktop `AVPlayer` window is forgiving (it loops any AVFoundation-playable file); the aerial slot is strict. So encode once to the *strict* format and reuse it for both — do not maintain two encodes.
- **Target format:** HEVC in a `.mov` container, encoded via **VideoToolbox** with the **2-layer temporal hierarchy** that `WallpaperAerialsExtension` requires. A plain `ffmpeg -c:v libx265` (software) encode plays fine in the desktop window but is **rejected by the aerial path (black screen)**, so it cannot be the shared asset.
- **Do the encode in the bundled Swift helper** (`VTCompressionSession` / `AVAssetWriter`), *not* by shelling out to a user-installed `ffmpeg`. This guarantees the temporal-hierarchy format and removes the external `ffmpeg` dependency on macOS entirely. (A user's Homebrew `ffmpeg` may lack `hevc_videotoolbox` or emit a non-conformant stream.)
- **Inputs that must be transcoded:** everything except an already-verified aerial-spec HEVC `.mov` — including WebM, MKV, GIF, and H.264 `.mp4` (AVFoundation cannot play WebM/MKV at all).
- **Validate** the encoder output against a known-good Apple aerial's stream structure before applying; if it doesn't match, disable lock-screen injection rather than ship a file that black-screens.
- **Cache** the converted `.mov` keyed on the source-file hash; re-run only when the source changes.
- If VideoToolbox HEVC encode is unavailable on the machine, the **desktop wallpaper still works** (any decodable source is fine for `AVPlayer`) but **lock-screen injection is disabled** — there is no software fallback for the aerial path.

### 6.4 Lock-Screen-Now Shortcut

- On macOS, a global hotkey can be configured in the Hotkeys tab ("Lock Screen Now" row).
- The shortcut starts the screensaver (`ScreenSaverEngine -background`) immediately.
- Since `requirePasswordOnResume` is enabled by default, resuming from the screensaver requires the user's password — functionally equivalent to locking the screen.
- **Note:** `Cmd+Ctrl+Q` is a system-reserved shortcut and cannot be captured by Electron; users must choose a different key combination (e.g. `Cmd+Shift+L`).
- A "Lock Screen Now" button is also available in the Lock Screen settings tab.

### 6.5 Tray Application

- App lives in the system tray / menu bar — no persistent Dock/Taskbar icon.
- Tray menu items:
  - **Set Desktop Wallpaper** → opens file picker
  - **Set Screensaver** → opens file picker (separate video allowed)
  - **Pause / Resume** wallpaper playback
  - **Settings** → opens settings window
  - **Quit**
- macOS: menu bar icon (top right).
- Windows: system tray icon (bottom right).
- Linux: system tray icon (via `electron-tray`).

### 6.6 Settings

- **General**
  - Launch at login (toggle)
  - Pause wallpaper when on battery (toggle, default: on)
  - Pause wallpaper when display is sleeping (toggle, default: on)
  - Pause when a fullscreen app is active (toggle, default: on)
- **Wallpaper**
  - Selected video file path (with "Change" button)
  - Playback speed (0.5x – 2x)
  - Fit mode: Cover / Contain / Stretch
- **Screensaver**
  - Enable screensaver mode (toggle)
  - Selected screensaver video (can differ from wallpaper video)
  - Idle timeout (minutes)
  - Require password on resume (toggle) — maps to macOS "Require password after screensaver begins" and Windows `ScreenSaverIsSecure`
- **Multi-monitor**
  - Display list with per-display video assignment
  - "Mirror to all displays" shortcut toggle
- **About**
  - Version, GitHub link, license

### 6.7 Pause / Performance Logic

- Monitor power source via Electron's `powerMonitor` API.
- Monitor screen lock via `powerMonitor` `lock-screen` / `unlock-screen` events.
- Detect fullscreen apps:
  - macOS: poll `CGWindowListCopyWindowInfo` via Swift helper
  - Windows: `SHQueryUserNotificationState` via ffi-napi
  - Linux: check `_NET_WM_STATE_FULLSCREEN` via ewmh
- When paused, the wallpaper window shows the last rendered frame (frozen), not a black screen.

---

## 7. Technical Architecture

### 7.1 Process Model

```
NotWallpaperEngine.app / .exe / .AppImage
│
├── Main Process (Electron / Node.js)
│   ├── Tray icon + menu
│   ├── Settings window (BrowserWindow)
│   ├── IPC hub — receives commands from renderer
│   ├── Platform dispatcher (mac / win / linux modules)
│   └── electron-store (settings persistence)
│
├── Wallpaper Window (BrowserWindow — hidden from taskbar)
│   └── renderer/wallpaper.html — <video> fullscreen
│       (Windows + Linux only; macOS uses native Swift window)
│
└── Native Helpers (bundled binaries)
    ├── mac-helper  (Swift CLI — desktop wallpaper window via AVPlayer)
    ├── NotWPESaver.saver (Swift ScreenSaver bundle — macOS idle screensaver)
    └── NotWPE.scr  (Electron renderer exe — Windows screensaver)
```

### 7.2 Platform Wallpaper Injection

#### macOS
- A bundled Swift CLI binary (`mac-helper`) is spawned via `child_process.execFile`.
- It creates an `NSWindow` at **`kCGDesktopIconWindowLevel - 1`**, spanning all monitors, and plays the video using `AVPlayerLayer`. The window must sit *above the static desktop picture and below the icons*; the icon level minus one is between them. (`kCGDesktopWindowLevel - 1` is **below** the desktop-picture level and would be occluded by it — do not use it.)
- The helper also owns the HEVC/VideoToolbox conversion (§6.3.1), so a single asset feeds both the desktop window and the lock-screen injection.
- IPC between Electron and the helper: stdin/stdout JSON messages (set video path, pause, resume, quit).
- The macOS 26 lock screen uses a separate aerial-injection pipeline: aerial-spec HEVC conversion, atomic slot replacement under `com.apple.wallpaper/aerials/videos/`, entry update in **`entries.json`** (not `Index.plist`), and `WallpaperAgent` reload.

#### Windows
- A Chromium `BrowserWindow` is created (frame: false, transparent, skipTaskbar: true).
- `ffi-napi` is used to call Win32:
  1. `FindWindow("Progman", null)` to get the Progman handle
  2. `SendMessageTimeout` with `0x052C` to spawn the `WorkerW` layer
  3. `EnumWindows` to find the `WorkerW` handle
  4. `SetParent(electronHWND, workerWHWND)` to reparent the Electron window behind icons
- The Electron window renders `renderer/wallpaper.html` (fullscreen `<video>`).

#### Linux (X11)
- A `BrowserWindow` is created.
- The `ewmh` npm package sets `_NET_WM_WINDOW_TYPE` to `_NET_WM_WINDOW_TYPE_DESKTOP` on the window's X11 ID (obtained via `BrowserWindow.getNativeWindowHandle()`).

### 7.3 Key Dependencies

| Package | Purpose |
|---|---|
| `electron` | App shell, BrowserWindow, Tray, powerMonitor |
| `electron-store` | JSON settings persistence |
| `electron-builder` | Cross-platform packaging |
| `ffi-napi` | Windows Win32 API calls (native wallpaper + screensaver registry) |
| `ref-napi` | Pointer types for ffi-napi |
| `winreg` | Windows registry read/write (screensaver registration) |
| `ewmh` | Linux EWMH desktop window type |
| Swift `AVFoundation` | macOS video playback in helper + saver bundle |
| Swift `ScreenSaver.framework` | macOS `.saver` bundle base class |

### 7.4 Project Structure

```
NotWallpaperEngine/
├── package.json
├── electron-builder.yml
├── PRD.md
├── README.md
│
├── main/
│   ├── index.js                  ← App entry: tray, windows, IPC
│   ├── wallpaper-mac.js          ← Spawn mac-helper, manage lifecycle
│   ├── wallpaper-extension-mac.js ← aerial slot injection (entries.json) for lock screen
│   ├── wallpaper-win.js          ← WorkerW injection via ffi-napi
│   ├── wallpaper-linux.js        ← ewmh desktop window type
│   ├── screensaver-mac.js        ← Install .saver, write defaults
│   ├── screensaver-win.js        ← Install .scr, write registry
│   ├── screensaver-linux.js      ← Write xscreensaver config
│   ├── performance-monitor.js    ← Battery, fullscreen, lock detection
│   └── store.js                  ← electron-store schema + helpers
│
├── renderer/
│   ├── wallpaper.html            ← Fullscreen <video> (Win + Linux)
│   ├── wallpaper.js
│   ├── ui.html                   ← Settings window
│   ├── ui.js
│   └── ui.css
│
├── native/
│   ├── mac-helper/               ← Swift package (CLI binary)
│   │   ├── Package.swift
│   │   └── Sources/
│   │       └── main.swift
│   └── mac-saver/                ← Swift .saver bundle
│       ├── Info.plist
│       ├── build-saver.sh
│       └── Sources/
│           └── NotWPESaver.swift
│
├── assets/
│   ├── tray-icon.png
│   ├── tray-icon@2x.png
│   └── icon.icns / icon.ico / icon.png
│
└── build/                        ← electron-builder output (gitignored)
```

---

## 8. Data Model (electron-store)

```json
{
  "wallpaper": {
    "videoPath": "/Users/arnav/Videos/lofi.mp4",
    "fitMode": "cover",
    "playbackSpeed": 1.0,
    "perDisplay": {
      "1": "/Users/arnav/Videos/lofi.mp4",
      "2": "/Users/arnav/Videos/city.mp4"
    }
  },
  "screensaver": {
    "enabled": false,
    "videoPath": "/Users/arnav/Videos/lofi.mp4",
    "idleTimeoutMinutes": 5,
    "requirePasswordOnResume": true
  },
  "performance": {
    "pauseOnBattery": true,
    "pauseOnLock": true,
    "pauseOnFullscreen": true
  },
  "general": {
    "launchAtLogin": false
  }
}
```

---

## 9. Supported Video Formats

| Format | Container | Notes |
|---|---|---|
| H.264 | `.mp4`, `.mov` | Universal, recommended |
| H.265 / HEVC | `.mp4`, `.mov` | macOS hardware decode; Windows 10+ with codec pack |
| VP8 / VP9 | `.webm` | Good for Linux |
| AV1 | `.webm`, `.mp4` | Future-proof; decode support varies |
| ProRes | `.mov` | macOS only |

Chromium's `<video>` tag (Windows/Linux) handles format detection automatically. The macOS native helper uses `AVPlayer`/AVFoundation, which plays only Apple-native formats — **not WebM or MKV** — so on macOS all inputs are transcoded to the aerial-spec HEVC `.mov` described in §6.3.1 before use on either the desktop or the lock screen.

---

## 10. Packaging & Distribution

| Platform | Format | Notes |
|---|---|---|
| macOS | `.dmg` | Must be code-signed + notarized for Gatekeeper |
| Windows | NSIS `.exe` installer | Bundles `.scr` file, installs to `%APPDATA%` |
| Linux | `.AppImage` | Portable, no install needed |
| Linux | `.deb` / `.rpm` | Optional for package manager distribution |

macOS code signing requires an Apple Developer account ($99/yr). Without signing, users must right-click → Open to bypass Gatekeeper.

---

## 11. Milestones

| Milestone | Scope |
|---|---|
| **M1 — Foundation** | Electron shell, tray, settings UI, electron-store, file picker |
| **M2 — Windows Wallpaper** | WorkerW injection, fullscreen video renderer, multi-monitor |
| **M3 — Linux Wallpaper** | ewmh desktop type, X11 integration, multi-monitor |
| **M4 — macOS Wallpaper** | Swift helper binary, AVPlayer window, multi-monitor |
| **M5 — Windows Screensaver** | `.scr` binary, registry integration, password-on-resume |
| **M6 — macOS Screensaver/Lock** | `.saver` bundle for idle playback; lock-screen video injection via `entries.json` aerial-slot replacement under `~/Library/Application Support/com.apple.wallpaper/aerials/videos/` (user-writable, no elevation); AVFoundation/VideoToolbox encoder in `mac-helper` |
| **M7 — Linux Screensaver** | xscreensaver config, mpv integration |
| **M8 — Performance & Polish** | Battery/lock/fullscreen pause, launch at login, packaging |

---

## 12. Open Questions

1. Should v1 support animated GIFs in addition to video files?
2. Should there be a "preview" mode that plays the wallpaper in a small window before applying?
3. For multi-monitor: should the app remember per-display assignments by display serial number or by display index?
4. Should the Windows `.scr` be a separate Electron build or a compiled native binary for smaller size?
5. macOS: the aerial-injection lock-screen path writes into `~/Library/Application Support/com.apple.wallpaper` and restarts system agents, so it **cannot** be sandboxed — macOS builds are direct-download only (not Mac App Store). Remaining sub-question: is the desktop-only `kCGDesktopIconWindowLevel - 1` window worth shipping as a separate sandboxed App Store build, or not worth maintaining two variants?