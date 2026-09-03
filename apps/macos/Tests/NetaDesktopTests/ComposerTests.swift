import Foundation
import XCTest

@testable import NetaDesktop

/// A recording `NodeClient` for the composer: scripted `models.list`
/// answers, every write call logged for assertions.
private actor ComposerStub: NodeClient {
	struct Call: Sendable {
		let method: String
		let sessionId: String?
		let text: String?
		let model: String?
		let workspaceId: String?
		let mode: LeaderMode?
	}

	private(set) var calls: [Call] = []
	var listedModels: [ModelInfo] = []
	let notifications: AsyncStream<NodeNotification>

	init() {
		let (stream, continuation) = AsyncStream<NodeNotification>.makeStream()
		notifications = stream
		continuation.finish()
	}

	func record(_ call: Call) {
		calls.append(call)
	}

	func setListedModels(_ models: [ModelInfo]) {
		listedModels = models
	}

	func methods(named method: String) -> [Call] {
		calls.filter { $0.method == method }
	}

	func connect() async throws {}
	func snapshot() async throws -> Snapshot { throw NodeClientError.disconnected }
	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] { [] }
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] { [] }
	func conversationTail(
		sessionId: Ulid, cursor: String? = nil, limit: Int,
		direction: String? = nil, turnId: TurnId? = nil
	) async throws -> ConversationPage {
		ConversationPage(turns: [], blocks: [], nextCursor: nil, prevCursor: nil)
	}

	func prompt(sessionId: Ulid, text: String) async throws -> Ulid {
		calls.append(Call(
			method: "prompt", sessionId: sessionId, text: text,
			model: nil, workspaceId: nil, mode: nil))
		return "t-new"
	}

	func cancel(sessionId: Ulid) async throws {
		calls.append(Call(
			method: "cancel", sessionId: sessionId, text: nil,
			model: nil, workspaceId: nil, mode: nil))
	}

	func setModel(sessionId: Ulid, model: String) async throws {
		calls.append(Call(
			method: "setModel", sessionId: sessionId, text: nil,
			model: model, workspaceId: nil, mode: nil))
	}

	func listModels(provider: String) async throws -> [ModelInfo] {
		calls.append(Call(
			method: "listModels", sessionId: nil, text: nil,
			model: provider, workspaceId: nil, mode: nil))
		return listedModels
	}

	func setMode(workspaceId: String, mode: LeaderMode) async throws {
		calls.append(Call(
			method: "setMode", sessionId: nil, text: nil,
			model: nil, workspaceId: workspaceId, mode: mode))
	}

	func pin(missionId: Ulid, pinned: Bool) async throws {}
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {}
}

/// T11.6: the button matrix, picker enablement, mode control, send/stop,
// `setMode` during a turn, line clamping and the archived form.
@MainActor
final class ComposerTests: XCTestCase {
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	private let workspaceId = "git:github.com/acme/Halden"

	func testButtonMatrixOverOpenTurnAndDraft() {
		let model = leaderModel()
		model.hasOpenTurn = false
		model.draft = ""
		XCTAssertEqual(model.button, .sendDisabled)
		model.draft = "   \n  "
		XCTAssertEqual(model.button, .sendDisabled, "whitespace-only draft cannot send")
		model.draft = "Void them."
		XCTAssertEqual(model.button, .send)
		model.hasOpenTurn = true
		model.draft = ""
		XCTAssertEqual(model.button, .stop, "an open turn beats an empty draft")
		model.draft = "typed while streaming"
		XCTAssertEqual(model.button, .stop, "an open turn beats a typed draft")
	}

	func testButtonNoneWhenArchived() {
		let model = leaderModel()
		model.isArchived = true
		model.draft = "typed"
		XCTAssertEqual(model.button, .none)
		model.hasOpenTurn = true
		XCTAssertEqual(model.button, .none, "archived beats an open turn too")
	}

	func testModelPickerDisabledDuringTurnAndWhenArchived() {
		let model = leaderModel()
		XCTAssertTrue(model.modelPickerEnabled)
		model.hasOpenTurn = true
		XCTAssertFalse(model.modelPickerEnabled)
		model.hasOpenTurn = false
		model.isArchived = true
		XCTAssertFalse(model.modelPickerEnabled)
	}

