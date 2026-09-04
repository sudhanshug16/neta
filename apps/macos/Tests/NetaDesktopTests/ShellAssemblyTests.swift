import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

/// Shell assembly contract: `RootView` wires the real T9.8–T9.10 surfaces —
/// `ToolbarCapsule`, `MissionBarView`, `NavigatorOverlay` plus the
/// `NavigatorEdgeTrigger` open path — over a live `Store`, never
/// placeholders. Each test builds exactly the model call `RootView.body`
/// makes and asserts it carries the fixture content to the surface.
@MainActor
final class ShellAssemblyTests: XCTestCase {
	func testRootViewBuildsOverFixtureSnapshot() async throws {
		let client = FixtureNodeClient()
		let store = Store()
		store.replace(snapshot: try await client.snapshot())
		let shell = ShellState()
		let view = RootView(store: store, shell: shell, client: client)
		_ = view
	}

	func testToolbarSeesFixtureWorkspaces() async throws {
		let store = try await fixtureStore()
		let model = ToolbarModel.make(store: store, shell: ShellState())
		XCTAssertFalse(model.workspaces.isEmpty)
		XCTAssertFalse(model.selectedWorkspaceId.isEmpty)
	}

	func testMissionBarStartsWithLeaderAndNow() async throws {
		let store = try await fixtureStore()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		XCTAssertGreaterThanOrEqual(items.count, 3)
		if case .leader = items[0] {} else {
			XCTFail("first mission-bar item is the workspace leader")
		}
		if case .now(_, let lit) = items[1] {
			XCTAssertTrue(lit)
		} else {
			XCTFail("second mission-bar item is the Now control")
		}
		let closed = Set(store.missions.filter { $0.state == .closed }.map(\.id))
		XCTAssertFalse(closed.isEmpty)
		for item in items {
			switch item {
			case .waiting(let mission), .running(let mission):
				XCTAssertFalse(closed.contains(mission.id))
			case .leader, .now, .divider:
				break
			}
		}
	}

	func testNavigatorCoversEveryFixtureMission() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		let shown = Set(model.open.map(\.id) + model.archived.map(\.id))
		XCTAssertEqual(shown, Set(store.missions.map(\.id)))
	}

	/// The empty state is the leader at Now: no missions, no columns, no
	/// ticks, and the leader card right-aligned just left of the chat —
	/// never at content x 0, which is behind the navigator band.
	func testEmptyStoreOpensWithTheLeaderAtNow() throws {
		let store = Store()
		let frame = try assertLeaderCardIsAtNow(store: store, date: Date())
		XCTAssertTrue(frame.window.columns.isEmpty)
		XCTAssertTrue(frame.window.ticks.isEmpty)
	}

	/// The same right alignment with the recorded fixture behind it: the
	/// leader is the Now anchor whatever the sequence holds.
	func testFixtureStoreOpensWithTheLeaderAtNow() async throws {
		let store = try await fixtureStore()
		_ = try assertLeaderCardIsAtNow(
			store: store, date: store.window.upperBound)
	}

	/// Resolves the first layout at the 1600 x 1000 default window and
	/// asserts the leader card is the Now anchor: its far edge on the
	/// canvas's usable right edge (the chat's leading edge less
	/// `SpinePlacement.chatGap`), clear of the navigator band, centred on
	/// the spine, and Now lit.
	@discardableResult
	private func assertLeaderCardIsAtNow(
		store: Store, date: Date, file: StaticString = #filePath,
		line: UInt = #line
	) throws -> SpineCanvasFrame {
		let size = CGSize(width: 1600, height: 1000)
		let shell = ShellState()
		let now = NowState()
		let view = SpineCanvasView(
			store: store, shell: shell,
			viewport: SpineViewportState(
				pxPerHour: SpineViewportState.defaultPxPerHour),
			now: now, router: CheckpointRouter())
		let frame = view.resolve(size: size, date: date)
		let layout = ShellLayout.compute(
			size: size, chatVisible: shell.chatVisible,
			navigatorVisible: true)
		let chat = try XCTUnwrap(layout.chat, file: file, line: line)
		let navigator = try XCTUnwrap(
			layout.navigator, file: file, line: line)
		let leader = frame.window.leader
		XCTAssertEqual(
			leader.maxX, chat.minX - SpinePlacement.chatGap,
			accuracy: 1e-6,
			"the leader card sits just left of the chat panel",
			file: file, line: line)
		XCTAssertGreaterThan(
			leader.minX, navigator.maxX,
			"the leader card is never inside the navigator band",
			file: file, line: line)
		XCTAssertEqual(
			leader.midY, frame.window.spineY,
			"the leader card is vertically centred on the spine",
			file: file, line: line)
		XCTAssertTrue(now.isLive, file: file, line: line)
		XCTAssertEqual(now.label, "Now", file: file, line: line)
		return frame
	}

	func testEmptyStoreBarHasNowButNoMissions() {
		let store = Store()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		XCTAssertEqual(items.count, 2)
		for item in items {
			switch item {
			case .waiting, .running:
				XCTFail("empty store shows no mission chips")
			case .leader, .now, .divider:
				break
			}
		}
	}

	func testEmptyNavigatorHasNoRows() {
		let store = Store()
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertTrue(model.open.isEmpty)
		XCTAssertTrue(model.archived.isEmpty)
	}

	func testNavigatorOpenDismissRoundTrip() {
		let shell = ShellState()
		XCTAssertFalse(shell.navigatorVisible)
		shell.toggleNavigator()
		XCTAssertTrue(shell.navigatorVisible)
		XCTAssertTrue(shell.dismissOverlay())
		XCTAssertFalse(shell.navigatorVisible)
		XCTAssertFalse(shell.dismissOverlay())
	}

	// MARK: - Helpers

	private func fixtureStore() async throws -> Store {
		let client = FixtureNodeClient()
		let store = Store()
		store.replace(snapshot: try await client.snapshot())
		return store
	}
}
