// NotWPEWallpaperExtension.swift
// The principal class for the com.apple.wallpaper AppExtension.
// WallpaperAgent.app (macOS 15+) discovers this extension via ExtensionKit and
// calls makeWallpaper(request:host:) for every destination (desktop + lock screen).
//
// API surface reverse-engineered from WallpaperExtensionKit.tbd (macOS 26 SDK).
//
// Build:  see build-extension.sh
// Install: see install-extension.sh

import Foundation
import ExtensionFoundation
import WallpaperExtensionKit  // private framework — linked via TBD stub

// ---------------------------------------------------------------------------
// MARK: – AppExtensionConfiguration
// ---------------------------------------------------------------------------
// WallpaperExtensionKit provides the configuration via its own XPC channel;
// we just need to satisfy the protocol requirement.  A no-op acceptor is fine
// because WallpaperAgent drives every interaction through the Wallpaper protocol.

@MainActor
final class NotWPEConfiguration: NSObject, AppExtensionConfiguration {
    func accept(connection: NSXPCConnection) -> Bool { false }
}

// ---------------------------------------------------------------------------
// MARK: – WallpaperExtension principal class
// ---------------------------------------------------------------------------

@main
@MainActor
final class NotWPEWallpaperExtension: NSObject, WallpaperExtension {

    // Required by AppExtension
    var configuration: NotWPEConfiguration { NotWPEConfiguration() }
    override required init() { super.init() }

    // -----------------------------------------------------------------------
    // Required by WallpaperExtension
    // WallpaperAgent calls this once per display/space pair.
    // We read the video URL from the descriptor's configuration data (JSON),
    // then use VideoWallpaper — the built-in class — which handles AVPlayer,
    // looping, CALayer delivery, and snapshot support.
    // -----------------------------------------------------------------------
    func makeWallpaper(
        request: WallpaperCreationRequest,
        host: any WallpaperHostProxy
    ) async throws -> any Wallpaper {

        // The configuration data we wrote in the Index.plist is a JSON-encoded
        // VideoWallpaperConfiguration.  Decode it.
        let configData = request.descriptor.configuration
        let videoConfig: VideoWallpaperConfiguration

        if configData.isEmpty {
            // Fallback: no video set yet — return a transparent black layer.
            return try await VideoWallpaper(
                request: request,
                host: host,
                shouldLoop: true
            )
        }

        videoConfig = try VideoWallpaperConfiguration.decode(configData)

        return try await VideoWallpaper(
            request: request,
            host: host,
            configuration: videoConfig,
            shouldLoop: true
        )
    }
}
