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

	/// Every number of PAPER-SPINE Revision 3's glass material, in Theme.
	/// A `netaGlass` that only tinted the system effect passed the old test;
	/// these are the values it was missing.
	func testGlassMaterialTokensMatchRevision3() {
		// Fill rgba(28,30,38,0.55) over the blur.
		assertRGBA(Theme.Glass.fill, 28, 30, 38, 0.55)
		// Rim 1px rgba(255,255,255,0.14).
		assertRGBA(Theme.Glass.rim, 255, 255, 255, 0.14)
		XCTAssertEqual(Theme.Glass.rimWidth, 1)
		// inset 0 1px 0 rgba(255,255,255,0.22) and 0 -1px 0 ...,0.04.
		assertRGBA(Theme.Glass.specularTop, 255, 255, 255, 0.22)
		assertRGBA(Theme.Glass.specularBottom, 255, 255, 255, 0.04)
		// Outer shadow 0 18px 40px rgba(0,0,0,0.38).
		assertRGBA(Theme.Glass.shadow, 0, 0, 0, 0.38)
		XCTAssertEqual(Theme.Glass.shadowY, 18)
		XCTAssertEqual(Theme.Glass.shadowBlur, 40)
		XCTAssertEqual(Theme.Glass.shadowRadius, 20, "SwiftUI radius is half the CSS blur")
		// 135° sheen: white 10% at 0% to clear at 38%.
		assertRGBA(Theme.Glass.sheenStart, 255, 255, 255, 0.10)
		XCTAssertEqual(Theme.Glass.sheenEnd, 0.38)
	}

	/// Revision 3's controls and surfaces on glass.
	func testGlassControlAndSurfaceTones() {
		assertRGBA(Theme.Glass.selectedSegment, 255, 255, 255, 0.14)
		assertRGBA(Theme.Glass.leadPlusSegment, 153, 133, 245, 0.30)
		assertRGBA(Theme.Glass.fieldFill, 0, 0, 0, 0.22)
		assertRGBA(Theme.Glass.chatFill, 28, 30, 38, 0.66)
		assertRGBA(Theme.Glass.leaderTint, 153, 133, 245, 0.16)
		assertRGBA(Theme.Glass.leaderBorder, 153, 133, 245, 0.6)
		assertRGBA(Theme.Glass.userBubble, 153, 133, 245, 0.35)
		assertRGBA(Theme.Glass.agentBubble, 255, 255, 255, 0.06)
		assertRGBA(Theme.Glass.leadPlusStrip, 153, 133, 245, 0.18)
	}

	/// Radii: panels 22, capsules drawn with `Capsule()` (so there is no
	/// 999 token to go stale), nested controls concentric.
	func testGlassRadii() {
		XCTAssertEqual(Theme.Metric.panelRadius, 22)
		XCTAssertEqual(
			Theme.Metric.concentric(
				outer: Theme.Metric.panelRadius, padding: Theme.Metric.chatPadding),
			10)
	}

	/// A rule is not the glass rim. Both are 1 pt today, but they are
	/// separate tokens so changing the material never moves a divider.
	func testRuleWidthIsItsOwnToken() throws {
		XCTAssertEqual(Theme.Metric.ruleWidth, 1)
		for name in ["Chat/ChatPanel.swift", "Shell/ToolbarCapsule.swift"] {
			let contents = try source(named: name)
			XCTAssertEqual(
				occurrences(of: "Theme.Glass.rimWidth", in: contents), 0,
				"\(name) draws rules with Theme.Metric.ruleWidth, not the glass rim")
		}
	}

	/// `netaGlass` must assemble the whole material, not just tint the
	/// system effect: fill, sheen, rim, both inset edges and the shadow.
	func testNetaGlassAssemblesTheWholeMaterial() throws {
		let glass = try source(named: "Theme/Glass.swift")
		for token in [
			"Theme.Glass.fill", "Theme.Glass.sheen(for:", "Theme.Glass.rim",
			"Theme.Glass.specularTop", "Theme.Glass.specularBottom",
			"Theme.Glass.shadow", "Theme.Glass.shadowRadius",
			"Theme.Glass.shadowY", "Capsule()", "strokeBorder", "allowsHitTesting(false)",
		] {
			XCTAssertGreaterThanOrEqual(
				occurrences(of: token, in: glass), 1, "netaGlass must use \(token)")
		}
		XCTAssertGreaterThanOrEqual(
			occurrences(of: "Theme.Metric.panelRadius", in: glass), 1,
			"panels take the 22 pt radius")
		// Revision 3 paints ONE fill over the blur. A tint handed to
		// glassEffect as well lands the colour twice: 0.66 renders at about
		// 0.88 and the chat panel goes nearly opaque.
		XCTAssertEqual(
			occurrences(of: "glassEffect(.regular,", in: glass), 1,
			"the material is untinted; the fill layer carries the colour once")
		XCTAssertEqual(
			occurrences(of: ".tint(", in: glass), 0,
			"no second application of the surface colour")
		// Revision 3 draws three distinct 1 pt rows: the rim right round, the
		// 22% specular edge along the top and the 4% edge along the bottom.
		// One perimeter stroke for both insets composited the top edge into
		// the rim's own band and ran a 22%-to-4% gradient down the sides,
		// which the CSS does not draw at all.
		XCTAssertEqual(
			occurrences(of: "strokeBorder", in: glass), 1,
			"only the rim strokes the perimeter")
		XCTAssertEqual(
			occurrences(of: "frame(height: Theme.Glass.rimWidth)", in: glass), 2,
			"the inset edges are two 1 pt rows, top and bottom only")
	}

	/// No view restates a material number: the tokens are the only copy.
	func testGlassViewsCarryNoMaterialLiterals() throws {
		for name in [
			"Chat/ComposerView.swift", "Chat/ChatHeaderView.swift",
			"Chat/ChatPanel.swift", "Shell/ToolbarCapsule.swift",
			"Canvas/NodeViews.swift",
		] {
			let contents = try source(named: name)
			for number in ["0.14)", "0.22)", "0.38)", "0.10)", "0.06)"] {
				XCTAssertEqual(
					occurrences(of: number, in: contents), 0,
					"\(name) must take \(number) from Theme.Glass")
			}
		}
	}

	/// The elevation rule documented on `netaGlass`: elevation follows the
	/// silhouette. `.panel` (22 px) and `.capsule` (999 px) are the two
	/// silhouettes Revision 3 gives its floating surfaces and take the
	/// `0 18 40` outer shadow; `.rounded(_)` is the concentric radius it
	/// reserves for nested controls and never does. When elevation was a
	/// defaulted `Bool` on `netaGlass` instead, six controls silently gained
	/// a 40 pt shadow onto the very surface hosting them; when it was a
	/// separate modifier nobody outside this group could call, the chat and
	/// navigator panels rendered flat.
	func testElevationFollowsTheSilhouette() throws {
		XCTAssertTrue(GlassShape.panel.floats, "22 px panels are floating surfaces")
		XCTAssertTrue(GlassShape.capsule.floats, "999 px capsules are floating surfaces")
		XCTAssertFalse(
			GlassShape.rounded(10).floats, "a concentric radius is a nested control")
		XCTAssertFalse(
			GlassShape.rounded(Theme.Metric.panelRadius).floats,
			"the case decides, not the radius it carries")

		// Every branch of `netaGlass` decides elevation from the rule alone,
		// so no silhouette can pick up or lose the shadow on its own.
		let glass = try source(named: "Theme/Glass.swift")
		let byShape = try slice(glass, from: "func netaGlass(", to: "func netaControlGlass(")
		XCTAssertEqual(
			occurrences(of: "netaOuterShadow(", in: byShape), 3,
			"all three netaGlass branches go through the shadow modifier")
		XCTAssertEqual(
			occurrences(of: "when: s.floats", in: byShape), 3,
			"and each decides from the silhouette, never from a literal")
		XCTAssertEqual(
			occurrences(of: "when: true", in: byShape), 0, "no branch forces the shadow")

		// The two named escape hatches, for the cases where silhouette and
		// role disagree: a control on a capsule, a floating surface on a
		// nested radius.
		let control = try slice(glass, from: "func netaControlGlass(", to: "func netaFloatingGlass(")
		XCTAssertEqual(
			occurrences(of: "netaOuterShadow(", in: control), 0,
			"netaControlGlass never shadows, whatever the silhouette")
		let floating = try slice(glass, from: "func netaFloatingGlass(", to: "func netaSpecular(")
		XCTAssertEqual(
			occurrences(of: "when: true", in: floating), 3,
			"netaFloatingGlass always shadows, whatever the silhouette")
	}

	/// The rule at the call sites, keyed on the calls themselves rather than
	/// on a frozen list of which file hosts which surface.
	///
	/// Revision 3 "Surfaces to convert" names five floating surfaces — the
	/// toolbar capsule, the chat panel, the mission bar capsule, the
	/// navigator panel and the Lead++ tooltip — and everything in its
	/// "Controls on glass" list takes the rim and no shadow. So there are
	/// exactly five shadowed calls in the app, no file holds two of them (a
	/// surface never shadows a chip it hosts as well), and a shadow on a
	/// nested radius is only ever the named escape hatch. Moving a surface
	/// from one file to another — lifting the chat panel's glass out of
	/// `RootView` into `ChatPanel`, say — is a refactor, not a defect, and
	/// this passes through it.
	func testNestedControlsNeverResolveToTheShadowBranch() throws {
		let calls = try glassCalls()
		XCTAssertGreaterThan(calls.count, 10, "the scan actually found the call sites")

		let shadowed = calls.filter(\.shadowed)
		XCTAssertEqual(
			shadowed.count, 5,
			"Revision 3 names five floating surfaces (toolbar capsule, chat "
				+ "panel, mission bar capsule, navigator panel, Lead++ "
				+ "tooltip); shadowed calls: "
				+ shadowed.map { "\($0.file):\($0.line)" }.joined(separator: ", "))

		for file in Set(shadowed.map(\.file)) {
			XCTAssertEqual(
				shadowed.filter { $0.file == file }.count, 1,
				"\(file) shadows more than one surface, so one of them is a "
					+ "control drawn on the other")
		}

		// A shadow on the concentric radius is only ever the named hatch,
		// never something `netaGlass` picked up on its own.
		for call in shadowed where call.shape == "rounded" {
			XCTAssertEqual(
				call.modifier, "netaFloatingGlass",
				"\(call.file):\(call.line): a nested radius floats only when "
					+ "the call says so")
		}

		// The control escape hatch stays an escape hatch: naming it on a
		// nested radius, which never floats anyway, hides the rule.
		//
		// The floating hatch is deliberately not policed the same way.
		// `netaFloatingGlass(.panel)` on a surface that already floats is
		// redundant, not wrong — it renders identically.
		for call in calls where call.modifier == "netaControlGlass" {
			XCTAssertNotEqual(
				call.shape, "rounded",
				"\(call.file):\(call.line): a nested radius never floats; call netaGlass")
		}
	}

	/// Revision 3 item 5: the Lead++ tooltip is a floating surface drawn on
	/// the nested radius, so it takes the shadow through the named hatch.
	/// It rendered flat for two passes because the silhouette rule alone
	/// cannot see it.
	func testTheLeadPlusTooltipFloats() throws {
		let source = try source(named: "Canvas/CheckpointViews.swift")
		XCTAssertTrue(
			source.contains(".netaFloatingGlass(.rounded(Self.tooltipRadius))"),
			"the tooltip carries Revision 3's 0 18 40 outer shadow")
		XCTAssertEqual(CheckpointLayer.tooltipRadius, 10)
	}

	/// Revision 3's outer shadow is assembled once, in `Theme/Glass.swift`.
	///
	/// Scoped to the glass modifiers on purpose: a file this group does not
	/// own may legitimately draw a shadow of its own, and the word
	/// "elevated" in someone's doc comment is not a defect. What must not
	/// happen is a second assembly of the `0 18 40`.
	func testTheOuterShadowIsAssembledOnlyInGlass() throws {
		for file in try swiftSources() where !file.relative.hasPrefix("Theme/") {
			XCTAssertEqual(
				occurrences(of: "netaOuterShadow(", in: file.contents), 0,
				"\(file.relative): the shadow modifier is Glass.swift's own")
			XCTAssertEqual(
				occurrences(of: "Theme.Glass.shadow", in: file.contents), 0,
				"\(file.relative): the shadow tokens are used only by Glass.swift")
		}
		let glass = try source(named: "Theme/Glass.swift")
		XCTAssertEqual(
			occurrences(of: ".shadow(", in: glass), 1,
			"one drop shadow, cast by the opaque silhouette")
		for token in ["compositingGroup()", "blendMode(.destinationOut)"] {
			XCTAssertGreaterThanOrEqual(
				occurrences(of: token, in: glass), 1,
				"the shadow is punched out inside the shape with \(token)")
		}
	}

	/// Revision 3's sheen is `linear-gradient(135deg, ...)`: a 45° axis in
	/// SCREEN space. `UnitPoint` is normalised to the view's bounds, so the
	/// fixed `UnitPoint(0.38, 0.38)` this replaced tilted with the aspect
	/// ratio — about 65° on the 410x880 chat panel, 45° only on a square.
	func testSheenAxisIs135DegreesOnAnyAspect() {
		for size in [
			CGSize(width: 410, height: 880), CGSize(width: 300, height: 200),
			CGSize(width: 200, height: 200),
		] {
			let end = Theme.Glass.sheenEndPoint(for: size)
			let dx = Double(end.x) * size.width
			let dy = Double(end.y) * size.height
			XCTAssertEqual(dx, dy, accuracy: 0.001, "45° in points, not in unit space")
			// The CSS gradient line for 135° is (w + h)/√2 long and the
			// colour reaches clear at 38% of it.
			let reach = (dx * dx + dy * dy).squareRoot()
			let line = Double(size.width + size.height) / (2.0 as Double).squareRoot()
			XCTAssertEqual(
				reach, 0.38 * line, accuracy: 0.001,
				"clear at 38% of the gradient line")
		}
	}

	/// Revision 3's outer shadow is CSS `box-shadow`, which the spec clips to
	/// the outside of the border box. SwiftUI's `.shadow` instead derives the
	/// shadow from the layer's alpha and composites it BEHIND that layer, so
	/// a translucent glass fill shows the whole silhouette through it and the
	/// surface renders far darker than its token. Source greps cannot see the
	/// difference, so this renders it: a panel over white must keep the same
	/// interior colour with the shadow and without it, while the ground just
	/// below it darkens.
	@MainActor
	func testOuterShadowNeverDarkensTheInterior() throws {
		let canvas = CGSize(width: 460, height: 360)
		let panel = CGSize(width: 300, height: 200)
		let shape = RoundedRectangle(
			cornerRadius: Theme.Metric.panelRadius, style: .continuous)
		// The fill is the translucent glass token, not an opaque colour: an
		// opaque surface would hide a wrongly-composited shadow and the test
		// would pass either way.
		func panelView(shadowed: Bool) -> some View {
			ZStack {
				Color.white
				Group {
					shape
						.fill(Theme.Glass.fill)
						.frame(width: panel.width, height: panel.height)
						.netaOuterShadow(shape, when: shadowed)
				}
			}
		}

		// Orientation guard: row 0 of the buffer must be the top of the image,
		// or the samples below would read the wrong side of the panel.
		let probe = try render(
			ZStack { VStack(spacing: 0) { Color.black; Color.white } }, size: canvas)
		XCTAssertLessThan(probe.gray(x: 230, y: 20), 0.2, "row 0 is the top row")
		XCTAssertGreaterThan(probe.gray(x: 230, y: 340), 0.8, "the last row is the bottom")

		let flat = try render(panelView(shadowed: false), size: canvas)
		let lifted = try render(panelView(shadowed: true), size: canvas)
		// The panel occupies x 80...380, y 80...280 of the canvas.
		for point in [(230, 180), (110, 100), (350, 260), (230, 95), (230, 265)] {
			XCTAssertEqual(
				lifted.gray(x: point.0, y: point.1), flat.gray(x: point.0, y: point.1),
				accuracy: 2.0 / 255.0,
				"the shadow must not reach inside the shape at \(point)")
		}
		// 20 pt below the panel the shadow (offset 18, radius 20) must show.
		XCTAssertLessThan(
			lifted.gray(x: 230, y: 300), flat.gray(x: 230, y: 300) - 0.05,
			"the shadow must fall outside the shape")
	}

	// MARK: - Render helpers

	private struct Bitmap {
		let pixels: [UInt8]
		let width: Int
		/// Average of the three channels at a point, 0...1, row 0 at the top.
		func gray(x: Int, y: Int) -> Double {
			let i = (y * width + x) * 4
			return (Double(pixels[i]) + Double(pixels[i + 1]) + Double(pixels[i + 2]))
				/ (3.0 * 255.0)
		}
	}

	@MainActor
	private func render(_ view: some View, size: CGSize) throws -> Bitmap {
		let width = Int(size.width)
		let height = Int(size.height)
		let renderer = ImageRenderer(content: view.frame(width: size.width, height: size.height))
		renderer.scale = 1
		let image = try XCTUnwrap(renderer.cgImage, "ImageRenderer produced no image")
		let count = width * height * 4
		let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: count)
		defer { buffer.deallocate() }
		buffer.initialize(repeating: 0, count: count)
		let context = try XCTUnwrap(
			CGContext(
				data: buffer, width: width, height: height, bitsPerComponent: 8,
				bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
				bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
		context.draw(image, in: CGRect(origin: .zero, size: size))
		return Bitmap(
			pixels: Array(UnsafeBufferPointer(start: buffer, count: count)), width: width)
	}

	/// A colour with its own alpha, resolved channel by channel.
	private func assertRGBA(
		_ color: Color, _ r: Double, _ g: Double, _ b: Double, _ a: Double,
		file: StaticString = #filePath, line: UInt = #line
	) {
		let c = resolved(color)
		XCTAssertEqual(Double(c.linearRed), linear(r), accuracy: tolerance, "red", file: file, line: line)
		XCTAssertEqual(Double(c.linearGreen), linear(g), accuracy: tolerance, "green", file: file, line: line)
		XCTAssertEqual(Double(c.linearBlue), linear(b), accuracy: tolerance, "blue", file: file, line: line)
		XCTAssertEqual(Double(c.opacity), a, accuracy: tolerance, "opacity", file: file, line: line)
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

	/// The text between two markers, so a rule can be asserted against one
	/// modifier's body instead of the whole file.
	private func slice(_ contents: String, from: String, to: String) throws -> String {
		let start = try XCTUnwrap(contents.range(of: from), "no \(from)")
		let end = try XCTUnwrap(
			contents.range(of: to, range: start.upperBound..<contents.endIndex), "no \(to)")
		return String(contents[start.upperBound..<end.lowerBound])
	}

	// MARK: - Glass call sites

	/// One application of a glass modifier, and whether the elevation rule
	/// resolves it to the outer shadow.
	private struct GlassCall {
		let file: String
		let line: Int
		let modifier: String
		/// `panel`, `capsule` or `rounded` — the `GlassShape` case named at
		/// the call site, `panel` when the argument is defaulted.
		let shape: String

		var shadowed: Bool {
			switch modifier {
			case "netaControlGlass": false
			case "netaFloatingGlass": true
			default: shape == "panel" || shape == "capsule"
			}
		}
	}

	/// Every glass call in the app outside `Theme/Glass.swift`, which defines
	/// the modifiers and names them in prose.
	private func glassCalls() throws -> [GlassCall] {
		var out: [GlassCall] = []
		for file in try swiftSources() where file.relative != "Theme/Glass.swift" {
			for (index, raw) in file.contents.components(separatedBy: "\n").enumerated() {
				let text = raw.trimmingCharacters(in: .whitespaces)
				guard !text.hasPrefix("//") else { continue }
				for modifier in ["netaGlass", "netaControlGlass", "netaFloatingGlass"] {
					guard let call = text.range(of: ".\(modifier)(") else { continue }
					let argument = text[call.upperBound...]
					let shape =
						argument.hasPrefix(".capsule") ? "capsule"
						: argument.hasPrefix(".rounded") ? "rounded" : "panel"
					out.append(GlassCall(
						file: file.relative, line: index + 1, modifier: modifier, shape: shape))
				}
			}
		}
		return out
	}
}
