#!/bin/bash
# build-mac-saver.sh
# Builds the NotWPESaver.saver bundle using xcodebuild.
# Requires Xcode to be installed.

set -e

SAVER_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCES_DIR="$SAVER_DIR/Sources"
BUILD_DIR="$SAVER_DIR/build"
BUNDLE_NAME="NotWPESaver.saver"
CONTENTS_DIR="$BUILD_DIR/$BUNDLE_NAME/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "→ Building $BUNDLE_NAME..."

# Create bundle structure
rm -rf "$BUILD_DIR/$BUNDLE_NAME"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

# Compile Swift sources into a dynamic library named NotWPESaver
# The .saver bundle is just a dylib with a specific Info.plist
swiftc \
  "$SOURCES_DIR/NotWPESaver.swift" \
  -emit-library \
  -module-name NotWPESaver \
  -o "$MACOS_DIR/NotWPESaver" \
  -target arm64-apple-macos13.0 \
  -sdk "$(xcrun --show-sdk-path)" \
  -framework ScreenSaver \
  -framework AVFoundation \
  -framework Cocoa \
  -framework CoreMedia \
  -Xlinker -install_name \
  -Xlinker "@executable_path/../MacOS/NotWPESaver"

# Copy Info.plist into Contents/ (bundle structure)
cp "$SAVER_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"

# Set executable bit
chmod +x "$MACOS_DIR/NotWPESaver"

# Sign the bundle properly — bind Info.plist so macOS accepts it.
# Ad-hoc signing (-) is sufficient for local use without a developer account.
echo "→ Code signing..."
codesign --force --deep --sign - \
  --options runtime \
  --identifier "com.notwallpaperengine.saver" \
  --timestamp=none \
  "$BUILD_DIR/$BUNDLE_NAME"

echo "→ Verifying signature..."
codesign --verify --deep --strict "$BUILD_DIR/$BUNDLE_NAME" && echo "  ✓ Signature valid"

echo "✅ Built: $BUILD_DIR/$BUNDLE_NAME"
echo ""
echo "To install for testing:"
echo "  cp -R \"$BUILD_DIR/$BUNDLE_NAME\" ~/Library/Screen\ Savers/"
