#!/usr/bin/env node
// activate-wallpaper.js
// Writes a VideoWallpaper choice into the WallpaperAgent store Index.plist.
//
// Usage: node activate-wallpaper.js /absolute/path/to/video.mp4
//
// How it works:
//   1. Reads ~/Library/Application Support/com.apple.wallpaper/Store/Index.plist
//   2. Replaces (or inserts) a Choice entry in AllSpacesAndDisplays.Linked.Content.Choices
//      with Provider = "com.notwallpaperengine.wallpaper-extension"
//      and Configuration = bplist-encoded VideoWallpaperConfiguration({ videos: [{ url }] })
//   3. Writes the file back and signals WallpaperAgent
//
// The VideoWallpaperConfiguration binary plist format:
//   It is a Codable struct with one key "videos" — array of Video structs.
//   Each Video struct has "url" (string) and optional "variants" (array).
//   We encode this manually since we cannot link WallpaperExtensionKit from Node.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os   = require('os');

const videoArg = process.argv[2];
if (!videoArg) {
  console.error('Usage: node activate-wallpaper.js /path/to/video.mp4');
  process.exit(1);
}

const videoPath = path.resolve(videoArg);
if (!fs.existsSync(videoPath)) {
  console.error(`Video file not found: ${videoPath}`);
  process.exit(1);
}

const INDEX_PLIST = path.join(
  os.homedir(),
  'Library/Application Support/com.apple.wallpaper/Store/Index.plist'
);

// ---------------------------------------------------------------------------
// Build VideoWallpaperConfiguration as a JSON-encoded Data payload.
// WallpaperExtensionKit.VideoWallpaperConfiguration.decode() accepts plist
// OR JSON (it's a Codable struct).  We use JSON for simplicity.
// ---------------------------------------------------------------------------
const videoConfig = {
  videos: [
    { url: `file://${videoPath}` }
  ]
};
const configJSON = JSON.stringify(videoConfig);

// Build the new Choice dict (as a JS object for plistlib-style manipulation)
const newChoice = {
  Configuration: Buffer.from(configJSON, 'utf8'),
  Files: [`file://${videoPath}`],
  Provider: 'com.notwallpaperengine.wallpaper-extension',
};

// ---------------------------------------------------------------------------
// Read the existing Index.plist using plutil -convert json
// ---------------------------------------------------------------------------
let indexObj;
try {
  const jsonStr = execSync(
    `plutil -convert json -o - "${INDEX_PLIST}"`,
    { encoding: 'utf8' }
  );
  indexObj = JSON.parse(jsonStr);
} catch (e) {
  // Store may not exist yet; create minimal structure
  indexObj = {
    AllSpacesAndDisplays: {
      Linked: {
        Content: { Choices: [], Shuffle: null },
        LastSet: new Date().toISOString(),
        LastUse: new Date().toISOString(),
      },
      Type: 'linked',
    },
    Displays: {},
    Spaces: {},
    SystemDefault: {
      Linked: {
        Content: { Choices: [], Shuffle: null },
        LastSet: new Date().toISOString(),
        LastUse: new Date().toISOString(),
      },
      Type: 'linked',
    },
  };
}

// ---------------------------------------------------------------------------
// Patch: replace/insert our choice in AllSpacesAndDisplays and SystemDefault
// ---------------------------------------------------------------------------
const OUR_PROVIDER = 'com.notwallpaperengine.wallpaper-extension';

function patchSpace(spaceObj) {
  if (!spaceObj) return;
  const linked = spaceObj.Linked || (spaceObj.Linked = {});
  const content = linked.Content || (linked.Content = { Choices: [] });
  const choices = content.Choices || (content.Choices = []);

  // Remove any existing entry for our provider
  const filtered = choices.filter(c => c.Provider !== OUR_PROVIDER);

  // Build the binary plist data for Configuration using plutil
  // We write temp JSON and convert it to binary plist
  const tmpJson = path.join(os.tmpdir(), 'nwpe_config.json');
  fs.writeFileSync(tmpJson, configJSON, 'utf8');
  const tmpBplist = path.join(os.tmpdir(), 'nwpe_config.bplist');
  execSync(`plutil -convert binary1 -o "${tmpBplist}" "${tmpJson}"`);
  const configData = fs.readFileSync(tmpBplist);

  filtered.unshift({
    Configuration: configData,
    Files: [`file://${videoPath}`],
    Provider: OUR_PROVIDER,
  });
  content.Choices = filtered;
  linked.LastSet = new Date().toISOString();
  linked.LastUse = new Date().toISOString();
  spaceObj.Type = 'linked';
}

