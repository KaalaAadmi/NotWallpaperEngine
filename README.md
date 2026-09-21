# NotWallpaperEngine

> *"Legally distinct. Spiritually identical."*

A cross-platform live wallpaper app built with Electron. Set any local video as your desktop wallpaper and screensaver on macOS, Windows, and Linux. Inspired by [Wallper](https://www.wallper.app/) and [Wallpaper Engine](https://store.steampowered.com/app/431960/Wallpaper_Engine/) — open-source, zero pretension.

---

## Features

- 🎬 **Live desktop wallpaper** — MP4, MOV, WebM, MKV; hardware-accelerated playback
- 🖥️ **Multi-monitor** — mirror the same video to all displays, or assign a different video per display
- 🔒 **Live lock screen wallpaper** — macOS 26 (Tahoe)+ only; replaces the active Aerial slot so your video plays on the lock and login screen, no admin password required
- 💤 **Screensaver mode** — macOS (`.saver` bundle), Windows (`.scr` file), Linux (`xscreensaver` + `mpv`)
- 🔇 **Auto-mute on lock** — wallpaper audio is silenced when the screen locks and restored to its previous state on unlock
- 🔋 **Smart pausing** — auto-pause on battery, screen lock, or fullscreen apps
- ⌨️ **Global hotkeys** — Pause/Resume, Mute/Unmute, Lock Screen Now (macOS); all configurable
- 🗂️ **Tray-only UI** — lives in your menu bar / system tray, no Dock or Taskbar icon

---

## Platform support

| Feature | macOS 13+ | macOS 26 (Tahoe)+ | Windows 10/11 | Linux (X11) |
|---|---|---|---|---|
| Desktop live wallpaper | ✅ | ✅ | ✅ | ✅ |
| Multi-monitor | ✅ | ✅ | ✅ | ✅ |
| Screensaver | ✅ | ✅ | ✅ | ✅ (xscreensaver) |
| Live lock screen wallpaper | ❌ | ✅ aerial injection | ❌ OS blocked | ❌ OS blocked |
| Auto-mute on screen lock | ✅ | ✅ | ✅ | ✅ |
| Pause on battery | ✅ | ✅ | ✅ | ✅ |
| Pause on screen lock | ✅ | ✅ | ✅ | ✅ |
| Pause on fullscreen app | ✅ | ✅ | ✅ | ⚠️ best-effort |

---

## Getting started

### Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ | |
| npm 9+ | |
| **macOS**: Xcode 15+ | Required to build the Swift helper and `.saver` bundle |
| **macOS hotkeys**: Accessibility permission | Required for global shortcuts to fire — app prompts automatically on first run |
| **Windows**: Visual Studio Build Tools | For native addon compilation (`ffi-napi`) |
| **Linux**: `build-essential`, `libx11-dev`, `xprop` | `xprop` is used to set the desktop window type |
| **Linux screensaver**: `xscreensaver`, `mpv` | Only needed for screensaver mode; the Settings UI shows install instructions if missing |

> **No `ffmpeg` required.** Video conversion is done entirely by the bundled Swift binary using Apple's `AVFoundation` + `VideoToolbox` APIs.

### Install

```bash
npm install
```

### Build native helpers (macOS)

The Swift helper must be compiled before first run on macOS:

```bash
npm run build:mac-helper   # desktop wallpaper binary + HEVC encoder
npm run build:mac-saver    # .saver bundle for idle screensaver
# or both at once:
npm run build:native-mac
```

### Run in development

```bash
npm start
```

### Package for distribution

```bash
npm run build:mac     # macOS  → .dmg (arm64 + x64)
npm run build:win     # Windows → NSIS .exe installer
npm run build:linux   # Linux  → .AppImage + .deb
```

---

## Settings

Open **Settings…** from the tray menu or by clicking the menu bar icon.

| Tab | What you can do |
|---|---|
| **Wallpaper** | Pick a video, set fit mode (Cover / Contain / Stretch), playback speed |
| **Lock Screen** | Enable the live lock screen wallpaper (macOS 26 Tahoe+ only), check prerequisites, refresh status |
| **Screensaver** | Enable screensaver, pick a (different) video, set idle timeout, require password on resume |
| **Performance** | Toggle auto-pause on battery / screen lock / fullscreen |
| **Monitors** | Mirror to all displays or assign per-display videos |
| **Hotkeys** | Record global shortcuts for Pause/Resume, Mute/Unmute, Next wallpaper, Lock Screen Now |
| **General** | Launch at login |
| **About** | Version, platform, GitHub link |

---

## Hotkeys

Click any field in the **Hotkeys** tab, press your key combination, and it is recorded live. Press **Esc** to cancel, **Backspace** to clear.

| Action | Notes |
|---|---|
| Pause / Resume wallpaper | Freezes the last rendered frame — no black screen |
| Mute / Unmute wallpaper | Wallpaper always starts muted; use this to toggle audio |
| Next wallpaper | Playlist feature — coming soon |
| Lock Screen Now | macOS only. Starts the screensaver immediately (password required on resume). **⌘⌃Q is system-reserved** — use a different combo, e.g. `Cmd+Shift+L` |

Shortcuts fire globally even when other apps are focused. Leave a field blank to disable that shortcut. `CommandOrControl` maps to ⌘ on macOS and Ctrl on Windows/Linux.

> **macOS:** global hotkeys require **Accessibility** permission (`System Settings → Privacy & Security → Accessibility`). The app prompts for it automatically on first run.

---

## Auto-mute on screen lock

When the screen locks, the wallpaper audio is automatically silenced. When you unlock, the previous mute state is restored:

- If the wallpaper was **unmuted** before locking → audio **comes back on** after unlock
- If it was already **muted** before locking → it **stays muted** after unlock

This happens independently of the pause-on-lock setting. The wallpaper can be paused and muted at the same time, or just muted while still playing (e.g. on a desktop that stays on while locked behind a different display).

---

## Lock screen wallpaper (macOS 26 Tahoe+)

> Requires macOS 26 (Tahoe) or later and at least one Aerial / animated wallpaper downloaded and **currently set** as active in **System Settings → Wallpaper**.

NotWallpaperEngine replaces the active Aerial slot with your video using the Tahoe injection pipeline described in [AerialWall](https://github.com/CatKinKitKat/AerialWall) and [LivePaper](https://github.com/Raunik2/LivePaper):

1. **Convert** your source video to aerial-spec HEVC `.mov` using VideoToolbox inside the bundled Swift helper (`mac-helper --convert`). The output uses `hvc1` codec, 12 Mbps, and a `mediaTimeScale` of `240 000` — the exact format `WallpaperAerialsExtension` requires to loop seamlessly. Cached by source file hash; re-encoding only runs when the source changes.
2. **Locate** the active `.mov` under `~/Library/Application Support/com.apple.wallpaper/aerials/videos/` (user-writable, no elevation needed).
3. **Atomically replace** that slot with the converted file (same-volume temp-file rename).
4. **Strip all extended attributes** from the replaced file (`xattr -c`) so `WallpaperAgent` cannot find a CDN `SourceURL` to re-download the original aerial over your file.
5. **Update** `aerials/manifest/entries.json` — set the new `fileSize` and `sha256`, and remove all `url-*` CDN keys so `WallpaperAgent` has nothing to re-validate against.
6. **Patch** `Store/Index.plist` — rewrite every `Idle` (lock screen) entry from `com.apple.wallpaper.choice.sequoia` to `com.apple.wallpaper.choice.aerials` pointing at your slot UUID, so the lock screen uses the aerial on every lock, not just the first.
7. **Restart** `WallpaperAgent` and `WallpaperAerialsExtension` so the lock screen picks up the change without a reboot.

Original files are backed up with a `.nwpe_orig` suffix before the first edit (`entries.json` and `Index.plist` are backed up alongside the slot `.mov`). Clicking **Remove** restores all three — fully idempotent.

**Caveats:**
- This uses an undocumented macOS mechanism that can break on any point release (the format already changed Sequoia → Tahoe). If injection fails, the app falls back gracefully.
- Not compatible with Mac App Store sandboxing — direct download only.
- The lock screen slot is always silent (aerial requirement). Desktop wallpaper audio is unaffected.

---

## How it works

### macOS

A bundled Swift CLI binary (`mac-helper`) is spawned by the Electron main process and communicates over newline-delimited JSON on stdin/stdout. It creates one `NSWindow` per connected display at **`kCGDesktopIconWindowLevel − 1`** — above the static desktop picture, below desktop icons — and plays the video via `AVPlayerLayer` with seamless looping (`AVPlayerLooper`). Multi-monitor audio uses a master/secondary model: the display with the lowest `CGDirectDisplayID` is the audio master; all others are always muted.

The same binary handles HEVC conversion for the lock screen when invoked as `mac-helper --convert <input> --output <output>`.

A separate `.saver` bundle (`NotWPESaver.saver`) installed to `~/Library/Screen Savers/` handles the idle screensaver, reading the chosen video path from a shared `UserDefaults` suite (`com.notwallpaperengine.shared`).

### Windows

An Electron `BrowserWindow` is reparented to the `WorkerW` layer (behind desktop icons, above the static wallpaper) using Win32 APIs via `ffi-napi`:

1. `FindWindow("Progman")` → send `0x052C` to spawn `WorkerW`
2. `EnumWindows` to find the `WorkerW` with a `SHELLDLL_DefView` child
3. `SetParent(electronHWND, workerWHWND)`

The screensaver copies a `.scr` file to `%APPDATA%\NotWallpaperEngine\` and registers it via `HKCU\Control Panel\Desktop`. Setting `ScreenSaverIsSecure=1` enables password-on-resume, giving a functional lock screen equivalent.

### Linux (X11)

A `BrowserWindow` has `_NET_WM_WINDOW_TYPE` set to `_NET_WM_WINDOW_TYPE_DESKTOP` via `xprop` after the window is shown. The screensaver writes an `xscreensaver` hack config that calls `mpv --fs --loop`. If `xscreensaver` or `mpv` are missing, the Settings UI displays exact install commands and disables the Save button until they are installed.

> Wayland support is planned for v2 via `wlr-layer-shell`.

---

## Project structure

```
NotWallpaperEngine/
├── .github/
│   └── workflows/
│       └── build-mac.yml          ← CI: builds macOS DMG on every push to master
│
├── main/
│   ├── index.js                   ← App entry: tray, windows, IPC hub, mute-on-lock
│   ├── store.js                   ← Settings persistence (electron-store)
│   ├── hotkeys.js                 ← Global shortcut registration + accessibility check
│   ├── performance-monitor.js     ← Battery / lock / fullscreen pause + lock/unlock callbacks
│   ├── wallpaper-mac.js           ← Spawn mac-helper, manage lifecycle
│   ├── wallpaper-win.js           ← WorkerW injection via ffi-napi
│   ├── wallpaper-linux.js         ← xprop desktop window type
│   ├── wallpaper-extension-mac.js ← Tahoe aerial slot injection (lock screen)
│   ├── screensaver-mac.js         ← Install .saver bundle, write defaults
│   ├── screensaver-win.js         ← Install .scr, write registry
│   ├── screensaver-linux.js       ← Write xscreensaver config; checkPrerequisites()
│   └── preload.js                 ← contextBridge API for settings UI
│
├── renderer/
│   ├── wallpaper.html / .js       ← Fullscreen <video> (Windows + Linux)
│   ├── ui.html / .js / .css       ← Settings window
│   └── wallpaper-preload.js       ← contextBridge API for wallpaper window
│
├── native/
│   ├── mac-helper/                ← Swift package
│   │   └── Sources/main.swift     ←   desktop AVPlayer window + VideoToolbox HEVC encoder
│   └── mac-saver/                 ← Swift .saver bundle (idle screensaver)
│
└── assets/                        ← Tray icons, app icon
```

---

## CI

A GitHub Actions workflow (`.github/workflows/build-mac.yml`) builds a macOS DMG automatically on every push to `master`. The workflow:

1. Installs Node.js dependencies
2. Compiles the Swift `mac-helper` binary
3. Builds the `NotWPESaver.saver` bundle
4. Packages a DMG for both `arm64` and `x64` via `electron-builder`
5. Uploads the `.dmg` files as workflow artifacts (retained 30 days)

Code signing is disabled in CI. For a signed/notarized build, set `CSC_LINK` and `CSC_KEY_PASSWORD` as repository secrets and remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`.

---

## Dependencies

| Package | Purpose |
|---|---|
| `electron` | App shell, BrowserWindow, Tray, powerMonitor, globalShortcut |
| `electron-store` | JSON settings persistence |
| `electron-builder` | Cross-platform packaging |
| `ffi-napi` | Windows Win32 API calls (WorkerW + screensaver registry) |
| `ref-napi` | Pointer types for ffi-napi |
| `winreg` | Windows registry read/write |
| Swift `AVFoundation` | macOS video playback + HEVC conversion |
| Swift `VideoToolbox` | Hardware HEVC encoder for aerial slot injection |
| Swift `ScreenSaver.framework` | macOS `.saver` bundle base class |

---

## License

MIT — use it, fork it, improve it.
