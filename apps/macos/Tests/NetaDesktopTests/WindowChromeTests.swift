import AppKit
import XCTest

@testable import NetaDesktop

/// T9.7: the window's own chrome.
///
/// `.windowStyle(.hiddenTitleBar)` alone left the window taking the system
/// appearance — the render for the 2026-09-04 fix pass came out with pale
/// grey glass on a machine set to Light — and left a blank strip where the
/// title bar had been instead of running the canvas to the top edge.
@MainActor
final class WindowChromeTests: XCTestCase {
	private func makeWindow() -> NSWindow {
		NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1600, height: 1000),
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered, defer: true)
	}

	func testChromeIsDarkAndFullSizeContent() {
		let window = makeWindow()
		XCTAssertFalse(window.styleMask.contains(.fullSizeContentView))

		WindowChrome.apply(to: window)

		XCTAssertEqual(window.appearance?.name, .darkAqua)
		XCTAssertEqual(
			window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]),
			.darkAqua,
			"the design is dark only; the glass material resolves against this")
		XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
		XCTAssertTrue(window.titlebarAppearsTransparent)
		XCTAssertEqual(window.titleVisibility, .hidden)
	}

	/// Full-size content means the content view is the whole window: no
	/// blank strip above the canvas, and the traffic lights sit over it.
	func testTheContentViewRunsToTheTopEdge() {
		let window = makeWindow()
		WindowChrome.apply(to: window)
		XCTAssertEqual(window.contentView?.frame.height, window.frame.height)
	}

	/// Applying twice changes nothing: the configurator runs on every layout
	/// pass.
	func testApplyIsIdempotent() {
		let window = makeWindow()
		WindowChrome.apply(to: window)
		let mask = window.styleMask
		WindowChrome.apply(to: window)
		XCTAssertEqual(window.styleMask, mask)
	}

	/// The debug driver can report the chrome, which is the only way to see
	/// it on a machine whose window server composites nothing.
	func testTheDriverReportsTheChrome() {
		let window = makeWindow()
		WindowChrome.apply(to: window)
		let dump = DebugDriver.chromeDump(window)
		XCTAssertTrue(dump.contains("fullSizeContent=true"), dump)
		XCTAssertTrue(dump.contains("titlebarTransparent=true"), dump)
		XCTAssertTrue(dump.contains("contentInset=0"), dump)
		XCTAssertTrue(dump.contains("NSAppearanceNameDarkAqua"), dump)
	}
}
