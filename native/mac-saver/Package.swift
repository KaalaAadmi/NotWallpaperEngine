// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NotWPESaver",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "NotWPESaver",
            type: .dynamic,
            targets: ["NotWPESaver"]
        )
    ],
    targets: [
        .target(
            name: "NotWPESaver",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("Cocoa"),
                .linkedFramework("ScreenSaver"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo")
            ]
        )
    ]
)
