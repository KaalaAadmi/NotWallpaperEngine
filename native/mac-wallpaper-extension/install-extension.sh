#!/bin/bash
# install-extension.sh — install the .appex and register a wallpaper choice
# Usage: ./install-extension.sh [/path/to/video.mp4]
#
# What this does:
#   1. Copies NotWPEWallpaper.appex into ~/Library/Application Support/com.notwallpaperengine/Extensions/
#   2. Writes a VideoWallpaperConfiguration plist into the wallpaper Store Index
#   3. Tells WallpaperAgent to reload via `killall WallpaperAgent`
#
# The Index.plist format was reverse-engineered from the live store at:
#   ~/Library/Application Support/com.apple.wallpaper/Store/Index.plist
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPEX="$SCRIPT_DIR/build/NotWPEWallpaper.appex"
VIDEO_PATH="${1:-}"

# ── 1. Install .appex ───────────────────────────────────────────────────────
INSTALL_DIR="$HOME/Library/Application Support/com.notwallpaperengine/Extensions"
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/NotWPEWallpaper.appex"
cp -R "$APPEX" "$INSTALL_DIR/NotWPEWallpaper.appex"
echo "==> Installed: $INSTALL_DIR/NotWPEWallpaper.appex"

# ── 2. Register ExtensionKit (so WallpaperAgent can discover it) ─────────────
# pluginkit -a registers the bundle with the system extension database
pluginkit -a "$INSTALL_DIR/NotWPEWallpaper.appex" 2>/dev/null || true
echo "==> Registered with pluginkit"

# ── 3. Write Index.plist choice ─────────────────────────────────────────────
if [ -z "$VIDEO_PATH" ]; then
    echo "==> No video path provided; skipping Index.plist update."
    echo "    Run: node activate-wallpaper.js /path/to/video.mp4  to activate later."
else
    # Delegate to the Node.js activator which builds the correct binary plist
    node "$SCRIPT_DIR/activate-wallpaper.js" "$VIDEO_PATH"
fi

# ── 4. Restart WallpaperAgent ────────────────────────────────────────────────
echo "==> Restarting WallpaperAgent..."
killall WallpaperAgent 2>/dev/null || true
sleep 1
# macOS will auto-relaunch WallpaperAgent via launchd
echo "==> Done. WallpaperAgent will reload and pick up the new extension."