	func testShowsModeControlForLeaderAndMissionLead() {
		XCTAssertTrue(leaderModel().showsModeControl)
		XCTAssertTrue(agentModel(id: "ag-quill").showsModeControl, "mission lead (canSpawn)")
		XCTAssertTrue(missionModel(id: "m305").showsModeControl, "mission led by a canSpawn agent")
		XCTAssertTrue(missionModel(id: "m304").showsModeControl, "leader-led mission is the leader session")
	}

	func testShowsModeControlHiddenForOrdinaryAgent() {
		XCTAssertFalse(agentModel(id: "ag-thane").showsModeControl)
		XCTAssertFalse(agentModel(id: "no-such-agent").showsModeControl)
		XCTAssertFalse(missionModel(id: "no-such-mission").showsModeControl)
	}

	func testSendPromptsOnceWithTrimmedDraftAndClears() async {
		let stub = ComposerStub()
		let model = leaderModel(client: stub)
		model.draft = "  Void them.  "
		await model.send()
		let prompts = await stub.methods(named: "prompt")
		XCTAssertEqual(prompts.count, 1)
		XCTAssertEqual(prompts.first?.sessionId, "s-leader")
		XCTAssertEqual(prompts.first?.text, "Void them.")
		XCTAssertEqual(model.draft, "")
	}

	func testSendNeverPromptsEmptyOrArchived() async {
		let stub = ComposerStub()
		let model = leaderModel(client: stub)
		model.draft = "  \n "
		await model.send()
		model.isArchived = true
		model.draft = "typed"
		await model.send()
		let prompts = await stub.methods(named: "prompt")
		XCTAssertTrue(prompts.isEmpty)
		XCTAssertEqual(model.draft, "typed", "a blocked send keeps the draft")
	}

	func testStopCancels() async {
		let stub = ComposerStub()
		let model = leaderModel(client: stub)
		model.hasOpenTurn = true
		await model.stop()
		let cancels = await stub.methods(named: "cancel")
		XCTAssertEqual(cancels.count, 1)
		XCTAssertEqual(cancels.first?.sessionId, "s-leader")
	}

	func testSetModeWorksDuringAnOpenTurn() async {
		let stub = ComposerStub()
		let model = leaderModel(client: stub)
		model.hasOpenTurn = true
		await model.setMode(.leadPlus)
		let modes = await stub.methods(named: "setMode")
		XCTAssertEqual(modes.count, 1)
		XCTAssertEqual(modes.first?.workspaceId, workspaceId)
		XCTAssertEqual(modes.first?.mode, .leadPlus)
	}

	func testLoadModelsListsProviderAndSelectsCurrent() async {
		let stub = ComposerStub()
		await stub.setListedModels([
			ModelInfo(id: "claude-opus-5", provider: "Claude", label: "claude-opus-5"),
			ModelInfo(id: "claude-sonnet-4", provider: "Claude", label: "claude-sonnet-4"),
		])
		let model = leaderModel(client: stub)
		XCTAssertEqual(model.selectedModel, "claude-opus-5", "selection starts at the session model")
		await model.loadModels()
		let lists = await stub.methods(named: "listModels")
		XCTAssertEqual(lists.count, 1)
		XCTAssertEqual(lists.first?.model, "Claude")
		XCTAssertEqual(model.models.map(\.id), ["claude-opus-5", "claude-sonnet-4"])
		XCTAssertEqual(model.selectedModel, "claude-opus-5")
	}

	func testSetModelCallsThroughAndReselects() async {
		let stub = ComposerStub()
		let model = agentModel(id: "ag-thane", client: stub)
		XCTAssertEqual(model.selectedModel, "gpt-5-codex")
		await model.setModel("gpt-5-codex-mini")
		let sets = await stub.methods(named: "setModel")
		XCTAssertEqual(sets.count, 1)
		XCTAssertEqual(sets.first?.sessionId, "s-ag-thane")
		XCTAssertEqual(sets.first?.model, "gpt-5-codex-mini")
		XCTAssertEqual(model.selectedModel, "gpt-5-codex-mini")
	}

