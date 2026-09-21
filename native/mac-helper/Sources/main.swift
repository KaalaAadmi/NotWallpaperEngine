import Cocoa
import AVFoundation
import VideoToolbox
import Foundation

// ── Conversion mode ───────────────────────────────────────────────────────────
//
// When invoked as:
//   mac-helper --convert <inputPath> --output <outputPath>
//
// the helper encodes the source video to aerial-spec HEVC .mov using
// VideoToolbox (AVAssetWriter + AVAssetReader pipeline).  The output is a
// .mov container with an hvc1-tagged HEVC track encoded with the 2-layer
// temporal hierarchy that WallpaperAerialsExtension requires.
//
// Audio is always stripped — lock screen and desktop wallpaper are silent
// (PRD §3 Non-Goals: No audio).
//
// Exit 0 = success, non-zero = failure (error text on stderr).

// ── Argument parsing ──────────────────────────────────────────────────────────

var convertInputPath: String? = nil
var convertOutputPath: String? = nil
var initialVideoPath = ""
var initialFitMode = "cover"
var initialSpeed = 1.0

let args = CommandLine.arguments
var i = 1
while i < args.count {
    switch args[i] {
    case "--convert":
        i += 1; if i < args.count { convertInputPath = args[i] }
    case "--output":
        i += 1; if i < args.count { convertOutputPath = args[i] }
    case "--video":
        i += 1; if i < args.count { initialVideoPath = args[i] }
    case "--fit":
        i += 1; if i < args.count { initialFitMode = args[i] }
    case "--speed":
        i += 1; if i < args.count { initialSpeed = Double(args[i]) ?? 1.0 }
    case "--muted", "--volume":
        i += 1  // audio always disabled (PRD §3: No audio) — consume and ignore
    default: break
    }
    i += 1
}

// ── HEVC conversion (--convert mode) ─────────────────────────────────────────

if let inputPath = convertInputPath, let outputPath = convertOutputPath {
    // Run conversion synchronously and exit
    let exitCode = convertToAerialHEVC(inputPath: inputPath, outputPath: outputPath)
    exit(exitCode)
}

// ── JSON message types (wallpaper window mode) ────────────────────────────────

struct IncomingMessage: Decodable {
    let type: String
    // set-video / set-display-video
    let videoPath: String?
    let displayId: Int?      // CGDirectDisplayID for set-display-video
    let fitMode: String?
    let speed: Double?
    let muted: Bool?
    let volume: Double?
}

struct OutgoingMessage: Encodable {
    let type: String
    let message: String?
    let displayId: Int?
    init(type: String, message: String? = nil, displayId: Int? = nil) {
        self.type = type
        self.message = message
        self.displayId = displayId
    }
}

func send(_ msg: OutgoingMessage) {
    if let data = try? JSONEncoder().encode(msg),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}

// ── App delegate ──────────────────────────────────────────────────────────────

class AppDelegate: NSObject, NSApplicationDelegate {
    // One WallpaperWindow per NSScreen, keyed by CGDirectDisplayID
    var windows: [UInt32: WallpaperWindow] = [:]

    // Per-display video overrides sent from Electron.
    var perDisplayVideo: [UInt32: String] = [:]