patchSpace(indexObj.AllSpacesAndDisplays);
patchSpace(indexObj.SystemDefault);

// ---------------------------------------------------------------------------
// Write patched JSON back, then convert to binary plist
// ---------------------------------------------------------------------------
// We use a Python helper because plutil round-trip through JSON loses Data keys.
// Instead: write as XML plist using PlistBuddy or Swift.
// Simplest approach: use swift -e to write via PropertyListSerialization.

const tmpPatched = path.join(os.tmpdir(), 'nwpe_index_patch.json');
fs.writeFileSync(tmpPatched, JSON.stringify(indexObj), 'utf8');

// Use a tiny Swift one-liner to merge our choice into the live plist
// This preserves the NSData binary fields correctly.
const swiftScript = `
import Foundation

let indexURL = URL(fileURLWithPath: "${INDEX_PLIST}")
let videoURL = URL(fileURLWithPath: "${videoPath}")

// Read existing plist
guard let data = try? Data(contentsOf: indexURL),
      var root = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
else {
  // Create fresh structure
  var root = [String: Any]()
  for key in ["AllSpacesAndDisplays", "SystemDefault"] {
    root[key] = [
      "Type": "linked",
      "Linked": [
        "Content": ["Choices": [[String:Any]](), "Shuffle": NSNull()],
        "LastSet": Date(),
        "LastUse": Date()
      ]
    ]
  }
  // Fall through with root
  writeRoot(root)
  exit(0)
}

func makeChoice() -> [String: Any] {
  // Encode VideoWallpaperConfiguration as JSON data
  let cfg: [String: Any] = ["videos": [["url": videoURL.absoluteString]]]
  let cfgData = try! JSONSerialization.data(withJSONObject: cfg)
  return [
    "Configuration": cfgData,
    "Files": [videoURL.absoluteString],
    "Provider": "com.notwallpaperengine.wallpaper-extension"
  ]
}

func patchSpace(_ spaceKey: String, in root: inout [String: Any]) {
  var space = root[spaceKey] as? [String: Any] ?? [:]
  var linked = space["Linked"] as? [String: Any] ?? [:]
  var content = linked["Content"] as? [String: Any] ?? [:]
  var choices = content["Choices"] as? [[String: Any]] ?? []
  
  // Remove existing NWE choice
  choices.removeAll { ($0["Provider"] as? String) == "com.notwallpaperengine.wallpaper-extension" }
  // Insert at front
  choices.insert(makeChoice(), at: 0)
  
  content["Choices"] = choices
  content["Shuffle"] = NSNull()
  linked["Content"] = content
  linked["LastSet"] = Date()
  linked["LastUse"] = Date()
  space["Linked"] = linked
  space["Type"] = "linked"
  root[spaceKey] = space
}

patchSpace("AllSpacesAndDisplays", in: &root)
patchSpace("SystemDefault", in: &root)

func writeRoot(_ r: [String: Any]) {
  let out = try! PropertyListSerialization.data(fromPropertyList: r, format: .binary, options: 0)
  // Ensure directory exists
  let dir = indexURL.deletingLastPathComponent()
  try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  try! out.write(to: indexURL)
}
writeRoot(root)
print("Index.plist updated successfully.")
`;

const tmpSwift = path.join(os.tmpdir(), 'nwpe_patch_index.swift');
fs.writeFileSync(tmpSwift, swiftScript, 'utf8');

try {
  const out = execSync(`swift "${tmpSwift}"`, { encoding: 'utf8' });
  console.log(out.trim());
} catch (e) {
  console.error('Failed to patch Index.plist:', e.message);
  process.exit(1);
}

console.log(`==> Wallpaper choice registered for: ${videoPath}`);
console.log('==> Run: killall WallpaperAgent  (or reboot) to apply.');
