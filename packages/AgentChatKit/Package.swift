// swift-tools-version: 6.2
import PackageDescription

let package = Package(
	name: "AgentChatKit",
	platforms: [.macOS(.v26)],
	products: [.library(name: "AgentChatKit", targets: ["AgentChatKit"])],
	targets: [
		.target(name: "AgentChatKit"),
		.testTarget(name: "AgentChatKitTests", dependencies: ["AgentChatKit"]),
	],
	swiftLanguageModes: [.v6]
)