    // Global mute state — toggled via "set-muted" command
    var isMuted = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        rebuildWindows()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screensDidChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )

        startStdinListener()
        send(OutgoingMessage(type: "ready", message: "mac-helper running"))
    }

    // ── Display management ────────────────────────────────────────────────────

    @objc func screensDidChange() {
        let currentDisplayIDs = Set(NSScreen.screens.map { displayID(for: $0) })

        // Remove windows for gone displays
        for (did, win) in windows where !currentDisplayIDs.contains(did) {
            win.close()
            windows.removeValue(forKey: did)
            send(OutgoingMessage(type: "display-removed", displayId: Int(did)))
        }

        // Create windows for newly-connected displays
        for screen in NSScreen.screens {
            let did = displayID(for: screen)
            if windows[did] == nil {
                let win = WallpaperWindow(screen: screen)
                windows[did] = win

                let videoPath = perDisplayVideo[did] ?? initialVideoPath
                if !videoPath.isEmpty {
                    win.play(videoPath: videoPath, fitMode: initialFitMode, speed: initialSpeed)
                }
                send(OutgoingMessage(type: "display-added", displayId: Int(did)))
            }
        }
    }

    func rebuildWindows() {
        for (_, win) in windows { win.close() }
        windows.removeAll()
        for screen in NSScreen.screens {
            let did = displayID(for: screen)
            let win = WallpaperWindow(screen: screen)
            windows[did] = win
        }
        if !initialVideoPath.isEmpty { playAll() }
    }

    // ── Video helpers ─────────────────────────────────────────────────────────

    func videoPath(for displayID: UInt32) -> String {
        return perDisplayVideo[displayID] ?? initialVideoPath
    }

    func playAll() {
        for (did, win) in windows {
            let vp = videoPath(for: did)
            if !vp.isEmpty {
                win.play(videoPath: vp, fitMode: initialFitMode, speed: initialSpeed, muted: isMuted)
            }
        }
    }

    // ── Command handler ───────────────────────────────────────────────────────

    func handleCommand(_ msg: IncomingMessage) {
        switch msg.type {

        case "set-video":
            let vp = msg.videoPath ?? initialVideoPath
            initialVideoPath = vp
            if let fm = msg.fitMode { initialFitMode = fm }
            if let sp = msg.speed   { initialSpeed = sp }
            if let m  = msg.muted   { isMuted = m }
            perDisplayVideo.removeAll()
            for (_, win) in windows {
                win.play(videoPath: vp, fitMode: initialFitMode, speed: initialSpeed, muted: isMuted)
            }

        case "set-display-video":
            guard let vp = msg.videoPath, let rawID = msg.displayId else { break }
            let did = UInt32(rawID)
            if vp.isEmpty {
                perDisplayVideo.removeValue(forKey: did)
            } else {
                perDisplayVideo[did] = vp
            }
            if let fm = msg.fitMode { initialFitMode = fm }
            if let sp = msg.speed   { initialSpeed = sp }
            if let win = windows[did] {
                win.play(videoPath: vp, fitMode: initialFitMode, speed: initialSpeed, muted: isMuted)
            }

        case "set-muted":
            if let m = msg.muted { isMuted = m }
            for (_, win) in windows { win.setMuted(isMuted) }

        case "pause":
            for (_, win) in windows { win.pause() }

        case "resume":
            for (_, win) in windows { win.resume() }

        case "quit":
            NSApp.terminate(nil)

        default:
            break
        }
    }

    // ── Stdin listener ────────────────────────────────────────────────────────

    func startStdinListener() {
        DispatchQueue.global(qos: .background).async {
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let msg = try? JSONDecoder().decode(IncomingMessage.self, from: data)
                else { continue }
                DispatchQueue.main.async { self.handleCommand(msg) }
            }
            // stdin closed — Electron quit
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

// ── CGDirectDisplayID helper ──────────────────────────────────────────────────

func displayID(for screen: NSScreen) -> UInt32 {
    return (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
}

// ── WallpaperWindow ───────────────────────────────────────────────────────────

class WallpaperWindow: NSWindow {
    private var playerLayer: AVPlayerLayer?
    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?

    init(screen: NSScreen) {
        super.init(
            contentRect: screen.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        // PRD §6.1 / §7.2: window must sit above the static desktop picture
        // but below desktop icons. kCGDesktopIconWindowLevel - 1 is exactly
        // that slot. (kCGDesktopWindowLevel - 1 is below the picture level
        // and would be occluded by it — do NOT use it.)
        self.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) - 1)
        self.isOpaque = false
        self.backgroundColor = .black
        self.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        self.ignoresMouseEvents = true

        let contentView = NSView(frame: screen.frame)
        contentView.wantsLayer = true
        self.contentView = contentView

        let layer = AVPlayerLayer()
        layer.frame = contentView.bounds
        layer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        contentView.layer?.addSublayer(layer)
        self.playerLayer = layer

        self.makeKeyAndOrderFront(nil)
    }

    func play(videoPath: String, fitMode: String, speed: Double, muted: Bool = false) {
        guard !videoPath.isEmpty else { return }

        let url: URL = videoPath.hasPrefix("file://")
            ? URL(string: videoPath)!
            : URL(fileURLWithPath: videoPath)

        let item = AVPlayerItem(asset: AVAsset(url: url))

        if let existing = player {
            // Tear down the looper BEFORE touching the player queue.
            // Creating AVPlayerLooper while the old templateItem is still in the
            // queue causes "An AVPlayerItem can occupy only one position in a
            // player's queue at a time" → NSInvalidArgumentException crash.
            looper = nil
            existing.removeAllItems()
            existing.replaceCurrentItem(with: item)
            looper = AVPlayerLooper(player: existing, templateItem: item)
        } else {
            let qp = AVQueuePlayer(playerItem: item)
            looper = AVPlayerLooper(player: qp, templateItem: item)
            playerLayer?.player = qp
            player = qp
        }

        player?.isMuted = muted
        player?.rate = Float(speed)
        player?.play()

        switch fitMode {
        case "contain": playerLayer?.videoGravity = .resizeAspect
        case "stretch": playerLayer?.videoGravity = .resize
        default:        playerLayer?.videoGravity = .resizeAspectFill
        }
    }

    func setMuted(_ muted: Bool) { player?.isMuted = muted }
    func pause()  { player?.pause() }
    func resume() { player?.play() }
}

// ── Entry point (wallpaper window mode) ───────────────────────────────────────

let delegate = AppDelegate()
let nsApp = NSApplication.shared
nsApp.delegate = delegate
nsApp.run()

// ── HEVC conversion implementation ───────────────────────────────────────────
//
// Encodes the source video to aerial-spec HEVC .mov using AVAssetWriter +
// VideoToolbox.  The output uses hvc1 box type and the VideoToolbox default
// encoding profile, which produces the 2-layer temporal hierarchy that
// WallpaperAerialsExtension requires.
//
// Audio is always omitted (lock screen playback is always silent).
//
// Returns 0 on success, 1 on failure.

func convertToAerialHEVC(inputPath: String, outputPath: String) -> Int32 {
    let inputURL = URL(fileURLWithPath: inputPath)
    let outputURL = URL(fileURLWithPath: outputPath)

    // Remove existing output file if present
    if FileManager.default.fileExists(atPath: outputPath) {
        try? FileManager.default.removeItem(at: outputURL)
    }

    let asset = AVAsset(url: inputURL)

    // Check VideoToolbox HEVC availability
    var vtSupported: Bool = false
    if #available(macOS 10.13, *) {
        vtSupported = VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC)
    }
    // We use AVAssetWriter which internally uses VideoToolbox; if unavailable
    // the encode still works via software but aerial path may reject it.
    // Report a warning but continue.
    if !vtSupported {
        fputs("[mac-helper] WARNING: VideoToolbox HEVC hardware not available; encode may be rejected by aerial path\n", stderr)
    }

    // Fetch video track
    guard let videoTrack = asset.tracks(withMediaType: .video).first else {
        fputs("[mac-helper] No video track found in: \(inputPath)\n", stderr)
        return 1
    }

    let naturalSize = videoTrack.naturalSize.applying(videoTrack.preferredTransform)
    let width  = Int(abs(naturalSize.width))
    let height = Int(abs(naturalSize.height))

    // Derive the source frame rate — used for key-frame interval
    let srcFPS = videoTrack.nominalFrameRate > 0 ? videoTrack.nominalFrameRate : 30.0

    // Build video output settings for HEVC hvc1.
    //
    // WallpaperAerialsExtension requires the media-clock timescale to be
    // 240 000 (matching Apple's own 240-fps aerial clock).  Any other value
    // causes the system player to treat the clip as a non-looping still after
    // the first pass.  We force this via AVAssetWriterInput.mediaTimeScale.
    //
    // Key-frame interval: match source frame rate so every GOP is exactly 1 s
    // (standard for streaming aerials; a very large interval causes stuttering
    // on loop boundary since the player has to seek back to the previous IDR).
    let videoCompressionProps: [String: Any] = [
        AVVideoAverageBitRateKey:          12_000_000,  // 12 Mbps — aerial-spec rate
        AVVideoExpectedSourceFrameRateKey: srcFPS,
        AVVideoMaxKeyFrameIntervalKey:     Int(srcFPS), // 1 keyframe per second
        AVVideoAllowFrameReorderingKey:    true,
    ]
    let videoOutputSettings: [String: Any] = [
        AVVideoCodecKey:                   AVVideoCodecType.hevc,
        AVVideoWidthKey:                   width,
        AVVideoHeightKey:                  height,
        AVVideoCompressionPropertiesKey:   videoCompressionProps,
    ]

    // Create writer
    guard let writer = try? AVAssetWriter(outputURL: outputURL, fileType: .mov) else {
        fputs("[mac-helper] Could not create AVAssetWriter for: \(outputPath)\n", stderr)
        return 1
    }

    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoOutputSettings)
    videoInput.expectsMediaDataInRealTime = false
    // Force the media-clock timescale to 240 000.
    // Apple's aerials all use this timescale; WallpaperAerialsExtension
    // validates it and refuses to loop clips that use a lower-precision clock.
    videoInput.mediaTimeScale = 240_000
    // Preserve the source video transform (rotation metadata)
    videoInput.transform = videoTrack.preferredTransform

    guard writer.canAdd(videoInput) else {
        fputs("[mac-helper] Cannot add video input to writer\n", stderr)
        return 1
    }
    writer.add(videoInput)

    // Reader
    guard let reader = try? AVAssetReader(asset: asset) else {
        fputs("[mac-helper] Could not create AVAssetReader\n", stderr)
        return 1
    }

    let videoReaderSettings: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ]
    let videoReaderOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: videoReaderSettings)
    videoReaderOutput.alwaysCopiesSampleData = false

    guard reader.canAdd(videoReaderOutput) else {
        fputs("[mac-helper] Cannot add video output to reader\n", stderr)
        return 1
    }
    reader.add(videoReaderOutput)

    // Run
    writer.startWriting()
    reader.startReading()
    writer.startSession(atSourceTime: .zero)

    let encodeGroup = DispatchGroup()
    encodeGroup.enter()

    videoInput.requestMediaDataWhenReady(on: DispatchQueue(label: "com.notwallpaperengine.encode")) {
        while videoInput.isReadyForMoreMediaData {
            if let sample = videoReaderOutput.copyNextSampleBuffer() {
                videoInput.append(sample)
            } else {
                videoInput.markAsFinished()
                encodeGroup.leave()
                break
            }
        }
    }

    encodeGroup.wait()

    var encodeError: Error? = nil
    let finishGroup = DispatchGroup()
    finishGroup.enter()
    writer.finishWriting {
        encodeError = writer.error
        finishGroup.leave()
    }
    finishGroup.wait()

    if let err = encodeError {
        fputs("[mac-helper] Encode failed: \(err.localizedDescription)\n", stderr)
        return 1
    }
    if reader.status == .failed, let err = reader.error {
        fputs("[mac-helper] Reader failed: \(err.localizedDescription)\n", stderr)
        return 1
    }

    fputs("[mac-helper] HEVC conversion complete: \(outputPath)\n", stderr)
    return 0
}
