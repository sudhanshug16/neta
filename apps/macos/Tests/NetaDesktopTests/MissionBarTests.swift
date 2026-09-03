import Foundation
import XCTest

@testable import NetaDesktop

/// T9.9 contract: leader, Now, divider, waiting grouped blocked, failed,
/// readyToClose, mergedNotClosed by number ascending, then running by number
/// ascending; closed never appear; every waiting item has a text state label;
/// `now(lit:)` follows the flag.
@MainActor
final class MissionBarTests: XCTestCase {
	func testPrefixIsLeaderNowDivider() async throws {
		let store = try await fixtureStore()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		XCTAssertEqual(items.count, 3 + 8 + 3)
		guard case .leader(_, let mode) = items[0] else {
			return XCTFail("first item is the leader, got \(items[0])")
		}
		XCTAssertEqual(mode, store.leader?.mode)
		XCTAssertEqual(items[1], .now(lit: true))
		XCTAssertEqual(items[2], .divider)
	}

	func testWaitingOrderIsGroupedThenByNumber() async throws {
		let store = try await fixtureStore()
		let waiting = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
			.compactMap { item -> (Int, MissionState)? in
				guard case .waiting(let mission) = item else { return nil }
				return (mission.number, mission.state)
			}
		XCTAssertEqual(waiting.map(\.0), [2, 9, 5, 10, 3, 11, 4, 12])
		XCTAssertEqual(
			waiting.map(\.1),
			[.blocked, .blocked, .failed, .failed,
			 .readyToClose, .readyToClose, .mergedNotClosed, .mergedNotClosed])
	}

	func testRunningFollowsWaitingByNumberAscending() async throws {
		let store = try await fixtureStore()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		let running = items.compactMap { item -> Int? in
			guard case .running(let mission) = item else { return nil }
			return mission.number
		}
		XCTAssertEqual(running, [1, 7, 8])
		let lastWaiting = items.lastIndex { item in
			guard case .waiting = item else { return false }
			return true
		}
		let firstRunning = items.firstIndex { item in
			guard case .running = item else { return false }
			return true
		}
		XCTAssertNotNil(lastWaiting)
		XCTAssertNotNil(firstRunning)
		XCTAssertLessThan(try XCTUnwrap(lastWaiting), try XCTUnwrap(firstRunning))
	}

	func testClosedMissionsNeverAppear() async throws {
		let store = try await fixtureStore()
		let closedIds = Set(store.missions.filter { $0.state == .closed }.map(\.id))
		XCTAssertEqual(closedIds.count, 2)
		for item in MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		{
			switch item {
			case .waiting(let mission), .running(let mission):
				XCTAssertFalse(closedIds.contains(mission.id))
			case .leader, .now, .divider:
				break
			}
		}
	}

	func testWaitingStateLabels() {
		XCTAssertEqual(MissionBarItem.label(for: .blocked), "Blocked")
		XCTAssertEqual(MissionBarItem.label(for: .failed), "Failed")
		XCTAssertEqual(MissionBarItem.label(for: .readyToClose), "Ready to close")
		XCTAssertEqual(MissionBarItem.label(for: .mergedNotClosed), "Merged, not closed")
	}

	func testEveryWaitingItemHasNonEmptyStateLabel() async throws {
		let store = try await fixtureStore()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		let waiting = items.filter { item in
			guard case .waiting = item else { return false }
			return true
		}
		XCTAssertEqual(waiting.count, 8)
		for item in waiting {
			let label = try XCTUnwrap(item.stateLabel)
			XCTAssertFalse(label.isEmpty)
		}
	}

	func testNowLitFollowsFlag() async throws {
		let store = try await fixtureStore()
		XCTAssertEqual(
			MissionBarModel.items(missions: store.missions, leader: store.leader, nowLit: true)[1],
			.now(lit: true))
		XCTAssertEqual(
			MissionBarModel.items(missions: store.missions, leader: store.leader, nowLit: false)[1],
			.now(lit: false))
	}

	func testNilLeaderOmitsLeaderItem() async throws {
		let store = try await fixtureStore()
		let items = MissionBarModel.items(missions: store.missions, leader: nil, nowLit: false)
		XCTAssertEqual(items.first, .now(lit: false))
		XCTAssertFalse(items.contains { item in
			guard case .leader = item else { return false }
			return true
		})
	}

	func testItemIdsAreUnique() async throws {
		let store = try await fixtureStore()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		XCTAssertEqual(Set(items.map(\.id)).count, items.count)
	}

	func testLeaderCarriesNameAndMode() async throws {
		let store = try await fixtureStore()
		let leader = try XCTUnwrap(store.leader)
		let items = MissionBarModel.items(missions: store.missions, leader: leader, nowLit: true)
		guard case .leader(let name, let mode) = items[0] else {
			return XCTFail("first item is the leader")
		}
		XCTAssertFalse(name.isEmpty)
		XCTAssertEqual(mode, leader.mode)
	}

	func testViewBuildsAndStoresNoControlState() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		var selected: Selection?
		let view = MissionBarView(items: items, selection: shell.selection) { selected = $0 }
		_ = view
		// The view holds items, selection and the callback only: no counts,
		// no cards, and never the Lead/Lead++ control.
		let labels = Mirror(reflecting: view).children.compactMap(\.label).sorted()
		XCTAssertEqual(labels, ["items", "onSelect", "selection"])
		XCTAssertNil(selected)
	}

	// MARK: - Helpers

	/// The recorded fixture snapshot in a store: the only data tests use.
	private func fixtureStore() async throws -> Store {
		let client = FixtureNodeClient()
		let snapshot = try await client.snapshot()
		let store = Store()
		store.replace(snapshot: snapshot)
		return store
	}
}
