import Foundation
import SwiftUI
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
	/// When true, `prompt` throws the way a disconnected Node does.
	var promptFails = false
	var handoffFails = false
	var providerFails = false
	var modelFails = false
	var modeFails = false
	private(set) var attachmentCount = 0
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

	func setPromptFails(_ fails: Bool) {
		promptFails = fails
	}
	func setProviderFailures(handoff: Bool = false, provider: Bool = false, model: Bool = false) {
		handoffFails = handoff
		providerFails = provider
		modelFails = model
	}
	func setModeFails(_ fails: Bool) { modeFails = fails }

	func methods(named method: String) -> [Call] {
		calls.filter { $0.method == method }
	}
	func receivedAttachmentCount() -> Int { attachmentCount }

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
		if promptFails { throw NodeClientError.disconnected }
		return "t-new"
	}
	func prompt(sessionId: Ulid, text: String, attachments: [PromptAttachment]) async throws -> Ulid {
		attachmentCount = attachments.count
		return try await prompt(sessionId: sessionId, text: text)
	}
	func capabilities(sessionId: Ulid) async throws -> ConversationCapabilities {
		calls.append(Call(method: "capabilities", sessionId: sessionId, text: nil, model: nil, workspaceId: nil, mode: nil))
		return .init(image: true, embeddedContext: true)
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
		if modelFails { throw NodeClientError.disconnected }
	}

	func listProviders() async throws -> [ProviderInfo] {
		[ProviderInfo(id: "alternate", label: "Alternate", defaultModel: "alt-model")]
	}

	func prepareHandoff(sessionId: Ulid) async throws -> String {
		if handoffFails { throw NodeClientError.disconnected }
		return "# Handoff"
	}

	func setProvider(
		sessionId: Ulid, provider: String, model: String?, handoff: String?
	) async throws -> ProviderSwitchResult {
		calls.append(Call(method: "setProvider", sessionId: sessionId, text: handoff, model: model, workspaceId: nil, mode: nil))
		if providerFails { throw NodeClientError.disconnected }
		return ProviderSwitchResult(sessionId: sessionId, provider: provider, model: "alt-model", contextReset: true)
	}

	func listModels(provider: String) async throws -> [ModelInfo] {
		calls.append(Call(
			method: "listModels", sessionId: nil, text: nil,
			model: provider, workspaceId: nil, mode: nil))
		return listedModels
	}
	func listModels(sessionId: Ulid) async throws -> [ModelInfo] {
		calls.append(Call(method: "listModels", sessionId: sessionId, text: nil, model: nil, workspaceId: nil, mode: nil))
		return listedModels
	}

	func setMode(workspaceId: String, mode: LeaderMode) async throws {
		calls.append(Call(
			method: "setMode", sessionId: nil, text: nil,
			model: nil, workspaceId: workspaceId, mode: mode))
		if modeFails { throw NodeClientError.rpc(code: -32603, message: "mode refused") }
	}

	func pin(missionId: Ulid, pinned: Bool) async throws {}
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {}
}

/// T11.6: the button matrix, picker enablement, mode control, send/stop,
// `setMode` during a turn, line clamping and the archived form.
@MainActor
final class ComposerTests: XCTestCase {
	func testResumePendingKeepsSnapshotButBlocksRPCUntilReady() async {
		let stub = ComposerStub()
		let retained = store()
		retained.beginSessionsResume()
		let model = ComposerModel(client: stub, store: retained, sessionId: "s-leader", selection: .leader)
		model.draft = "do not send yet"

		XCTAssertEqual(retained.leader?.name, "Halden", "the durable snapshot remains visible")
		XCTAssertEqual(model.button, .sendDisabled)
		await model.loadCapabilities()
		await model.send()
		let pendingCapabilities = await stub.methods(named: "capabilities")
		let pendingPrompts = await stub.methods(named: "prompt")
		XCTAssertTrue(pendingCapabilities.isEmpty)
		XCTAssertTrue(pendingPrompts.isEmpty)

		retained.markSessionsReady()
		await model.loadCapabilities()
		let readyCapabilities = await stub.methods(named: "capabilities")
		XCTAssertEqual(readyCapabilities.count, 1)
		XCTAssertEqual(model.capabilities, .init(image: true, embeddedContext: true))
	}

