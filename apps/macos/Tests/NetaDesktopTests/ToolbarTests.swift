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

	/// The zoom readout is mono tabular, the labels are 12/600, and the
	/// menus carry an SF Symbol chevron instead of a literal glyph.
	func testZoomTextIsMonoTabularAndMenusUseASymbolChevron() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		XCTAssertEqual(ToolbarModel.make(store: store, shell: shell).zoomText, "100%")
		shell.zoomIn()
		XCTAssertEqual(ToolbarModel.make(store: store, shell: shell).zoomText, "125%")
		let source = try toolbarSource()
		XCTAssertTrue(
			source.contains("Theme.mono(10, .semibold)"), "zoom readout is 10/600 mono")
		XCTAssertFalse(source.contains("▾"), "menus use an SF Symbol chevron")
		XCTAssertTrue(source.contains("chevron.down"))
		XCTAssertTrue(source.contains("Theme.text(12, .semibold)"), "labels are 12/600")
		XCTAssertFalse(source.contains("Divider()"), "rules are Theme.divider hairlines")
		XCTAssertTrue(source.contains("netaGlass(.rounded(controlRadius)"), "concentric glass")
	}

	/// The chevron has to trail the name (BRIEF: `NoScrubs ▾`). With
	/// `.menuStyle(.borderlessButton)` AppKit drew its own indicator at the
	/// LEADING edge and clipped our label's chevron, so the toolbar read
	/// `⌄ repo` in the render; `.menuStyle(.button)` with a plain button
	/// style draws the label as written.
	func testMenuLabelsDrawTheirOwnTrailingChevron() throws {
		for source in [try toolbarSource(), try composerViewSource()] {
			XCTAssertFalse(
				source.contains("menuStyle(.borderlessButton)"),
				"that style draws a leading indicator over our label")
			XCTAssertTrue(source.contains("menuStyle(.button)"))
			XCTAssertTrue(source.contains("menuIndicator(.hidden)"))
		}
		let toolbar = try toolbarSource()
		let label = try XCTUnwrap(
			toolbar.range(of: "private func menuLabel"))
		let body = String(toolbar[label.lowerBound...].prefix(400))
		let text = try XCTUnwrap(body.range(of: "Text(text)"))
		let chevron = try XCTUnwrap(body.range(of: "chevron.down"))
		XCTAssertLessThan(
			text.lowerBound, chevron.lowerBound,
			"the name comes first, the chevron trails it")
	}

	/// A menu that lists rows which do nothing when clicked is a control
	/// that lies about what it does. The workspace menu acts — through the
	/// same one body the navigator's workspace rows use — and the machine,
	/// which nothing in the app can switch, is drawn as a label instead of a
	/// menu.
	func testTheWorkspaceMenuActsAndTheMachineIsNotAMenu() throws {
		let source = try toolbarSource()
		XCTAssertTrue(
			source.contains("Button(workspace.name) { onSelectWorkspace(workspace.id) }"),
			"picking a workspace moves the shell")
		XCTAssertFalse(
			source.contains("Button(machine.name)"),
			"the machine level is a label, not a dead menu")
		XCTAssertEqual(
			source.components(separatedBy: "Menu {").count - 1, 1,
			"one menu in the toolbar: the workspace")
		let root = try rootViewSource()
		XCTAssertTrue(
			root.contains("NavigatorOverlay.selectWorkspace($0, store: store, shell: shell)"),
			"and it is the navigator's own selectWorkspace body, not a second one")
	}

	/// The capsule floats over the canvas ground and takes Revision 3's outer
	/// shadow; the controls inside it sit on the capsule and must not, or
	/// each one casts a 40 pt shadow onto its own host.
	///
	/// Elevation follows the silhouette (see the rule in Theme/Glass.swift):
	/// the capsule is `.capsule` and floats, its four nested controls are
	/// `.rounded(controlRadius)` and do not. Nothing here names an elevation.
	func testOnlyTheCapsuleItselfIsElevated() throws {
		let source = try toolbarSource()
		XCTAssertEqual(
			occurrences(of: "netaGlass(.capsule)", in: source), 1,
			"exactly one floating surface: the capsule")
		XCTAssertEqual(
			occurrences(of: "netaGlass(.rounded(controlRadius))", in: source), 4,
			"the nested controls stay on the concentric radius, and so stay flat")
		XCTAssertEqual(
			occurrences(of: "netaFloatingGlass(", in: source), 0,
			"the capsule silhouette already floats; no escape hatch needed")
		XCTAssertEqual(
			occurrences(of: "netaControlGlass(", in: source), 0,
			"and no nested control needs one either")
	}

	/// The capsule's nested controls are concentric with the capsule, whose
	/// radius is half its own height — not with `Theme.Metric.barRadius`,
	/// which is the mission bar's shape.
	func testControlRadiusDerivesFromTheCapsuleNotTheMissionBar() throws {
		let source = try toolbarSource()
		XCTAssertFalse(
			source.contains("Theme.Metric.barRadius"),
			"the toolbar does not borrow the mission bar's radius")
		XCTAssertTrue(
			source.contains("Theme.Metric.concentric(outer: Self.height / 2"),
			"nested radius comes from the capsule's own half height")
		XCTAssertFalse(source.contains("Theme.Glass.rimWidth"), "rules take the rule width")
		// 26 pt hit floor + 6 pt padding on each side = 38 tall, so the
		// capsule's radius is 19 and the nested controls sit at 11.
		XCTAssertEqual(
			Theme.Metric.concentric(
				outer: (Theme.Metric.minHitHeight + 6 * 2) / 2, padding: 8),
			11)
	}

	// MARK: - Helpers

	private func occurrences(of token: String, in contents: String) -> Int {
		contents.components(separatedBy: token).count - 1
	}

	private func composerViewSource() throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/Chat/ComposerView.swift")
		return try String(contentsOf: url, encoding: .utf8)
	}

	private func rootViewSource() throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/Shell/RootView.swift")
		return try String(contentsOf: url, encoding: .utf8)
	}

	private func toolbarSource() throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/Shell/ToolbarCapsule.swift")
		return try String(contentsOf: url, encoding: .utf8)
	}

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
