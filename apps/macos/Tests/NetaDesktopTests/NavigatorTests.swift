import Foundation
import XCTest

@testable import NetaDesktop

/// T9.10 contract: `open` is number descending, `archived` is closedAt
/// descending; a closed mission never appears in `open`; `#30` matches by
/// number prefix and `refund` case-insensitively by name; an empty query
/// returns every mission; one machine gives `machines == nil`; no leader
/// row, no group counts.
@MainActor
final class NavigatorTests: XCTestCase {
	func testOpenIsNumberDescending() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(model.open.map(\.number), [12, 11, 10, 9, 8, 7, 5, 4, 3, 2, 1])
	}

	func testArchivedIsClosedAtDescending() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(model.archived.map(\.number), [13, 6])
	}

	func testClosedMissionNeverAppearsInOpen() async throws {
		let store = try await fixtureStore()
		let closedIds = Set(store.missions.filter { $0.state == .closed }.map(\.id))
		XCTAssertEqual(closedIds.count, 2)
		XCTAssertEqual(NavigatorModel.make(store: store, query: "").archived.count, 2)
		for row in NavigatorModel.make(store: store, query: "").open {
			XCTAssertFalse(closedIds.contains(row.id))
		}
	}

	func testHashPrefixMatchesNumberPrefix() {
		let store = storeFor(missions: [
			missi(number: 3, name: "Checkout rollout", state: .running),
			missi(number: 30, name: "Refund flow edge cases", state: .blocked),
			missi(number: 31, name: "Search index rebuild", state: .running),
			missi(number: 300, name: "Terraform drift on staging", state: .running),
		])
		let numbers = NavigatorModel.make(store: store, query: "#30").open.map(\.number)
		XCTAssertEqual(numbers, [300, 30])
	}

	func testBareDigitsMatchNumberPrefix() {
		let store = storeFor(missions: [
			missi(number: 3, name: "Checkout rollout", state: .running),
			missi(number: 30, name: "Refund flow edge cases", state: .blocked),
			missi(number: 31, name: "Search index rebuild", state: .running),
		])
		let numbers = NavigatorModel.make(store: store, query: "30").open.map(\.number)
		XCTAssertEqual(numbers, [30])
	}

	func testNameSubstringIsCaseInsensitive() {
		let store = storeFor(missions: [
			missi(number: 30, name: "Refund flow edge cases", state: .blocked),
			missi(number: 31, name: "Search index rebuild", state: .running),
		])
		for query in ["refund", "REFUND", "ReFuNd"] {
			let rows = NavigatorModel.make(store: store, query: query).open
			XCTAssertEqual(rows.map(\.number), [30], "query \(query)")
		}
	}

	func testNumberQueryDoesNotMatchNameSubstring() {
		let store = storeFor(missions: [
			missi(number: 5, name: "Apartment 300 review", state: .running),
			missi(number: 30, name: "Checkout rollout", state: .running),
		])
		// "#30" is a number-prefix query: it must not match the "300" in
		// mission 5's name.
		XCTAssertEqual(NavigatorModel.make(store: store, query: "#30").open.map(\.number), [30])
	}

	func testEmptyQueryReturnsEveryMission() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(model.open.count + model.archived.count, store.missions.count)
		XCTAssertEqual(model.open.count, 11)
		XCTAssertEqual(model.archived.count, 2)
	}

	func testQueryFiltersBothGroups() {
		let store = storeFor(missions: [
			missi(number: 30, name: "Refund flow edge cases", state: .blocked),
			missi(number: 31, name: "Search index rebuild", state: .running),
			missi(
				number: 29, name: "Refund policy draft", state: .closed,
				closedAt: base.addingTimeInterval(-86400), disposition: .merged),
		])
		let model = NavigatorModel.make(store: store, query: "refund")
		XCTAssertEqual(model.open.map(\.number), [30])
		XCTAssertEqual(model.archived.map(\.number), [29])
	}

	func testNoMatchKeepsWorkspacesButEmptiesMissions() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "zzz-no-such-mission")
		XCTAssertTrue(model.open.isEmpty)
		XCTAssertTrue(model.archived.isEmpty)
		XCTAssertEqual(model.workspaces.count, store.workspaces.count)
	}

	func testSingleMachineGivesNilMachines() async throws {
		let store = try await fixtureStore()
		XCTAssertNil(NavigatorModel.make(store: store, query: "").machines)
	}

	func testTwoRootsOnTwoMachinesGiveTwoEntries() {
		let store = storeFor(
			missions: [],
			roots: [
				WorkspaceRoot(machineId: "m1", path: "/vol/a"),
				WorkspaceRoot(machineId: "m2", path: "/vol/b"),
			])
		let machines = NavigatorModel.make(store: store, query: "").machines
		XCTAssertEqual(machines?.map(\.id), ["m1", "m2"])
	}

	func testNoLeaderRowAndNoGroupCounts() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		// The model carries workspaces, the conditional machines, and the
		// two mission groups only: no leader row, no counts.
		let labels = Mirror(reflecting: model).children.compactMap(\.label).sorted()
		XCTAssertEqual(labels, ["archived", "machines", "open", "workspaces"])
		let firstRow = try XCTUnwrap(model.open.first)
		XCTAssertEqual(
			Mirror(reflecting: firstRow).children.compactMap(\.label).sorted(),
			["id", "name", "number", "stateLabel", "tint"])
		let missionIds = Set(store.missions.map(\.id))
		for row in model.open + model.archived {
			XCTAssertTrue(missionIds.contains(row.id))
			XCTAssertFalse(row.stateLabel.isEmpty)
		}
	}

	func testOpenRowsCarryTextStateLabels() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		let byNumber = Dictionary(uniqueKeysWithValues: model.open.map { ($0.number, $0.stateLabel) })
		XCTAssertEqual(byNumber[2], "Blocked")
		XCTAssertEqual(byNumber[5], "Failed")
		XCTAssertEqual(byNumber[3], "Ready to close")
		XCTAssertEqual(byNumber[4], "Merged, not closed")
		XCTAssertEqual(byNumber[1], "Running")
	}

	func testArchivedRowsCarryDispositionLabels() {
		let store = storeFor(missions: [
			missi(
				number: 6, name: "Password reset rate limits", state: .closed,
				closedAt: base.addingTimeInterval(-3 * 86400), disposition: .merged),
			missi(
				number: 7, name: "Docs site build cache", state: .closed,
				closedAt: base.addingTimeInterval(-2 * 86400), disposition: .abandoned),
			missi(number: 8, name: "Slack digest bot", state: .closed),
		])
		let byNumber = Dictionary(uniqueKeysWithValues: NavigatorModel.make(store: store, query: "").archived.map {
			($0.number, $0.stateLabel)
		})
		XCTAssertEqual(byNumber[6], "Merged")
		XCTAssertEqual(byNumber[7], "Abandoned")
		XCTAssertEqual(byNumber[8], "Archived")
	}

	func testArchivedNilClosedAtSortsLast() {
		let store = storeFor(missions: [
			missi(number: 8, name: "Undated", state: .closed),
			missi(
				number: 6, name: "Older", state: .closed,
				closedAt: base.addingTimeInterval(-3 * 86400), disposition: .merged),
			missi(
				number: 7, name: "Newer", state: .closed,
				closedAt: base.addingTimeInterval(-86400), disposition: .merged),
		])
		XCTAssertEqual(NavigatorModel.make(store: store, query: "").archived.map(\.number), [7, 6, 8])
	}

	func testSelectCallsOnSelectAndClosesOverlay() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		shell.navigatorVisible = true
		var selected: Selection?
		let overlay = NavigatorOverlay(
			model: NavigatorModel.make(store: store, query: ""),
			shell: shell,
			onSelect: { selected = $0 })
		let row = try XCTUnwrap(NavigatorModel.make(store: store, query: "").open.first)
		overlay.select(row)
		XCTAssertEqual(selected, .mission(row.id))
		XCTAssertFalse(shell.navigatorVisible)
	}

	func testOverlayAndTriggerBuild() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		let overlay = NavigatorOverlay(
			model: NavigatorModel.make(store: store, query: ""),
			shell: shell,
			onSelect: { _ in })
		_ = overlay
		let overlayLabels = Mirror(reflecting: overlay).children.compactMap(\.label)
		XCTAssertTrue(overlayLabels.contains("model"))
		XCTAssertTrue(overlayLabels.contains("shell"))
		XCTAssertTrue(overlayLabels.contains("onSelect"))
		let trigger = NavigatorEdgeTrigger(shell: shell)
		_ = trigger
		XCTAssertEqual(Mirror(reflecting: trigger).children.compactMap(\.label), ["shell"])
	}

	// MARK: - Helpers

	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	private let workspaceId = "git:github.com/acme/widget"

	/// The recorded fixture snapshot in a store: the only data tests use,
	/// except the synthetic mission/workspace sets below.
	private func fixtureStore() async throws -> Store {
		let client = FixtureNodeClient()
		let snapshot = try await client.snapshot()
		let store = Store()
		store.replace(snapshot: snapshot)
		return store
	}

	private func missi(
		number: Int,
		name: String,
		state: MissionState,
		closedAt: Date? = nil,
		disposition: Disposition? = nil
	) -> Mission {
		Mission(
			id: "m-\(number)", number: number, workspaceId: workspaceId, machineId: "m1",
			name: name, objective: "objective \(number)", changes: [], lead: .leader,
			agentIds: [], access: .readWrite, worktree: nil, state: state, attention: nil,
			createdAt: base.addingTimeInterval(Double(number) * 3600),
			closedAt: closedAt, disposition: disposition, closeReason: nil,
			integration: nil, continuesMissionId: nil)
	}

	/// A store with exactly `missions` and one workspace, for query and
	/// machine-menu rules the fixture cannot express.
	private func storeFor(
		missions: [Mission],
		roots: [WorkspaceRoot]? = nil,
		machineId: MachineId = "m1"
	) -> Store {
		let store = Store()
		store.replace(snapshot: Snapshot(
			machine: Machine(id: machineId, name: "machine", createdAt: base),
			workspaces: [Workspace(
				id: workspaceId, kind: .git, name: "widget",
				remote: "git@github.com:acme/widget.git",
				roots: roots ?? [WorkspaceRoot(machineId: machineId, path: "/vol/a")],
				createdAt: base)],
			leaders: [Leader(
				workspaceId: workspaceId, machineId: machineId,
				sessionId: "s-leader", provider: "fake", model: "test-model",
				mode: .lead, modeSince: base, modeActiveMs: 0,
				activeMissionId: nil, state: .idle)],
			missions: missions, hasOlder: false, agents: [],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base))
		return store
	}
}