	func testProviderFailuresAreVisibleAndDoNotChangeSelection() async {
		let stub = ComposerStub()
		let model = leaderModel(client: stub)
		let original = model.selectedModel
		await stub.setProviderFailures(handoff: true)
		let handoff = await model.handoff()
		XCTAssertNil(handoff)
		XCTAssertNotNil(model.providerError)
		XCTAssertTrue(model.providerPickerEnabled)

		await stub.setProviderFailures(provider: true)
		let provider = ProviderInfo(id: "alternate", label: "Alternate", defaultModel: "alt-model")
		let failedSwitch = await model.setProvider(provider, handoff: "edited")
		XCTAssertFalse(failedSwitch)
		XCTAssertEqual(model.selectedModel, original)
		XCTAssertNotNil(model.providerError)

		await stub.setProviderFailures(model: true)
		await model.setModel("broken-model")
		XCTAssertEqual(model.selectedModel, original)
		XCTAssertNotNil(model.providerError)
	}

	func testProviderSuccessClearsPriorErrorAndUpdatesModel() async {
		let stub = ComposerStub()
		let model = leaderModel(client: stub)
		await stub.setProviderFailures(provider: true)
		let provider = ProviderInfo(id: "alternate", label: "Alternate", defaultModel: "alt-model")
		let failedSwitch = await model.setProvider(provider, handoff: "edited")
		XCTAssertFalse(failedSwitch)
		await stub.setProviderFailures()
		let switched = await model.setProvider(provider, handoff: "edited")
		XCTAssertTrue(switched)
		XCTAssertNil(model.providerError)
		XCTAssertEqual(model.selectedModel, "alt-model")
	}
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	// The workspace is NoScrubs; the leader is Halden. Nothing may
	// derive the leader's name from the workspace.
	private let workspaceId = "git:github.com/acme/NoScrubs"

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

	func testActiveTurnKeepsSendAvailableAndPromptsWithoutStopping() async {
		let stub = ComposerStub()
		let model = leaderModel(client: stub)
		model.hasOpenTurn = true
		model.draft = "Steer now"
		XCTAssertTrue(model.canSendDuringTurn)
		await model.send()
		let prompts = await stub.methods(named: "prompt")
		let cancels = await stub.methods(named: "cancel")
		XCTAssertEqual(prompts.map(\.text), ["Steer now"])
		XCTAssertTrue(cancels.isEmpty)
	}

	/// A prompt that throws reached no Node, so the message it echoed must
	/// come back out of the transcript and the draft must come back to the
	/// field: the person must never see their own message sitting in the
	/// chat as though it had been delivered.
	func testFailedPromptRetiresTheEchoAndReturnsTheDraft() async {
		let stub = ComposerStub()
		await stub.setPromptFails(true)
		let model = leaderModel(client: stub)
		var echoed: [String] = []
		var retired: [String] = []
		model.onSend = { echoed.append($0) }
		model.onSendFailed = { retired.append($0) }
		model.draft = "Void them."
		await model.send()
		XCTAssertEqual(echoed, ["Void them."])
		XCTAssertEqual(retired, ["Void them."], "the echo is retired")
		XCTAssertEqual(model.draft, "Void them.", "the draft comes back")

		// A draft typed while the prompt was in flight is not overwritten.
		await stub.setPromptFails(true)
		let second = leaderModel(client: stub)
		second.onSendFailed = { _ in second.draft = "typed since" }
		second.draft = "Merge it."
		await second.send()
		XCTAssertEqual(second.draft, "typed since")
	}

