import Foundation
import XCTest

@testable import NetaDesktop

/// T9.9 contract: leader, Now, divider, waiting grouped blocked, failed,
/// readyToClose, mergedNotClosed by number ascending, then running by number
/// ascending; closed never appear; every waiting item has a text state label;
/// `now(label:lit:)` carries both halves of 10's Now state.
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
		XCTAssertEqual(items[1], .now(label: "Now", lit: true))
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

	func testBlockedAgentPromotesRunningMissionToAttentionWithoutMutatingStore() async throws {
		let store = try await fixtureStore()
		let mission = try XCTUnwrap(store.missions.first(where: { $0.state == .running }))
		let original = try XCTUnwrap(store.agentsById.values.first)
		let blocked = Agent(
			id: original.id, missionId: mission.id, workspaceId: mission.workspaceId,
			name: original.name, task: original.task, access: original.access,
			provider: original.provider, model: original.model, skills: original.skills,
			sessionId: original.sessionId, canSpawn: original.canSpawn, state: .blocked,
			stateBefore: original.stateBefore, activity: original.activity,
			pendingQuestion: "Needs a decision", startedAt: original.startedAt,
			endedAt: original.endedAt, outcome: original.outcome)
		let items = MissionBarModel.items(
			missions: [mission], leader: store.leader, agents: [blocked], nowLit: true)
		let presented = try XCTUnwrap(items.first { if case .waiting = $0 { true } else { false } })
		XCTAssertEqual(presented.stateLabel, "Blocked")
		XCTAssertEqual(mission.state, .running, "attention is presentation state only")
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

	/// The Now item carries both halves of 10's `NowState`: the label and
	/// the lit flag. A bar that only took the flag could never show
	/// `Now · 3h back`, which is the whole second state of the control.
	func testNowItemCarriesLabelAndLitFlag() async throws {
		let store = try await fixtureStore()
		XCTAssertEqual(
			MissionBarModel.items(
				missions: store.missions, leader: store.leader, nowLit: true)[1],
			.now(label: "Now", lit: true))
		let back = MissionBarModel.items(
			missions: store.missions, leader: store.leader,
			nowLabel: "Now · 3h back", nowLit: false)
		XCTAssertEqual(back[1], .now(label: "Now · 3h back", lit: false))
		XCTAssertEqual(back[1].stateLabel, "Now · 3h back")
		// The label is the state; the flag alone never carries it.
		XCTAssertNotEqual(back[1], .now(label: "Now", lit: false))
	}

	func testNilLeaderOmitsLeaderItem() async throws {
		let store = try await fixtureStore()
		let items = MissionBarModel.items(missions: store.missions, leader: nil, nowLit: false)
		XCTAssertEqual(items.first, .now(label: "Now", lit: false))
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
		// The recorded fixture's leader is Halden in a workspace named
		// "repo" at "git:github.com/acme/widget": the chip shows the
		// leader's own name, never anything derived from the workspace.
		XCTAssertEqual(name, "Halden")
		XCTAssertEqual(name, leader.name)
		let workspace = try XCTUnwrap(store.workspaces.first)
		XCTAssertNotEqual(name, workspace.name)
		XCTAssertFalse(leader.workspaceId.contains(name))
		XCTAssertEqual(mode, leader.mode)
	}

	func testDisplayNameIsTheRecordNameAndFallsBackWithoutALeader() async throws {
		let store = try await fixtureStore()
		let leader = try XCTUnwrap(store.leader)
		XCTAssertEqual(MissionBarModel.leaderDisplayName(leader), "Halden")
		XCTAssertEqual(MissionBarModel.leaderDisplayName(nil), "Leader")
	}

	func testViewBuildsAndStoresNoControlState() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		var selected: Selection?
		var jumped = false
		let view = MissionBarView(
			items: items, selection: shell.selection,
			onSelect: { selected = $0 }, onNow: { jumped = true })
		_ = view
		// The view holds items, selection and the two callbacks only: no
		// counts, no cards, and never the Lead/Lead++ control.
		let labels = Mirror(reflecting: view).children.compactMap(\.label).sorted()
		XCTAssertEqual(labels, ["items", "onNow", "onSelect", "selection"])
		XCTAssertNil(selected)
		XCTAssertFalse(jumped)
	}

	/// The running chip is the design's compact form — sigil, number, mint
	/// dot (PAPER-SPINE item 5, plan T9.9) — so its state label is not
	/// painted on the chip. MANIFESTO.md still forbids state carried by
	/// colour alone, so the text state has to be reachable: on hover for the
	/// pointer, on the accessibility label for VoiceOver. The file's own
	/// header used to claim every item shows a visible text label, which was
	/// false for exactly this chip.
	func testTheRunningChipHasAReachableTextState() throws {
		let source = try missionBarSource()
		XCTAssertTrue(
			source.contains(##".help("#\(mission.number) \(mission.name) · Running")"##),
			"the compact running chip says Running on hover")
		XCTAssertTrue(
			source.contains(##".accessibilityLabel("#\(mission.number) \(mission.name), Running")"##),
			"and to VoiceOver")
		XCTAssertFalse(
			source.contains("Every state-carrying item shows a text state label"),
			"the header no longer claims a visible label the chip does not have")
	}

	/// The leader mark has ONE definition. The bar's crown carried a
	/// `Color.white` and a `.system(size:weight:)` literal while the canvas
	/// leader card routed the same glyph through `Theme` — the two literals
	/// `NodeViewTests.testNodeViewsCarryNoColourOrFontLiterals` forbids there.
	func testTheLeaderCrownTakesItsColourAndFontFromTheme() throws {
		let source = try missionBarSource()
		XCTAssertFalse(source.contains("Color.white"), "no colour literal")
		XCTAssertFalse(
			source.contains(".system(size: 13"), "no font literal on the crown")
		XCTAssertTrue(
			source.contains(##"Image(systemName: "crown.fill")"##))
		XCTAssertTrue(source.contains(".font(Theme.text(13, .semibold))"))
		XCTAssertTrue(source.contains(".foregroundStyle(Theme.textPrimary)"))
	}

	// MARK: - Helpers

	private func missionBarSource() throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/Shell/MissionBar.swift")
		return try String(contentsOf: url, encoding: .utf8)
	}

	/// The recorded fixture snapshot in a store: the only data tests use.
	private func fixtureStore() async throws -> Store {
		let client = FixtureNodeClient()
		let snapshot = try await client.snapshot()
		let store = Store()
		store.replace(snapshot: snapshot)
		return store
	}
}
