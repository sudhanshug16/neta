import Foundation
import XCTest

@testable import NetaDesktop

/// A client that counts what a transcript actually did: `conversation.tail`
/// per session, and one live `notifications` subscription per running
/// stream. A transcript that was installed but never started counts zero of
/// both, which is exactly what an unstarted rebuild leaves behind.
private final class CountingNodeClient: NodeClient, @unchecked Sendable {
	private let hub = NotificationHub()
	private let lock = NSLock()
	private var tails: [SessionId: Int] = [:]

	var notifications: AsyncStream<NodeNotification> { hub.subscribe() }
	var subscriberCount: Int { hub.subscriberCount }

	func tailCount(_ sessionId: SessionId) -> Int {
		lock.withLock { tails[sessionId] ?? 0 }
	}

	func emit(_ notification: NodeNotification) { hub.broadcast(notification) }

	func conversationTail(
		sessionId: Ulid, cursor: String?, limit: Int, direction: String?, turnId: TurnId?
	) async throws -> ConversationPage {
		lock.withLock { tails[sessionId, default: 0] += 1 }
		return ConversationPage(turns: [], blocks: [], nextCursor: nil, prevCursor: nil)
	}

	func connect() async throws {}
	func snapshot() async throws -> Snapshot { throw NodeClientError.disconnected }
	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] { [] }
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] { [] }
	func prompt(sessionId: Ulid, text: String) async throws -> Ulid { "t-new" }
	func cancel(sessionId: Ulid) async throws {}
	func setModel(sessionId: Ulid, model: String) async throws {}
	func listModels(provider: String) async throws -> [ModelInfo] { [] }
	func setMode(workspaceId: String, mode: LeaderMode) async throws {}
	func pin(missionId: Ulid, pinned: Bool) async throws {}
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {}
}

/// T11.8: the panel owns one transcript plus one composer per selection —
/// `select` rebuilds both, `scrollTo` forwards, `isDetailsOpen` toggles the
/// inspector, and the panel view builds over every placement.
@MainActor
final class ChatPanelTests: XCTestCase {
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	// The workspace is NoScrubs; the leader is Halden. Nothing may
	// derive the leader's name from the workspace.
	private let workspaceId = "git:github.com/acme/NoScrubs"

