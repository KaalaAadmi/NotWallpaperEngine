#!/bin/bash
# build-extension.sh — build & install the com.apple.wallpaper extension
# Usage: ./build-extension.sh [/path/to/video.mp4]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APPEX="$BUILD_DIR/NotWPEWallpaper.appex"
CONTENTS="$APPEX/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

SDK=$(xcrun --show-sdk-path)
FWPATH="$SDK/System/Library/PrivateFrameworks"

echo "==> Building NotWPEWallpaper.appex"
mkdir -p "$MACOS" "$RESOURCES"
# Copy handcrafted swiftinterface into build/ so the compiler finds WallpaperExtensionKit
mkdir -p "$BUILD_DIR/WallpaperExtensionKit.swiftmodule"
cp "$SCRIPT_DIR/WallpaperExtensionKit.swiftmodule/arm64-apple-macos.swiftinterface" \
   "$BUILD_DIR/WallpaperExtensionKit.swiftmodule/"

# Compile Swift extension linking against private WallpaperExtensionKit
xcrun swiftc \
    -target arm64-apple-macos15.0 \
    -sdk "$SDK" \
    -F "$FWPATH" \
    -framework WallpaperExtensionKit \
    -framework ExtensionFoundation \
    -framework Foundation \
    -I "$BUILD_DIR" \
    -parse-as-library \
    -module-name NotWPEWallpaperExtension \
    "$SCRIPT_DIR/Sources/NotWPEWallpaperExtension.swift" \
    -o "$MACOS/NotWPEWallpaperExtension"

# Copy Info.plist
cp "$SCRIPT_DIR/Info.plist" "$CONTENTS/Info.plist"

# Ad-hoc code sign (local use — no Apple Developer account needed)
codesign --force --sign - \
    --options runtime \
    --entitlements "$SCRIPT_DIR/entitlements.plist" \
    "$APPEX"

echo "==> Built: $APPEX"
echo ""
echo "==> Installing..."
bash "$SCRIPT_DIR/install-extension.sh" "${1:-}"
