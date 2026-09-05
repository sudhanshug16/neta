import XCTest
@testable import NetaDesktop

final class ThemeTests: XCTestCase {
	func testNativeGlassIsCentralizedInTheme() throws {
		let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
		let glass = try String(contentsOf: root.appendingPathComponent("Sources/NetaDesktop/Theme/Glass.swift"), encoding: .utf8)
		XCTAssertTrue(glass.contains("glassEffect"))
		XCTAssertFalse(glass.contains("strokeBorder"))
		XCTAssertFalse(glass.contains("specularBody"))
	}
	func testShapesKeepSurfaceSemantics() {
		XCTAssertTrue(GlassShape.panel.floats)
		XCTAssertTrue(GlassShape.capsule.floats)
		XCTAssertFalse(GlassShape.rounded(10).floats)
	}
}
