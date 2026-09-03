import Foundation
import XCTest

@testable import NetaDesktop

/// T9.6 contract: selection resolves to the right session id against a
/// fixture-backed store, unknown ids fall back to `.leader`, selecting never
/// moves `chatVisible`, `dismissOverlay` closes the navigator (false when
/// nothing is open), zoom clamps in x1.25 steps, `fit` resets and bumps
/// `fitRequested`.
@MainActor
final class ShellStateTests: XCTestCase {
	func testLeaderSelectionResolvesToLeaderSession() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		XCTAssertEqual(shell.selection, .leader)
		let sessionId = shell.sessionId(in: store)
		XCTAssertNotNil(store.leader)
		XCTAssertEqual(sessionId, store.leader?.sessionId)
	}

	func testMissionSelectionResolvesToLeadSession() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		// Every recorded mission is leader-led: it resolves to the leader.
		let mission = try XCTUnwrap(store.missions.first)
		shell.select(.mission(mission.id))
		XCTAssertEqual(shell.sessionId(in: store), store.leader?.sessionId)
		// An agent-led mission resolves to its lead agent's session.
		let agent = try XCTUnwrap(store.agentsById.values.first)
		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(relead(mission, to: agent.id)))))
		shell.select(.mission(mission.id))
		XCTAssertEqual(shell.sessionId(in: store), agent.sessionId)
	}

	func testAgentSelectionResolvesToAgentSession() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		let agent = try XCTUnwrap(store.agentsById.values.first)
		shell.select(.agent(agent.id))
		XCTAssertEqual(shell.sessionId(in: store), agent.sessionId)
	}

	func testUnknownIdFallsBackToLeader() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		shell.select(.mission("no-such-mission"))
		XCTAssertNil(shell.sessionId(in: store))
		XCTAssertEqual(shell.selection, .leader)
		shell.select(.agent("no-such-agent"))
		XCTAssertNil(shell.sessionId(in: store))
		XCTAssertEqual(shell.selection, .leader)
		// After the fallback the leader still resolves.
		XCTAssertEqual(shell.sessionId(in: store), store.leader?.sessionId)
	}

	func testSelectingNeverChangesChatVisible() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		let mission = try XCTUnwrap(store.missions.first)
		let agent = try XCTUnwrap(store.agentsById.values.first)
		for visible in [true, false] {
			shell.chatVisible = visible
			shell.select(.leader)
			XCTAssertEqual(shell.chatVisible, visible)
			shell.select(.mission(mission.id))
			XCTAssertEqual(shell.chatVisible, visible)
			shell.select(.agent(agent.id))
			XCTAssertEqual(shell.chatVisible, visible)
		}
	}

	func testDismissOverlayClosesNavigator() {
		let shell = ShellState()
		shell.navigatorVisible = true
		XCTAssertTrue(shell.dismissOverlay())
		XCTAssertFalse(shell.navigatorVisible)
		XCTAssertFalse(shell.dismissOverlay())
	}

	func testDismissOverlayReleasesComposerFocus() {
		let shell = ShellState()
		shell.composerFocused = true
		XCTAssertTrue(shell.dismissOverlay())
		XCTAssertFalse(shell.composerFocused)
		XCTAssertFalse(shell.dismissOverlay())
	}

	func testZoomMovesInQuarterStepsAndClamps() {
		let shell = ShellState()
		XCTAssertEqual(shell.zoomPercent, 100)
		shell.zoomIn()
		XCTAssertEqual(shell.timeZoom, 1.25, accuracy: 1e-9)
		XCTAssertEqual(shell.zoomPercent, 125)
		shell.zoomOut()
		XCTAssertEqual(shell.timeZoom, 1.0, accuracy: 1e-9)
		for _ in 0 ..< 20 { shell.zoomIn() }
		XCTAssertEqual(shell.timeZoom, ShellState.maxZoom)
		XCTAssertTrue(shell.zoomWithinBounds)
		for _ in 0 ..< 40 { shell.zoomOut() }
		XCTAssertEqual(shell.timeZoom, ShellState.minZoom)
	}

	func testFitResetsZoomAndBumpsFitRequested() {
		let shell = ShellState()
		XCTAssertEqual(shell.fitRequested, 0)
		shell.zoomIn()
		shell.fit()
		XCTAssertEqual(shell.timeZoom, 1.0)
		XCTAssertEqual(shell.fitRequested, 1)
		XCTAssertEqual(shell.zoomPercent, 100)
		shell.fit()
		XCTAssertEqual(shell.fitRequested, 2)
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

	/// A copy of `mission` led by `agentId` instead of the leader.
	private func relead(_ mission: Mission, to agentId: Ulid) -> Mission {
		Mission(
			id: mission.id, number: mission.number,
			workspaceId: mission.workspaceId, machineId: mission.machineId,
			name: mission.name, objective: mission.objective,
			changes: mission.changes, lead: .agent(agentId: agentId),
			agentIds: mission.agentIds + [agentId], access: mission.access,
			worktree: mission.worktree, state: mission.state,
			attention: mission.attention, createdAt: mission.createdAt,
			closedAt: mission.closedAt, disposition: mission.disposition,
			closeReason: mission.closeReason, integration: mission.integration,
			continuesMissionId: mission.continuesMissionId)
	}
}

private extension ShellState {
	/// The clamp holds at both ends after repeated stepping.
	var zoomWithinBounds: Bool {
		timeZoom <= ShellState.maxZoom && timeZoom >= ShellState.minZoom
	}
}
