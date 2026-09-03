import XCTest

@testable import NetaDesktop

final class SmokeTests: XCTestCase {
	func testRootViewModelStartsIdle() {
		let model = RootViewModel()
		XCTAssertEqual(model.status, "Neta")
	}
}