	/// A successful prompt keeps the echo and leaves the field empty.
	func testSuccessfulPromptKeepsTheEcho() async {
		let stub = ComposerStub()
		let model = leaderModel(client: stub)
		var retired: [String] = []
		model.onSendFailed = { retired.append($0) }
		model.draft = "Void them."
		await model.send()
		XCTAssertTrue(retired.isEmpty)
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

	func testSetModeFailureIsVisible() async {
		let stub = ComposerStub()
		await stub.setModeFails(true)
		let store = store()
		let model = ComposerModel(client: stub, store: store, sessionId: "s-leader", selection: .leader)
		await model.setMode(.leadPlus)
		XCTAssertEqual(model.providerError, "Could not change mode: mode refused")
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
		XCTAssertEqual(lists.first?.sessionId, "s-leader")
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

	/// The `Lead | Lead++` control is compact glass segments, not a stock
	/// 150-wide segmented picker: both labels always show and the model says
	/// which one is selected.
	func testModeSegmentsCarryBothLabelsAndTheSelection() {
		let leadPlus = ModeSegments(selected: .leadPlus)
		XCTAssertEqual(leadPlus.labels, ["Lead", "Lead++"])
		XCTAssertEqual(leadPlus.selectedLabel, "Lead++")
		XCTAssertEqual(leadPlus.segments.map(\.isSelected), [false, true])
		let lead = ModeSegments(selected: .lead)
		XCTAssertEqual(lead.labels, ["Lead", "Lead++"], "both segments carry text")
		XCTAssertEqual(lead.selectedLabel, "Lead")
		XCTAssertEqual(lead.segments.map(\.mode), [.lead, .leadPlus])
		XCTAssertEqual(ModeSegments.helpText, "build access")
	}

	/// The picker's pill reads the model id until the provider list names it.
	func testModelPickerLabelIsTheModelId() {
		let bare = ModelPicker(selected: "claude-opus-5", models: [])
		XCTAssertEqual(bare.label, "claude-opus-5")
		XCTAssertEqual(bare.options.map(\.id), ["claude-opus-5"])
		let listed = ModelPicker(selected: "claude-opus-5", models: [
			ModelInfo(id: "claude-opus-5", provider: "Claude", label: "Opus 5", description: "Most capable"),
			ModelInfo(id: "claude-sonnet-4", provider: "Claude", label: ""),
		])
		XCTAssertEqual(listed.label, "Opus 5")
		XCTAssertEqual(listed.options.map(\.label), ["Opus 5", "claude-sonnet-4"])
		XCTAssertEqual(listed.options.first?.detail, "Most capable")
		let unlisted = ModelPicker(selected: "gpt-5-codex", models: [
			ModelInfo(id: "claude-opus-5", provider: "Claude", label: "Opus 5"),
		])
		XCTAssertEqual(unlisted.label, "gpt-5-codex", "an unlisted selection still shows its id")
		XCTAssertEqual(unlisted.options.map(\.id), ["claude-opus-5", "gpt-5-codex"])
	}

	/// Provider and model share one native selector; mode uses the native segmented picker.
	func testComposerUsesSharedNativeSelectorsAndSegmentedMode() throws {
		let source = try composerViewSource()
		XCTAssertEqual(occurrences(of: "AgentSelector(", in: source), 2)
		XCTAssertTrue(source.contains("Picker(\"Mode\""))
		XCTAssertTrue(source.contains(".pickerStyle(.segmented)"))
		XCTAssertFalse(source.contains("width: 150"), "the mode control is compact")
		XCTAssertFalse(
			source.contains("netaFloatingGlass"), "no composer control floats over the ground")
		XCTAssertTrue(source.contains("Theme.mint"), "the enabled send arrow stays a mint capsule")
		XCTAssertTrue(source.contains("Theme.Glass.fieldFill"), "the field is inset glass")
	}

	/// Each trailing action has the same round 30 pt footprint. While a turn
	/// runs, Send and Stop are both available so steering does not require a stop.
	/// the mint send arrow when a person types. The send used to be a mint
	/// lozenge beside a round Stop, so the silhouette changed under the hand
	/// as well as the colour; and the disabled form was a bare `Image`, so
	/// VoiceOver announced an image and "nothing to send" was carried by the
	/// grey tint alone.
	func testTheTrailingControlIsOneRoundButtonInEveryState() throws {
		let source = try composerViewSource()
		XCTAssertEqual(
			occurrences(
				of: ".frame(width: Self.actionSize, height: Self.actionSize)",
				in: source),
			4,
			"Stop, active Send, idle Send and disabled Send share one round footprint")
		XCTAssertFalse(
			source.contains(".padding(.horizontal, 12)"),
			"the send arrow is no longer a lozenge")
		XCTAssertEqual(ComposerView.actionSize, 30)
		XCTAssertTrue(
			source.contains(".disabled(true)"),
			"the unavailable send is a real disabled Button")
		XCTAssertTrue(
			source.contains("accessibilityValue(\"Nothing to send\")"),
			"and says why, rather than leaving it to the tint")
	}

	/// The model pill must actually have a menu to open. `ModelPicker` falls
	/// back to the one model already selected when `model.models` is empty,
	/// and nothing in `Sources/` called `loadModels()` — so at runtime the
	/// menu held exactly one item, the current model. The view has to ask.
	/// `ChatPanelModel.select` replaces `composer` with a brand-new
	/// `ComposerModel` whose `models` is empty, but `ComposerView` keeps its
	/// place in `ChatPanel`'s body and so its SwiftUI identity. A bare
	/// `.task` therefore runs once ever: every selection after the first
	/// (leader to agent, agent to mission, and back) opened a menu of exactly
	/// one model. The load is keyed to the session instead.
	func testComposerLoadsTheModelListOnAppear() throws {
		let source = try composerViewSource()
		XCTAssertTrue(
			source.contains("await model.loadModels()"),
			"the composer must load the provider's models")
		XCTAssertTrue(
			source.contains(".task(id: model.modelLoadKey) { await model.loadModels() }"),
			"the load is keyed to the session and the provider, so a new selection reloads")
		XCTAssertFalse(
			source.contains(".task {"), "an unkeyed task would run only for the first session")
		// The menu lists what was loaded, not a restated literal.
		XCTAssertTrue(
			source.contains("ModelPicker(selected: model.selectedModel, models: model.models)"),
			"the menu comes from the loaded list")
	}

	/// The load is keyed on the session AND the provider, not on the session
	/// alone: the provider arrives with the snapshot, so a session-keyed load
	/// no-ops at launch and never runs again.
	func testTheModelListIsKeyedOnTheSessionAndTheProvider() throws {
		let source = try composerViewSource()
		XCTAssertTrue(
			source.contains(".task(id: model.modelLoadKey) { await model.loadModels() }"),
			"the model list reloads when the session or the provider moves")
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

	func testAttachmentOnlyPromptSendsBytesAndClearsAfterAcknowledgement() async {
		let client = ComposerStub()
		let model = leaderModel(client: client)
		await model.loadCapabilities()
		model.addImagePNG(Data([1, 2, 3]))
		XCTAssertEqual(model.button, .send)
		await model.send()
		let count = await client.receivedAttachmentCount()
		XCTAssertEqual(count, 1)
		XCTAssertTrue(model.attachments.isEmpty)
	}

	func testFailedAttachmentPromptKeepsTextAndBytesAndShowsError() async {
		let client = ComposerStub()
		await client.setPromptFails(true)
		let model = leaderModel(client: client)
		await model.loadCapabilities()
		model.draft = "inspect"
		model.addImagePNG(Data([1, 2, 3]))
		await model.send()
		XCTAssertEqual(model.draft, "inspect")
		XCTAssertEqual(model.attachments.first?.data, Data([1, 2, 3]))
		XCTAssertNotNil(model.attachmentError)
	}

	func testResponderPasteHandlesImageAndFileAndLeavesPlainTextToNSTextView() async throws {
		let client = ComposerStub()
		let model = leaderModel(client: client)
		await model.loadCapabilities()
		let view = ComposerNSTextView()
		view.attachmentPaste = { ComposerPasteboard.paste($0, into: model) }

		let imageBoard = NSPasteboard(name: .init("neta-image-\(UUID())"))
		imageBoard.clearContents()
		let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 4, bitsPerPixel: 32)!
		imageBoard.setData(try XCTUnwrap(bitmap.representation(using: .png, properties: [:])), forType: .png)
		view.pasteboard = { imageBoard }
		view.paste(nil)
		XCTAssertEqual(model.attachments.map(\.kind), [.image])

		let file = FileManager.default.temporaryDirectory.appendingPathComponent("neta-paste-\(UUID()).txt")
		try Data("file".utf8).write(to: file)
		defer { try? FileManager.default.removeItem(at: file) }
		let fileBoard = NSPasteboard(name: .init("neta-file-\(UUID())"))
		fileBoard.clearContents()
		fileBoard.writeObjects([file as NSURL])
		view.pasteboard = { fileBoard }
		view.paste(nil)
		XCTAssertEqual(model.attachments.map(\.kind), [.image, .file])

		let textBoard = NSPasteboard(name: .init("neta-text-\(UUID())"))
		textBoard.clearContents(); textBoard.setString("plain text", forType: .string)
		view.string = ""; view.setSelectedRange(NSRange(location: 0, length: 0))
		view.pasteboard = { textBoard }
		view.paste(nil)
		XCTAssertEqual(view.string, "plain text")
	}

	func testComposerTextViewReturnSendsAndShiftReturnInsertsNewline() throws {
		let view = ComposerNSTextView()
		var sends = 0
		view.sendAction = { _ in sends += 1 }
		func key(_ modifiers: NSEvent.ModifierFlags) throws -> NSEvent {
			try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0, windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
		}
		view.keyDown(with: try key([]))
		XCTAssertEqual(sends, 1)
		view.string = "a"; view.setSelectedRange(NSRange(location: 1, length: 0))
		view.keyDown(with: try key(.shift))
		XCTAssertEqual(sends, 1)
		XCTAssertTrue(view.string.contains("\n"))
	}

	func testComposerInputCoordinatorCanFollowAReplacementBinding() {
		var oldDraft = "old"
		var newDraft = "new"
		let coordinator = ComposerTextInput.Coordinator(text: Binding(
			get: { oldDraft }, set: { oldDraft = $0 }))
		coordinator.text = Binding(get: { newDraft }, set: { newDraft = $0 })
		let view = ComposerNSTextView(); view.string = "typed into replacement"
		coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view))
		XCTAssertEqual(oldDraft, "old")
		XCTAssertEqual(newDraft, "typed into replacement")
	}

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
		store.markSessionsReady()
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
