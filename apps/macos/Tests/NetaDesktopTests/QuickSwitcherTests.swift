import XCTest
@testable import NetaDesktop

@MainActor final class QuickSwitcherTests: XCTestCase {
	func testKeyboardSelectionClampsAndReturnsSelectedEntry() {
		let model = QuickSwitcherModel()
		let date = Date(timeIntervalSince1970: 0)
		let workspace = Workspace(id: "w", kind: .folder, name: "NoScrubs", remote: nil, roots: [], createdAt: date)
		let entries = [QuickSwitcherModel.Entry(id: "one", workspace: workspace, machine: nil), QuickSwitcherModel.Entry(id: "two", workspace: workspace, machine: nil)]
		model.move(1, in: entries)
		XCTAssertEqual(model.selected(in: entries)?.id, "two")
		model.move(9, in: entries)
		XCTAssertEqual(model.selectedIndex, 1)
		model.move(-9, in: entries)
		XCTAssertEqual(model.selectedIndex, 0)
	}

	func testChangingQueryResetsKeyboardSelection() {
		let model = QuickSwitcherModel()
		model.selectedIndex = 4
		model.query = "scrub"
		XCTAssertEqual(model.selectedIndex, 0)
	}
}
