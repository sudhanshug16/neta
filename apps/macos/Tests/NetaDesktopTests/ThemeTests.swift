import Foundation
import SwiftUI
import XCTest

@testable import NetaDesktop

final class ThemeTests: XCTestCase {
	private let tolerance = 1.0 / 255.0

	private func resolved(_ color: Color) -> Color.Resolved {
		color.resolve(in: EnvironmentValues())
	}

	/// sRGB byte value linearized, matching `Color.Resolved` channels.
	private func linear(_ byte: Double) -> Double {
		let c = byte / 255.0
		return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
	}

	private func assertHex(
		_ color: Color, _ r: Double, _ g: Double, _ b: Double,
		file: StaticString = #filePath, line: UInt = #line
	) {
		let c = resolved(color)
		XCTAssertEqual(Double(c.linearRed), linear(r), accuracy: tolerance, "red", file: file, line: line)
		XCTAssertEqual(Double(c.linearGreen), linear(g), accuracy: tolerance, "green", file: file, line: line)
		XCTAssertEqual(Double(c.linearBlue), linear(b), accuracy: tolerance, "blue", file: file, line: line)
		XCTAssertEqual(Double(c.opacity), 1, accuracy: tolerance, "opacity", file: file, line: line)
	}

	func testBriefHexesRoundTrip() {
		assertHex(Theme.ground, 14, 15, 19)
		assertHex(Theme.violet, 153, 133, 245)
		assertHex(Theme.mint, 115, 209, 184)
		assertHex(Theme.blue, 138, 179, 255)
		assertHex(Theme.amber, 245, 173, 71)
		assertHex(Theme.green, 125, 217, 140)
		assertHex(Theme.red, 255, 97, 97)
	}

	func testAgentHuesCountAndOrder() {
		XCTAssertEqual(Theme.agentHues.count, 6)
		let expected: [(Double, Double, Double)] = [
			(82, 179, 242), (242, 135, 117), (199, 163, 79),
			(112, 204, 153), (227, 155, 199), (127, 200, 217),
		]
		for (hue, rgb) in zip(Theme.agentHues, expected) {
			assertHex(hue, rgb.0, rgb.1, rgb.2)
		}
	}

	func testTextTones() {
		let primary = resolved(Theme.textPrimary)
		XCTAssertEqual(Double(primary.linearRed), 1, accuracy: tolerance)
		XCTAssertEqual(Double(primary.linearGreen), 1, accuracy: tolerance)
		XCTAssertEqual(Double(primary.linearBlue), 1, accuracy: tolerance)
		XCTAssertEqual(Double(primary.opacity), 0.96, accuracy: tolerance)
		let secondary = resolved(Theme.textSecondary)
		XCTAssertEqual(Double(secondary.linearRed), 1, accuracy: tolerance)
		XCTAssertEqual(Double(secondary.linearGreen), 1, accuracy: tolerance)
		XCTAssertEqual(Double(secondary.linearBlue), 1, accuracy: tolerance)
		XCTAssertEqual(Double(secondary.opacity), 0.64, accuracy: tolerance)
	}

	func testNodeAndSurfaceTones() {
		let fill = resolved(Theme.nodeFill)
		XCTAssertEqual(Double(fill.linearRed), linear(20), accuracy: tolerance)
		XCTAssertEqual(Double(fill.linearGreen), linear(23), accuracy: tolerance)
		XCTAssertEqual(Double(fill.linearBlue), linear(25), accuracy: tolerance)
		XCTAssertEqual(Double(fill.opacity), 0.96, accuracy: tolerance)
		XCTAssertEqual(Double(resolved(Theme.nodeBorder).opacity), 0.10, accuracy: tolerance)
		XCTAssertEqual(Double(resolved(Theme.divider).opacity), 0.06, accuracy: tolerance)
		XCTAssertEqual(Double(resolved(Theme.subtleSurface).opacity), 0.045, accuracy: tolerance)
	}

	func testMetricValues() {
		XCTAssertEqual(Theme.Metric.panelRadius, 22)
		XCTAssertEqual(Theme.Metric.barRadius, 26)
		XCTAssertEqual(Theme.Metric.edgeInset, 16)
		XCTAssertEqual(Theme.Metric.navigatorInset, 12)
		XCTAssertEqual(Theme.Metric.chatWidth, 410)
		XCTAssertEqual(Theme.Metric.navigatorWidth, 300)
		XCTAssertEqual(Theme.Metric.surfaceTop, 48)
		XCTAssertEqual(Theme.Metric.missionBarHeight, 52)
		XCTAssertEqual(Theme.Metric.barGap, 12)
		XCTAssertEqual(Theme.Metric.hoverEdge, 6)
	}

	func testConcentric() {
		XCTAssertEqual(Theme.Metric.concentric(outer: 22, padding: 8), 14)
		XCTAssertEqual(Theme.Metric.concentric(outer: 26, padding: 12), 14)
		XCTAssertEqual(Theme.Metric.concentric(outer: 22, padding: 30), 6)
		XCTAssertEqual(Theme.Metric.concentric(outer: 10, padding: 8), 6)
		XCTAssertEqual(Theme.Metric.concentric(outer: 6, padding: 0), 6)
	}

	func testMonoAndDigitsApplyMonospacedDigits() throws {
		_ = Theme.text(12, .regular)
		_ = Theme.mono(10, .semibold)
		_ = Theme.digits(Theme.text(12, .regular))
		_ = Theme.digits(Theme.mono(12, .regular))
		// Font is opaque to introspection, so pin the modifier structurally:
		// both mono and digits must route through monospacedDigit.
		let theme = try source(named: "Theme/Theme.swift")
		XCTAssertGreaterThanOrEqual(
			occurrences(of: ".monospacedDigit()", in: theme), 2,
			"mono and digits must each apply .monospacedDigit()"
		)
	}

	func testNetaGlassIsOnlyGlassEffectCallSite() throws {
		let hits = try swiftSources()
			.filter { occurrences(of: "glassEffect(", in: $0.contents) > 0 }
			.map(\.relative)
		XCTAssertEqual(hits, ["Theme/Glass.swift"], "netaGlass must be the only glass call site outside Theme/")
		XCTAssertGreaterThanOrEqual(
			occurrences(of: "glassEffect(", in: try source(named: "Theme/Glass.swift")), 1,
			"netaGlass must apply the glass modifier"
		)
	}

	// MARK: - Structural helpers

	private struct NamedSource {
		let relative: String
		let contents: String
	}

	private func sourcesRoot() -> URL {
		URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
			.deletingLastPathComponent()
			.deletingLastPathComponent()
			.appendingPathComponent("Sources/NetaDesktop", isDirectory: true)
	}

	private func swiftSources() throws -> [NamedSource] {
		let root = sourcesRoot()
		let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
		var out: [NamedSource] = []
		while let url = enumerator?.nextObject() as? URL {
			guard url.pathExtension == "swift" else { continue }
			let contents = try String(contentsOf: url, encoding: .utf8)
			let relative = String(url.path.dropFirst(root.path.count + 1))
			out.append(NamedSource(relative: relative, contents: contents))
		}
		return out.sorted { $0.relative < $1.relative }
	}

	private func source(named relative: String) throws -> String {
		let url = sourcesRoot().appendingPathComponent(relative, isDirectory: false)
		return try String(contentsOf: url, encoding: .utf8)
	}

	private func occurrences(of token: String, in contents: String) -> Int {
		contents.components(separatedBy: token).count - 1
	}
}