	func testSelectRebuildsBothViewModels() {
		let shell = ShellState()
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: shell)
		XCTAssertEqual(model.selection, .leader)
		XCTAssertEqual(model.sessionId, "s-leader")
		let firstTranscript = model.transcript
		let firstComposer = model.composer
		model.select(.agent("ag-thane"))
		XCTAssertEqual(model.selection, .agent("ag-thane"))
		XCTAssertEqual(model.shell.selection, .agent("ag-thane"))
		XCTAssertEqual(model.sessionId, "s-ag-thane")
		XCTAssertTrue(model.transcript !== firstTranscript, "select rebuilds the transcript")
		XCTAssertTrue(model.composer !== firstComposer, "select rebuilds the composer")
		XCTAssertTrue(model.transcript.turns.isEmpty, "the rebuilt transcript starts empty")
		XCTAssertEqual(model.composer.placeholder, "Message Thane")
	}

	func testSelectMissionResolvesTheLeadSession() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.select(.mission("m304"))
		XCTAssertEqual(model.sessionId, "s-leader", "a leader-led mission opens the leader session")
		model.select(.mission("m305"))
		XCTAssertEqual(model.sessionId, "s-ag-quill", "an agent-led mission opens the lead session")
	}

	func testSelectUnknownIdFallsBackToLeaderSession() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.select(.mission("no-such-mission"))
		XCTAssertEqual(model.sessionId, "s-leader")
		model.select(.agent("no-such-agent"))
		XCTAssertEqual(model.sessionId, "s-leader")
	}

	func testScrollToForwardsLoadedTurnAndConsumes() async {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.transcript.apply(TurnChange(
			sessionId: "s-leader",
			turn: Turn(
				id: "t1", sessionId: "s-leader",
				startedAt: base, endedAt: nil, role: .agent, cancelled: nil),
			block: nil))
		await model.scrollTo(turnId: "t1")
		XCTAssertEqual(
			model.transcript.pendingScroll,
			ScrollRequest(turnId: "t1", flash: true))
		XCTAssertEqual(
			model.transcript.consumeScroll(),
			ScrollRequest(turnId: "t1", flash: true))
		XCTAssertNil(model.transcript.consumeScroll(), "consumeScroll drains the request")
	}

	func testIsDetailsOpenDefaultsClosed() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		XCTAssertFalse(model.isDetailsOpen)
		model.isDetailsOpen = true
		XCTAssertTrue(model.isDetailsOpen)
	}

	func testArchivedAgentMarksComposerReadOnly() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.select(.agent("ag-old"))
		XCTAssertTrue(model.composer.isArchived)
		XCTAssertEqual(model.composer.button, .none)
		XCTAssertEqual(model.composer.placeholder, "Read-only · archived")
	}

	func testOpenTurnSyncsComposerToStop() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		XCTAssertFalse(model.composer.hasOpenTurn)
		model.transcript.apply(TurnChange(
			sessionId: "s-leader",
			turn: Turn(
				id: "t1", sessionId: "s-leader",
				startedAt: base, endedAt: nil, role: .agent, cancelled: nil),
			block: nil))
		model.syncComposer()
		XCTAssertTrue(model.composer.hasOpenTurn)
		XCTAssertEqual(model.composer.button, .stop)
	}

	func testPanelBuildsAcrossPlacements() {
		let live = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		_ = ChatPanel(model: live, windowWidth: 1100)
		_ = ChatPanel(model: live, windowWidth: 1600)
		live.isDetailsOpen = true
		_ = ChatPanel(model: live, windowWidth: 1100)
		_ = ChatPanel(model: live, windowWidth: 1600)
		let shell = ShellState()
		shell.select(.agent("ag-thane"))
		_ = ChatPanel(model: ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: shell))
	}

	/// The canvas fills `CheckpointRouter` and the chat drains it
	/// (10-desktop-spine T10.8: "11 consumes this"). Nothing called
	/// `consume()` at all before this pass, so opening a checkpoint on the
	/// spine did nothing.
	func testThePanelDrainsTheCheckpointRouter() throws {
		let source = try chatPanelSource()
		XCTAssertTrue(
			source.contains(".onChange(of: router?.pending)"),
			"the panel watches the router the canvas fills")
		XCTAssertTrue(
			source.contains("router?.consume()"), "and takes the action")
		XCTAssertTrue(
			source.contains("await model.handle(action)"),
			"which the panel model turns into a scroll or an open inspector")
	}

	/// The panel follows the shell and the session, not only its own header:
	/// a canvas click moves `shell.selection` and the leader's session id
	/// arrives with the first snapshot.
	func testThePanelFollowsTheShellAndTheSession() throws {
		let source = try chatPanelSource()
		XCTAssertTrue(source.contains(".onChange(of: model.shell.selection)"))
		XCTAssertTrue(source.contains(".onChange(of: model.currentSessionId)"))
		XCTAssertTrue(
			source.contains(".onChange(of: model.transcriptId)"),
			"and restarts whichever transcript is installed, however it got there")
		XCTAssertFalse(
			source.contains(".onChange(of: model.sessionId)"),
			"a session-id watch misses a transcript replaced under an unchanged id")
	}

	/// The live end is pinned by an explicit `scrollTo`, never by
	/// `.defaultScrollAnchor(.bottom)`: that modifier moved the whole stack
	/// out of the scroll view's clip on this system, so a transcript with
	/// turns loaded and streaming drew nothing at all.
	func testTheTranscriptPinsToTheLiveEndWithoutADefaultScrollAnchor() throws {
		let source = try chatPanelSource()
		XCTAssertFalse(
			source.contains(".defaultScrollAnchor("),
			"the default scroll anchor hid the transcript entirely")
		XCTAssertTrue(
			source.contains("scroll.scrollTo(target, anchor: .bottom)"),
			"the newest drawn turn is scrolled to instead")
		XCTAssertTrue(
			source.contains(".onChange(of: model.transcript.autoScrollTarget)"),
			"and again whenever the live end moves")
	}

	/// The transcript is bottom-anchored: the newest message sits directly
	/// above the composer. Without it a two-message conversation hung from
	/// the header with the rest of the panel empty beneath it. The anchor is
	/// the scrolled content's own minimum height and alignment, so it is a
	/// value, not a modifier that hid the stack.
	func testTheTranscriptIsBottomAnchored() throws {
		XCTAssertEqual(TranscriptAnchor.alignment, .bottom)
		XCTAssertEqual(TranscriptAnchor.contentMinHeight(viewport: 640), 640)
		XCTAssertEqual(
			TranscriptAnchor.contentMinHeight(viewport: 0), 0,
			"a panel SwiftUI has not measured yet takes no minimum")
		XCTAssertEqual(TranscriptAnchor.contentMinHeight(viewport: -20), 0)
		// The `transcript` property alone, not the whole file: `body` has a
		// `GeometryReader` of its own, so a whole-file search for one passes
		// even with the transcript's deleted.
		let source = try transcriptSource()
		XCTAssertTrue(
			source.contains("minHeight: TranscriptAnchor.contentMinHeight("),
			"the scrolled content is at least the panel's height")
		XCTAssertTrue(
			source.contains("alignment: TranscriptAnchor.alignment"),
			"and sits at the bottom of it")
		XCTAssertTrue(
			source.contains("GeometryReader { proxy in"),
			"measured from the panel the transcript is drawn in")
		XCTAssertTrue(
			source.contains("proxy.size.height"),
			"and the minimum is that measurement, not a constant")
	}

	/// The design has no empty-state placeholder: an empty transcript is
	/// simply empty, and the panel's rules are Theme hairlines.
	func testPanelHasNoEmptyStateAndNoSystemDividers() throws {
		let source = try chatPanelSource()
		XCTAssertFalse(source.contains("No messages yet"), "no invented empty state")
		XCTAssertEqual(
			source.components(separatedBy: "Divider()").count - 1, 0,
			"system dividers are replaced by Theme.divider hairlines")
		XCTAssertTrue(source.contains("Theme.divider"), "rules use the divider token")
		// A rule's thickness is its own token: the glass rim is part of the
		// material and moving it must not move the panel's rules.
		XCTAssertFalse(
			source.contains("Theme.Glass.rimWidth"),
			"hairlines take Theme.Metric.ruleWidth, not the glass rim")
		XCTAssertEqual(
			source.components(separatedBy: "Theme.Metric.ruleWidth)").count - 1, 2,
			"both hairlines take the rule width")
	}

	/// The panel's horizontal padding is the value that sets the composer
	/// field's concentric radius, so every column routes through it rather
	/// than restating 12.
	func testPanelPaddingRoutesThroughTheChatPaddingToken() throws {
		let source = try chatPanelSource()
		XCTAssertFalse(
			source.contains(".padding(.horizontal, 12)"),
			"horizontal padding is Theme.Metric.chatPadding")
		XCTAssertEqual(
			source.components(separatedBy: ".padding(.horizontal, Theme.Metric.chatPadding)")
				.count - 1,
			6,
			"header, strip, composer, the transcript, and Details in both placements")
	}

	func testPanelBuildsWithAnEmptyTranscript() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		XCTAssertTrue(model.transcript.turns.isEmpty)
		_ = ChatPanel(model: model, windowWidth: 1600)
	}

	// MARK: - A rebuild is never left unstarted (round-3 blocker)

	/// Every mission a leader leads opens the leader's own session, so
	/// `.leader -> .mission(m)` moves the selection without moving the session
	/// id. The panel used to stop the live transcript and install a fresh
	/// `ChatViewModel` anyway; nothing started it (the only `start()` paths
	/// were `.task` and a session-id watch), so the conversation blanked and
	/// stayed blank and a prompt sent from that composer streamed into
	/// nothing.
	func testSelectingALeaderLedMissionLeavesTheTranscriptLive() async {
		let client = CountingNodeClient()
		let model = ChatPanelModel(client: client, store: store(), shell: ShellState())
		await model.start()
		XCTAssertEqual(client.tailCount("s-leader"), 1, "the panel tailed the leader")
		XCTAssertTrue(model.transcript.isStreaming)
		XCTAssertEqual(client.subscriberCount, 1, "on one subscription")

		model.select(.mission("m304"))

		XCTAssertEqual(model.sessionId, "s-leader", "the leader leads #304")
		XCTAssertTrue(
			model.transcript.isStreaming,
			"the transcript the panel now shows has tailed and is streaming")
		client.emit(.turn(TurnChange(
			sessionId: "s-leader", turn: nil,
			block: Block(
				turnId: "t-live", seq: 0, at: base, role: .agent, kind: .text,
				text: "still streaming", data: nil))))
		let landed = await waitUntil {
			model.transcript.turns.contains { $0.id == "t-live" }
		}
		XCTAssertTrue(landed, "and a streamed block still reaches it")
	}

	/// The rebuilt composer has to reload the provider's models: it starts
	/// with an empty `models` and `ComposerView` keys the load on
	/// `modelLoadKey`, so two composers sharing a key leave the pill on the
	/// one-item fallback menu.
	func testARebuiltComposerReloadsItsModelsForTheSameSession() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		let before = model.composer.modelLoadKey
		let transcript = model.transcriptId
		model.select(.mission("m304"))
		XCTAssertEqual(model.sessionId, "s-leader", "the same session")
		XCTAssertEqual(model.transcriptId, transcript, "the same live transcript")
		XCTAssertNotEqual(
			model.composer.modelLoadKey, before,
			"but a fresh composer, whose empty model list has to be refilled")
		XCTAssertEqual(
			model.composer.placeholder, "Message #304 Rate limiter on /search")
	}

	/// And a selection that does open another session still gets a fresh
	/// transcript, which the panel restarts because `transcriptId` moved.
	func testADifferentSessionStillRebuildsAndRestartsTheTranscript() async {
		let client = CountingNodeClient()
		let model = ChatPanelModel(client: client, store: store(), shell: ShellState())
		await model.start()
		let before = model.transcriptId
		model.select(.agent("ag-thane"))
		XCTAssertEqual(model.sessionId, "s-ag-thane")
		XCTAssertNotEqual(model.transcriptId, before, "a new session, a new transcript")
		await model.start()
		XCTAssertEqual(client.tailCount("s-ag-thane"), 1)
		XCTAssertTrue(model.transcript.isStreaming)
	}

	// MARK: - Helpers

	/// Polls a MainActor condition for up to a second, so a test can wait for
	/// a notification to travel through the client's stream without sleeping
	/// a fixed time.
	private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
		for _ in 0 ..< 200 {
			if condition() { return true }
			try? await Task.sleep(for: .milliseconds(5))
		}
		return condition()
	}


	/// Just the `transcript` computed property's source, so an assertion
	/// about the transcript cannot be satisfied by the rest of the panel.
	private func transcriptSource() throws -> String {
		let source = try chatPanelSource()
		let start = try XCTUnwrap(
			source.range(of: "private var transcript: some View"))
		let end = try XCTUnwrap(
			source.range(
				of: "private func drainScroll",
				range: start.upperBound ..< source.endIndex))
		return String(source[start.lowerBound ..< end.lowerBound])
	}

	private func chatPanelSource() throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/Chat/ChatPanel.swift")
		return try String(contentsOf: url, encoding: .utf8)
	}

	private func store() -> Store {
		let store = Store()
		store.replace(snapshot: Snapshot(
			machine: Machine(id: "m1", name: "mac-studio", createdAt: base),
			workspaces: [Workspace(
				id: workspaceId, kind: .git, name: "NoScrubs",
				remote: "git@github.com:acme/NoScrubs.git", roots: [],
				createdAt: base)],
			leaders: [Leader(
				workspaceId: workspaceId, machineId: "m1",
				name: "Halden",
				sessionId: "s-leader", provider: "Claude", model: "claude-opus-5",
				mode: .leadPlus, modeSince: base, modeActiveMs: 14 * 60_000,
				activeMissionId: "m304", state: .running)],
			missions: [
				Mission(
					id: "m304", number: 304, workspaceId: workspaceId,
					machineId: "m1", name: "Rate limiter on /search",
					objective: "Cap search QPS.", changes: [],
					lead: .leader, agentIds: ["ag-thane"],
					access: .readOnly, worktree: nil, state: .running,
					attention: nil, createdAt: base, closedAt: nil,
					disposition: nil, closeReason: nil, integration: nil,
					continuesMissionId: nil),
				Mission(
					id: "m305", number: 305, workspaceId: workspaceId,
					machineId: "m1", name: "Flag cleanup",
					objective: "Remove stale flags.", changes: [],
					lead: .agent(agentId: "ag-quill"), agentIds: ["ag-quill"],
					access: .readWrite, worktree: nil, state: .running,
					attention: nil, createdAt: base, closedAt: nil,
					disposition: nil, closeReason: nil, integration: nil,
					continuesMissionId: nil),
			],
			hasOlder: false,
			agents: [
				Agent(
					id: "ag-thane", missionId: "m304",
					workspaceId: workspaceId, name: "Thane",
					task: "Add the limiter.", access: .readOnly,
					provider: "Codex", model: "gpt-5-codex",
					skills: [], sessionId: "s-ag-thane",
					canSpawn: false, state: .running, stateBefore: nil,
					activity: nil, pendingQuestion: nil,
					startedAt: base, endedAt: nil, outcome: nil),
				Agent(
					id: "ag-quill", missionId: "m305",
					workspaceId: workspaceId, name: "Quill",
					task: "Drop the flags.", access: .readWrite,
					provider: "Codex", model: "gpt-5-codex", skills: [],
					sessionId: "s-ag-quill", canSpawn: true,
					state: .running, stateBefore: nil, activity: nil,
					pendingQuestion: nil, startedAt: base, endedAt: nil,
					outcome: nil),
				Agent(
					id: "ag-old", missionId: "m304",
					workspaceId: workspaceId, name: "Old",
					task: "Done.", access: .readOnly,
					provider: "Codex", model: "gpt-5-codex", skills: [],
					sessionId: "s-ag-old", canSpawn: false,
					state: .archived, stateBefore: nil, activity: nil,
					pendingQuestion: nil, startedAt: base, endedAt: base,
					outcome: "Landed."),
			],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base))
		return store
	}
}
