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
		.package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.15.0"),
	],
	targets: [
		.executableTarget(
			name: "NetaDesktop",
			dependencies: ["AgentChatKit", .product(name: "SwiftTerm", package: "SwiftTerm")],
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
