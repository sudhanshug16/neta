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

	/// The empty state is the leader and Now alone: no chips, and no divider
	/// with nothing after it. The divider only separates something from
	/// something.
	func testEmptyStoreBarHasNowButNoMissionsAndNoDivider() {
		let store = Store()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		XCTAssertEqual(items.count, 1)
		for item in items {
			switch item {
			case .waiting, .running:
				XCTFail("empty store shows no mission chips")
			case .divider:
				XCTFail("a divider with nothing after it")
			case .leader, .now:
				break
			}
		}
	}

	/// With missions behind it the divider is back, in front of the chips.
	func testDividerReturnsWhenMissionsFollowIt() async throws {
		let store = try await fixtureStore()
		let items = MissionBarModel.items(
			missions: store.missions, leader: store.leader, nowLit: true)
		let divider = try XCTUnwrap(items.firstIndex(of: .divider))
		let firstChip = try XCTUnwrap(items.firstIndex { item in
			switch item {
			case .waiting, .running: return true
			case .leader, .now, .divider: return false
			}
		})
		XCTAssertEqual(firstChip, divider + 1)
	}

	/// Escape resolves along the focused responder chain, so the root view
	/// carries the same pair the canvas does: close the top overlay, else
	/// return the selection to the leader. With focus in the composer or the
	/// navigator the canvas's own handler never runs.
	func testRootEscapeDismissesThenReturnsSelectionToTheLeader() async throws {
		let client = FixtureNodeClient()
		let store = try await fixtureStore()
		let shell = ShellState()
		let view = RootView(store: store, shell: shell, client: client)
		let missionId = try XCTUnwrap(store.missions.first).id
		shell.select(.mission(missionId))
		shell.showNavigator()
		view.handleEscape()
		XCTAssertFalse(shell.navigatorVisible)
		XCTAssertEqual(
			shell.selection, .mission(missionId),
			"the overlay goes first, the selection stays")
		view.handleEscape()
		XCTAssertEqual(shell.selection, .leader)
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

	// MARK: - One chat panel model, one workspace's work

	/// `RootView` owns the chat panel's state in `@State` and hands it in.
	///
	/// The body reads `store.missions` and `store.leader`, so every `state`
	/// notification re-evaluates it. A `ChatPanelModel` built inside `body`
	/// was replaced on the first live update, taking the transcript, the
	/// typed draft and the open inspector with it and leaving the new
	/// transcript untailed — the FIXPASS blocker. There is no convenience
	/// initializer on `ChatPanel` that can rebuild one, so the mistake
	/// cannot be made again from a view body.
	func testRootViewOwnsOneChatPanelModel() throws {
		let root = try source(named: "Shell/RootView.swift")
		XCTAssertTrue(
			root.contains("@State private var chatModel: ChatPanelModel"),
			"the panel model is owned by the view, not rebuilt in its body")
		XCTAssertTrue(
			root.contains("_chatModel = State(initialValue: ChatPanelModel("),
			"and built once, in init")
		XCTAssertTrue(
			root.contains("ChatPanel(model: chatModel, router: router"),
			"the body hands the model and the canvas's checkpoint router in")
		let panel = try source(named: "Chat/ChatPanel.swift")
		XCTAssertFalse(
			panel.contains("self.init(\n\t\t\tmodel: ChatPanelModel("),
			"no convenience init can build a model inside a body")
		XCTAssertEqual(
			panel.components(separatedBy: "ChatPanelModel(").count - 1, 0,
			"ChatPanel never constructs its own model")
	}

	/// The shell draws one workspace: the Node lists every open workspace in
	/// one snapshot (a second `neta` command in another repo is enough), and
	/// two of them interleaved put two `#1`s in the bar and two sequences
	/// through each other on the spine.
	func testTheMissionBarShowsOnlyTheCurrentWorkspace() {
		let store = twoWorkspaceStore()
		let items = MissionBarModel.items(
			missions: store.currentMissions, leader: store.leader, nowLit: true)
		let numbers = items.compactMap { item -> Int? in
			switch item {
			case .waiting(let mission), .running(let mission): mission.number
			case .leader, .now, .divider: nil
			}
		}
		XCTAssertEqual(numbers, [1], "the other workspace's #1 is not in the bar")
		XCTAssertEqual(Set(numbers).count, numbers.count, "never two #1s")
		if case .leader(let name, _) = items[0] {
			XCTAssertEqual(name, "Halden", "the current workspace's leader")
		} else {
			XCTFail("first mission-bar item is the workspace leader")
		}
		store.setCurrentWorkspace("w2")
		XCTAssertEqual(store.currentMissions.map(\.name), ["theirs"])
	}

	// MARK: - Helpers

	/// Two open workspaces, each with a leader, a mission numbered 1 and an
	/// agent — the shape the runtime check found the moment any `neta`
	/// command ran in a second repo.
	private func twoWorkspaceStore() -> Store {
		let base = Date(timeIntervalSince1970: 1_780_315_200)
		func workspace(_ id: String, _ name: String) -> Workspace {
			Workspace(
				id: id, kind: .git, name: name, remote: nil, roots: [],
				createdAt: base)
		}
		func leader(_ workspaceId: String, _ name: String) -> Leader {
			Leader(
				workspaceId: workspaceId, machineId: "m1", name: name,
				sessionId: "s-\(workspaceId)", provider: "Claude",
				model: "claude-opus-5", mode: .lead, modeSince: base,
				modeActiveMs: 0, activeMissionId: nil, state: .idle)
		}
		func mission(_ id: String, _ workspaceId: String, _ name: String) -> Mission {
			Mission(
				id: id, number: 1, workspaceId: workspaceId, machineId: "m1",
				name: name, objective: "Objective.", changes: [], lead: .leader,
				agentIds: [], access: .readOnly, worktree: nil, state: .running,
				attention: nil, createdAt: base, closedAt: nil,
				disposition: nil, closeReason: nil, integration: nil,
				continuesMissionId: nil)
		}
		func agent(_ id: String, _ missionId: String, _ workspaceId: String) -> Agent {
			Agent(
				id: id, missionId: missionId, workspaceId: workspaceId,
				name: id, task: "Task.", access: .readOnly, provider: "fake",
				model: "test-model", skills: [], sessionId: "s-\(id)",
				canSpawn: false, state: .running, stateBefore: nil,
				activity: nil, pendingQuestion: nil, startedAt: base,
				endedAt: nil, outcome: nil)
		}
		let store = Store()
		store.replace(snapshot: Snapshot(
			machine: Machine(id: "m1", name: "mac-studio", createdAt: base),
			workspaces: [workspace("w1", "NoScrubs"), workspace("w2", "neta")],
			leaders: [leader("w1", "Halden"), leader("w2", "Hazel")],
			missions: [mission("m1", "w1", "ours"), mission("m2", "w2", "theirs")],
			hasOlder: false,
			agents: [agent("a1", "m1", "w1"), agent("a2", "m2", "w2")],
			completedCounts: [:],
			events: [
				Event(
					seq: 1, at: base, workspaceId: "w1", kind: .missionCreated,
					missionId: "m1", agentId: nil, sessionId: nil, turnId: nil,
					data: [:]),
				Event(
					seq: 2, at: base, workspaceId: "w2", kind: .missionCreated,
					missionId: "m2", agentId: nil, sessionId: nil, turnId: nil,
					data: [:]),
			],
			attention: [], windowDays: 14, protocolVersion: 1, at: base))
		XCTAssertEqual(store.currentWorkspaceId, "w1")
		return store
	}

	private func source(named relative: String) throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/\(relative)")
		return try String(contentsOf: url, encoding: .utf8)
	}

	private func fixtureStore() async throws -> Store {
		let client = FixtureNodeClient()
		let store = Store()
		store.replace(snapshot: try await client.snapshot())
		return store
	}
}
