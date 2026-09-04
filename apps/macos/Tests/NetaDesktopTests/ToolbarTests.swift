import Foundation
import XCTest

@testable import NetaDesktop

/// T9.8 contract: `machines` is nil for a single-machine workspace and lists
/// one entry per machine otherwise; `zoomPercent` tracks `shell.timeZoom`; the
/// model carries no mission, agent or mode field.
@MainActor
final class ToolbarTests: XCTestCase {
	func testSingleRootGivesNoMachines() async throws {
		let store = try await fixtureStore()
		let model = ToolbarModel.make(store: store, shell: ShellState())
		XCTAssertEqual(model.workspaces.count, 1)
		XCTAssertNil(model.machines)
	}

	func testTwoRootsOnTwoMachinesGiveTwoEntries() throws {
		let store = storeFor(roots: [
			WorkspaceRoot(machineId: "m1", path: "/vol/a"),
			WorkspaceRoot(machineId: "m2", path: "/vol/b"),
		])
		let model = ToolbarModel.make(store: store, shell: ShellState())
		let machines = try XCTUnwrap(model.machines)
		XCTAssertEqual(machines.map(\.id), ["m1", "m2"])
		// The connected machine keeps its identity; the other surfaces
		// under its id (the store knows no more about it).
		XCTAssertEqual(machines.first(where: { $0.id == "m1" })?.name, "machine")
	}

	func testTwoRootsOnOneMachineGiveNoMachines() throws {
		let store = storeFor(roots: [
			WorkspaceRoot(machineId: "m1", path: "/vol/a"),
			WorkspaceRoot(machineId: "m1", path: "/vol/b"),
		])
		XCTAssertNil(ToolbarModel.make(store: store, shell: ShellState()).machines)
	}

	func testZoomPercentTracksShell() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		XCTAssertEqual(ToolbarModel.make(store: store, shell: shell).zoomPercent, 100)
		shell.zoomIn()
		XCTAssertEqual(ToolbarModel.make(store: store, shell: shell).zoomPercent, 125)
		shell.zoomOut()
		XCTAssertEqual(ToolbarModel.make(store: store, shell: shell).zoomPercent, 100)
		shell.zoomOut()
		XCTAssertEqual(
			ToolbarModel.make(store: store, shell: shell).zoomPercent,
			shell.zoomPercent)
	}

	func testSelectionIdsFollowLeader() async throws {
		let store = try await fixtureStore()
		let model = ToolbarModel.make(store: store, shell: ShellState())
		XCTAssertEqual(model.selectedWorkspaceId, store.leader?.workspaceId)
		XCTAssertEqual(model.selectedMachineId, store.leader?.machineId)
	}

	func testFixtureModelCarriesNoMissionAgentOrModeField() async throws {
		let store = try await fixtureStore()
		let model = ToolbarModel.make(store: store, shell: ShellState())
		let labels = Mirror(reflecting: model).children.compactMap(\.label).sorted()
		XCTAssertEqual(
			labels,
			["machines", "selectedMachineId", "selectedWorkspaceId", "workspaces", "zoomPercent"])
	}

	func testCapsuleBuildsFromModel() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		_ = ToolbarCapsule(model: ToolbarModel.make(store: store, shell: shell), shell: shell)
	}

	// MARK: - Helpers

	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	private let workspaceId = "git:github.com/acme/widget"

	/// The recorded fixture snapshot in a store: the only data tests use,
	/// except the synthetic multi-root workspaces below.
	private func fixtureStore() async throws -> Store {
		let client = FixtureNodeClient()
		let snapshot = try await client.snapshot()
		let store = Store()
		store.replace(snapshot: snapshot)
		return store
	}

	/// A store whose workspace has exactly `roots`, for the machine-menu rule.
	private func storeFor(roots: [WorkspaceRoot], machineId: MachineId = "m1") -> Store {
		let store = Store()
		store.replace(snapshot: Snapshot(
			machine: Machine(id: machineId, name: "machine", createdAt: base),
			workspaces: [Workspace(
				id: workspaceId, kind: .git, name: "widget",
				remote: "git@github.com:acme/widget.git", roots: roots,
				createdAt: base)],
			leaders: [Leader(
				workspaceId: workspaceId, machineId: machineId,
				name: "Halden",
				sessionId: "s-leader", provider: "fake", model: "test-model",
				mode: .lead, modeSince: base, modeActiveMs: 0,
				activeMissionId: nil, state: .idle)],
			missions: [], hasOlder: false, agents: [],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base))
		return store
	}
}
