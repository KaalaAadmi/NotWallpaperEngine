// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "mac-helper",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "mac-helper",
            path: "Sources",
            swiftSettings: [
                .unsafeFlags(["-framework", "AVFoundation", "-framework", "Cocoa"])
            ],
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("Cocoa"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo")
            ]
        )
    ]
)
