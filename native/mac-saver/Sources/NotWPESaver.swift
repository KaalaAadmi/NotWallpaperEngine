import Cocoa
import AVFoundation
import ScreenSaver

// ── Shared defaults domain ────────────────────────────────────────────────────
// Written by the Electron main process via screensaver-mac.js.

private let sharedDomain = "com.notwallpaperengine.shared"

private func readSharedString(_ key: String, fallback: String = "") -> String {
    // Synchronise first so we always get the latest value written by Electron
    UserDefaults(suiteName: sharedDomain)?.synchronize()
    return UserDefaults(suiteName: sharedDomain)?.string(forKey: key) ?? fallback
}

private func readSharedBool(_ key: String, fallback: Bool) -> Bool {
    guard let d = UserDefaults(suiteName: sharedDomain) else { return fallback }
    d.synchronize()
    // Returns false if the key doesn't exist, so we check explicitly
    if d.object(forKey: key) == nil { return fallback }
    return d.bool(forKey: key)
}

private func readSharedDouble(_ key: String, fallback: Double) -> Double {
    guard let d = UserDefaults(suiteName: sharedDomain) else { return fallback }
    d.synchronize()
    if d.object(forKey: key) == nil { return fallback }
    return d.double(forKey: key)
}

// ── NotWPESaverView ───────────────────────────────────────────────────────────

public class NotWPESaverView: ScreenSaverView {

    private var playerLayer: AVPlayerLayer?
    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var _playing = false

    // Required by ScreenSaver.framework
    public override init?(frame: NSRect, isPreview: Bool) {
        super.init(frame: frame, isPreview: isPreview)
        self.wantsLayer = true
        self.layer?.backgroundColor = NSColor.black.cgColor
        setupPlayer(isPreview: isPreview)
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        self.wantsLayer = true
        self.layer?.backgroundColor = NSColor.black.cgColor
        setupPlayer(isPreview: false)
    }

    private func setupPlayer(isPreview: Bool) {
        let videoPath = readSharedString("videoPath")
        guard !videoPath.isEmpty else { return }

        let url: URL
        if videoPath.hasPrefix("file://") {
            guard let u = URL(string: videoPath) else { return }
            url = u
        } else {
            url = URL(fileURLWithPath: videoPath)
        }

        // Audio:
        // - In preview (small thumbnail in System Settings), always mute.
        // - On lock screen / full screensaver: respect the user setting.
        //   Default is muted=true so the lock screen is silent unless the user
        //   explicitly unchecks "Mute on lock screen" in NotWallpaperEngine.
        let shouldMute: Bool
        if isPreview {
            shouldMute = true
        } else {
            shouldMute = readSharedBool("screensaverMuted", fallback: true)
        }
        let volume = readSharedDouble("screensaverVolume", fallback: 0.5)

        let fitMode = readSharedString("fitMode", fallback: "cover")

        let asset = AVURLAsset(url: url)
        let templateItem = AVPlayerItem(asset: asset)
        let queuePlayer = AVQueuePlayer()
        queuePlayer.isMuted = shouldMute
        queuePlayer.volume = Float(volume)

        let looper = AVPlayerLooper(player: queuePlayer, templateItem: templateItem)
        self.looper = looper

        let layer = AVPlayerLayer(player: queuePlayer)
        layer.frame = self.bounds
        layer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]

        switch fitMode {
        case "contain":
            layer.videoGravity = .resizeAspect
        case "stretch":
            layer.videoGravity = .resize
        default:
            layer.videoGravity = .resizeAspectFill
        }

        self.layer?.addSublayer(layer)
        self.playerLayer = layer
        self.player = queuePlayer
    }

    public override func startAnimation() {
        super.startAnimation()
        player?.play()
        _playing = true
    }

    public override func stopAnimation() {
        super.stopAnimation()
        player?.pause()
        _playing = false
    }

    // AVPlayer drives its own frame updates via the CALayer — no manual drawing needed.
    public override func animateOneFrame() {}

    public override var hasConfigureSheet: Bool { return false }
    public override var configureSheet: NSWindow? { return nil }

    public override func layout() {
        super.layout()
        playerLayer?.frame = self.bounds
    }
}
