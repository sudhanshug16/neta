import Foundation
import XCTest

@testable import NetaDesktop

@MainActor
final class ProjectActionsTests: XCTestCase {
	func testCreateMakesPlainDirectoryAndOpensIt() async throws {
		let parent = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
		try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(at: parent) }
		let target = parent.appending(path: "Project")
		var opened: URL?
		let actions = ProjectActions()
		let created = await actions.create(target) { opened = $0; return true }
		XCTAssertTrue(created)
		XCTAssertEqual(opened, target)
		XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
		XCTAssertFalse(FileManager.default.fileExists(atPath: target.appending(path: ".git").path))
		XCTAssertNil(actions.errorMessage)
	}

	func testCreateRefusesExistingPathWithoutClobberingIt() async throws {
		let target = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
		try Data("keep".utf8).write(to: target)
		defer { try? FileManager.default.removeItem(at: target) }
		var opened = false
		let actions = ProjectActions()
		let created = await actions.create(target) { _ in opened = true; return true }
		XCTAssertFalse(created)
		XCTAssertFalse(opened)
		XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "keep")
		XCTAssertNotNil(actions.errorMessage)
	}

	func testOpenFailureIsVisibleAndCanBeDismissed() async {
		let actions = ProjectActions()
		let opened = await actions.open(URL(filePath: "/missing")) { _ in false }
		XCTAssertFalse(opened)
		XCTAssertNotNil(actions.errorMessage)
		actions.dismissError()
		XCTAssertNil(actions.errorMessage)
	}

	func testSlowOpenPublishesProgressUntilTheResultArrives() async throws {
		let actions = ProjectActions()
		let task = Task { @MainActor in
			await actions.open(URL(filePath: "/slow-project")) { _ in
				try? await Task.sleep(for: .milliseconds(100))
				return true
			}
		}
		await Task.yield()
		XCTAssertTrue(actions.isOpening)
		let opened = await task.value
		XCTAssertTrue(opened)
		XCTAssertFalse(actions.isOpening)
	}
}
