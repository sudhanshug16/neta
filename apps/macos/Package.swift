// swift-tools-version: 6.2
import PackageDescription

let package = Package(
	name: "NetaDesktop",
	platforms: [.macOS(.v26)],
	products: [
		.executable(name: "NetaDesktop", targets: ["NetaDesktop"]),
	],
	dependencies: [
		.package(path: "../../packages/AgentChatKit"),
	],
	targets: [
		.executableTarget(
			name: "NetaDesktop",
			dependencies: ["AgentChatKit"],
			path: "Sources/NetaDesktop"
		),
		.testTarget(
			name: "NetaDesktopTests",
			dependencies: ["NetaDesktop"],
			path: "Tests/NetaDesktopTests",
		),
	],
	swiftLanguageModes: [.v6],
)
