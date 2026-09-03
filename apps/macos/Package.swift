// swift-tools-version: 6.2
import PackageDescription

let package = Package(
	name: "NetaDesktop",
	platforms: [.macOS(.v26)],
	products: [
		.executable(name: "NetaDesktop", targets: ["NetaDesktop"]),
	],
	targets: [
		.executableTarget(name: "NetaDesktop", path: "Sources/NetaDesktop"),
		.testTarget(
			name: "NetaDesktopTests",
			dependencies: ["NetaDesktop"],
			path: "Tests/NetaDesktopTests",
		),
	],
	swiftLanguageModes: [.v6],
)
