import Foundation
import XCTest

@testable import NetaDesktop

/// T9.7 contract: at 1100x700 and 1600x1000 the chat never overlaps the
/// mission bar (`chat!.maxY <= missionBar.minY`, gap 12); every rect lies
/// inside the window; the chat is at least 320 wide and leaves 360 points of
/// canvas uncovered on the left; hiding the chat changes neither the bar nor
/// the canvas.
final class ShellLayoutTests: XCTestCase {
	private let small = CGSize(width: 1100, height: 700)
	private let large = CGSize(width: 1600, height: 1000)

	private var sizes: [CGSize] { [small, large] }

	private func window(_ size: CGSize) -> CGRect {
		CGRect(origin: .zero, size: size)
	}

	func testCanvasAlwaysFillsWindow() {
		for size in sizes {
			for chat in [true, false] {
				for navigator in [true, false] {
					let layout = ShellLayout.compute(
						size: size, chatVisible: chat, navigatorVisible: navigator)
					XCTAssertEqual(layout.canvas, window(size))
				}
			}
		}
	}

	func testMissionBarExactInsets() {
		for size in sizes {
			let layout = ShellLayout.compute(size: size, chatVisible: true, navigatorVisible: false)
			XCTAssertEqual(
				layout.missionBar,
				CGRect(x: 16, y: size.height - 68, width: size.width - 32, height: 52))
		}
	}

	func testChatExactFrame() throws {
		for size in sizes {
			let layout = ShellLayout.compute(size: size, chatVisible: true, navigatorVisible: false)
			let chat = try XCTUnwrap(layout.chat)
			XCTAssertEqual(chat.width, 410)
			XCTAssertEqual(chat.minX, size.width - 426)
			XCTAssertEqual(chat.minY, 48)
			XCTAssertEqual(chat.maxY, layout.missionBar.minY - 12)
		}
	}

	func testChatNeverOverlapsMissionBar() throws {
		for size in sizes {
			let layout = ShellLayout.compute(size: size, chatVisible: true, navigatorVisible: false)
			let chat = try XCTUnwrap(layout.chat)
			XCTAssertEqual(chat.maxY, layout.missionBar.minY - 12, "gap 12 at \(size)")
			XCTAssertLessThanOrEqual(chat.maxY, layout.missionBar.minY)
		}
	}

	func testEveryRectInsideWindow() throws {
		for size in sizes {
			let layout = ShellLayout.compute(size: size, chatVisible: true, navigatorVisible: true)
			let frame = window(size)
			XCTAssertTrue(frame.contains(layout.canvas))
			XCTAssertTrue(frame.contains(layout.missionBar))
			XCTAssertTrue(frame.contains(try XCTUnwrap(layout.chat)))
			XCTAssertTrue(frame.contains(try XCTUnwrap(layout.navigator)))
		}
	}

	func testChatLeavesCanvasUncovered() throws {
		for size in sizes {
			let layout = ShellLayout.compute(size: size, chatVisible: true, navigatorVisible: false)
			let chat = try XCTUnwrap(layout.chat)
			XCTAssertGreaterThanOrEqual(chat.width, 320)
			XCTAssertGreaterThanOrEqual(chat.minX, 360)
		}
	}

	func testHidingChatChangesNeitherBarNorCanvas() {
		for size in sizes {
			let shown = ShellLayout.compute(size: size, chatVisible: true, navigatorVisible: false)
			let hidden = ShellLayout.compute(size: size, chatVisible: false, navigatorVisible: false)
			XCTAssertNotNil(shown.chat)
			XCTAssertNil(hidden.chat)
			XCTAssertEqual(hidden.missionBar, shown.missionBar)
			XCTAssertEqual(hidden.canvas, shown.canvas)
		}
	}

	func testNavigatorBand() throws {
		for size in sizes {
			let hidden = ShellLayout.compute(size: size, chatVisible: true, navigatorVisible: false)
			XCTAssertNil(hidden.navigator)
			let layout = ShellLayout.compute(size: size, chatVisible: true, navigatorVisible: true)
			let navigator = try XCTUnwrap(layout.navigator)
			let chat = try XCTUnwrap(layout.chat)
			XCTAssertEqual(navigator.minX, 12)
			XCTAssertEqual(navigator.width, 300)
			XCTAssertEqual(navigator.minY, 48)
			XCTAssertEqual(navigator.maxY, chat.maxY)
			XCTAssertEqual(navigator.maxY, layout.missionBar.minY - 12)
			XCTAssertTrue(window(size).contains(navigator))
		}
	}
}