	func testLineCountClampsToOneThroughSix() {
		let model = leaderModel()
		model.draft = ""
		XCTAssertEqual(model.lineCount, 1)
		model.draft = "one line"
		XCTAssertEqual(model.lineCount, 1)
		model.draft = "one\ntwo\nthree"
		XCTAssertEqual(model.lineCount, 3)
		model.draft = (1 ... 6).map { "line \($0)" }.joined(separator: "\n")
		XCTAssertEqual(model.lineCount, 6)
		model.draft = (1 ... 10).map { "line \($0)" }.joined(separator: "\n")
		XCTAssertEqual(model.lineCount, 6)
	}

	func testPlaceholders() {
		XCTAssertEqual(leaderModel().placeholder, "Message the workspace leader")
		XCTAssertEqual(agentModel(id: "ag-thane").placeholder, "Message Thane")
		XCTAssertEqual(missionModel(id: "m304").placeholder, "Message #304 Rate limiter on /search")
		let archived = leaderModel()
		archived.isArchived = true
		XCTAssertEqual(archived.placeholder, "Read-only · archived")
		XCTAssertEqual(archived.mode, .leadPlus)
	}

	func testComposerViewBuildsForLiveAndArchived() {
		let live = leaderModel()
		live.draft = "Close #305 once the checks pass."
		_ = ComposerView(model: live)
		let archived = leaderModel()
		archived.isArchived = true
		_ = ComposerView(model: archived)
	}

	// MARK: - Helpers

	private func leaderModel(client: ComposerStub? = nil) -> ComposerModel {
		ComposerModel(
			client: client ?? ComposerStub(), store: store(),
			sessionId: "s-leader", selection: .leader)
	}

	private func agentModel(id: Ulid, client: ComposerStub? = nil) -> ComposerModel {
		let agent = store().agentsById[id]
		return ComposerModel(
			client: client ?? ComposerStub(), store: store(),
			sessionId: agent?.sessionId ?? "s-\(id)", selection: .agent(id))
	}

	private func missionModel(id: Ulid, client: ComposerStub? = nil) -> ComposerModel {
		ComposerModel(
			client: client ?? ComposerStub(), store: store(),
			sessionId: "s-leader", selection: .mission(id))
	}

	private func store() -> Store {
		let store = Store()
		store.replace(snapshot: Snapshot(
			machine: Machine(id: "m1", name: "mac-studio", createdAt: base),
			workspaces: [Workspace(
				id: workspaceId, kind: .git, name: "repo",
				remote: "git@github.com:acme/repo.git", roots: [],
				createdAt: base)],
			leaders: [Leader(
				workspaceId: workspaceId, machineId: "m1",
				sessionId: "s-leader", provider: "Claude", model: "claude-opus-5",
				mode: .leadPlus, modeSince: base, modeActiveMs: 14 * 60_000,
				activeMissionId: "m304", state: .running)],
			missions: [
				mission(id: "m304", number: 304, name: "Rate limiter on /search", lead: .leader),
				mission(
					id: "m305", number: 305, name: "Flag cleanup",
					lead: .agent(agentId: "ag-quill")),
			],
			hasOlder: false,
			agents: [
				agent(id: "ag-thane", missionId: "m304", name: "Thane", canSpawn: false),
				agent(id: "ag-quill", missionId: "m305", name: "Quill", canSpawn: true),
			],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base))
		return store
	}

	private func mission(id: Ulid, number: Int, name: String, lead: MissionLead) -> Mission {
		Mission(
			id: id, number: number, workspaceId: workspaceId,
			machineId: "m1", name: name, objective: "Objective.",
			changes: [], lead: lead, agentIds: [], access: .readOnly,
			worktree: nil, state: .running, attention: nil, createdAt: base,
			closedAt: nil, disposition: nil, closeReason: nil,
			integration: nil, continuesMissionId: nil)
	}

	private func agent(id: Ulid, missionId: Ulid, name: String, canSpawn: Bool) -> Agent {
		Agent(
			id: id, missionId: missionId, workspaceId: workspaceId,
			name: name, task: "Task.", access: .readOnly, provider: "Codex",
			model: "gpt-5-codex", skills: [], sessionId: "s-\(id)",
			canSpawn: canSpawn, state: .running, stateBefore: nil, activity: nil,
			pendingQuestion: nil, startedAt: base, endedAt: nil, outcome: nil)
	}
}
