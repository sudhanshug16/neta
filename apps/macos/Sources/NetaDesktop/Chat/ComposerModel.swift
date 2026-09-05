import Foundation
import Observation
import AgentChatKit
import UniformTypeIdentifiers

public struct AttachmentDraft: Identifiable, Sendable, Equatable {
	public let id: String
	public let kind: PromptAttachment.Kind
	public let name: String
	public let mimeType: String
	public let data: Data
	public init(id: String = UUID().uuidString, kind: PromptAttachment.Kind, name: String, mimeType: String, data: Data) {
		self.id = id; self.kind = kind; self.name = name; self.mimeType = mimeType; self.data = data
	}
	var prompt: PromptAttachment { .init(id: id, kind: kind, name: name, mimeType: mimeType, dataBase64: data.base64EncodedString()) }
}

/// Which trailing button the composer shows (11-desktop-chat T11.6).
///
/// `.none` when the session is archived, `.stop` while a turn is open,
/// `.send` when the trimmed draft is non-empty, else `.sendDisabled`. Stop
/// is the square glyph on the subtle surface; send is the mint arrow.
public enum ComposerButton: Equatable, Sendable {
	case stop
	case send
	case sendDisabled
	case none
}

/// The chat composer's state: draft, controls row and send/stop (T11.6).
///
/// `button` follows the archived > open-turn > draft rule; the controls row
/// is the model picker (`models.list` / `conversation.setModel`) plus the
/// compact `Lead | Lead++` control (`leader.setMode`) when
/// `showsModeControl`. `hasOpenTurn` and `isArchived` are set by the owning
/// panel (T11.8) from the transcript and the store; `send` trims the draft,
/// prompts once and clears it, `stop` cancels. `setMode` calls through even
/// during an open turn — the Node does the cancel-and-re-prompt.
@MainActor @Observable public final class ComposerModel {
	private let client: any NodeClient
	private let store: Store
	private let sessionId: SessionId
	private let selection: Selection

	/// Distinguishes one composer from the next. `ChatPanelModel` builds a
	/// fresh `ComposerModel` whenever the selection moves, while
	/// `ComposerView` keeps its place in `ChatPanel`'s body and so its
	/// identity: `.task(id: modelLoadKey)` re-runs only when the key changes.
	/// Two composers for the same session and provider shared a key, so the
	/// new one's empty `models` never filled and the pill fell back to a
	/// one-item menu.
	@ObservationIgnored private let instance = UUID()

	public var draft = ""
	public private(set) var attachments: [AttachmentDraft] = []
	public private(set) var capabilities = ConversationCapabilities(image: false, embeddedContext: false)
	public private(set) var attachmentError: String?
	/// Called with the trimmed text a `send` just prompted with, so the
	/// owning panel can echo the person's own message into the transcript
	/// (FIXPASS: the Node opens the user turn with no blocks, so a prompt
	/// was invisible until the agent answered).
	@ObservationIgnored public var onSend: ((String) -> Void)?
	/// Called with that same text when the prompt threw, so the owning panel
	/// can retire the echo. A failed prompt reached no Node, and a message
	/// the Node never received must not stay in the transcript looking
	/// delivered.
	@ObservationIgnored public var onSendFailed: ((String) -> Void)?
	@ObservationIgnored public var onPromptAccepted: ((TurnId) -> Void)?
	@ObservationIgnored public var onSendRich: ((String, [AttachmentDraft]) -> TurnId?)?
	@ObservationIgnored public var onSendFailedId: ((TurnId) -> Void)?
	public var hasOpenTurn = false
	public var isArchived = false
	public var isQueued = false
	public private(set) var models: [ModelInfo] = []
	public private(set) var providers: [ProviderInfo] = []
	public private(set) var selectedModel: String
	public private(set) var providerError: String?
	public private(set) var isPreparingHandoff = false
	public private(set) var isSwitchingProvider = false
	public private(set) var isSettingModel = false
	public private(set) var isSubmitting = false
	public private(set) var isStopping = false
	public private(set) var queuedMessageCount = 0
	public private(set) var inboxMessages: [InboxMessage] = []
	public func applyInbox(_ message: InboxMessage) {
		if let index = inboxMessages.firstIndex(where: { $0.id == message.id }) { inboxMessages[index] = message }
		else { inboxMessages.append(message) }
		inboxMessages.sort { $0.createdAt < $1.createdAt }
		queuedMessageCount = inboxMessages.filter { $0.status == "queued" || $0.status == "delivering" }.count
	}
	public var pendingInboxMessages: [InboxMessage] { inboxMessages.filter { $0.status == "queued" || $0.status == "delivering" || $0.status == "uncertain" } }
	public func loadInbox() async {
		guard store.sessionsReady, !sessionId.isEmpty else { return }
		do { inboxMessages = try await client.conversationInbox(sessionId: sessionId); queuedMessageCount = pendingInboxMessages.filter { $0.status != "uncertain" }.count }
		catch { providerError = "Could not load queued messages: \(error.localizedDescription)" }
	}

	public var responseProgress: AgentResponseProgress {
		if isStopping { return .stopping }
		if isSubmitting { return .preparing }
		if hasOpenTurn { return .streaming }
		return .idle
	}

	var debugState: String {
		"session=\(sessionId) draft=\(draft.count) attachments=\(attachments.count) open=\(hasOpenTurn) archived=\(isArchived) queued=\(isQueued) submitting=\(isSubmitting) stopping=\(isStopping) error=\(attachmentError ?? providerError ?? "-")"
	}

	public init(client: any NodeClient, store: Store, sessionId: SessionId, selection: Selection) {
		self.client = client
		self.store = store
		self.sessionId = sessionId
		self.selection = selection
		self.selectedModel = ""
		self.selectedModel = currentModel
	}

	/// Archived hides every control; an open turn shows Stop; otherwise the
	/// trimmed draft decides between send and its disabled form.
	public var button: ComposerButton {
		if isArchived { return .none }
		if isQueued || !store.sessionsReady || sessionId.isEmpty { return .sendDisabled }
		if hasOpenTurn || isSubmitting || isStopping { return .stop }
		return draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty ? .sendDisabled : .send
	}
	public var canSendDuringTurn: Bool {
		hasOpenTurn && !isSubmitting && !isStopping &&
			(!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
	}

	/// The field's visible height in lines, clamped to `1...6`.
	public var lineCount: Int {
		min(max(draft.components(separatedBy: "\n").count, 1), 6)
	}

	/// What the model list depends on: this composer instance, the session
	/// AND the provider that names the list. `loadModels` returns early until
	/// the store has a provider, and the provider arrives with the snapshot,
	/// not with the selection — so a load keyed on the session alone never
	/// re-runs once the leader lands and the picker keeps its one-item menu.
	/// The instance is in the key because a rebuilt composer starts with an
	/// empty `models` even when its session and provider are unchanged.
	public var modelLoadKey: String {
		"\(instance.uuidString)\u{1}\(sessionId)\u{1}\(provider)\u{1}\(store.sessionReadinessGeneration)"
	}

	/// The picker is dead while a turn streams or the session is archived.
	public var modelPickerEnabled: Bool {
		store.sessionsReady && !sessionId.isEmpty && !hasOpenTurn && !isArchived && !isQueued
			&& !isPreparingHandoff && !isSwitchingProvider && !isSettingModel
	}
	public var providerPickerEnabled: Bool { modelPickerEnabled }
	public var attachmentsEnabled: Bool {
		store.sessionsReady && !sessionId.isEmpty && !isArchived && !isQueued
	}
	public var providerLabel: String {
		providers.first(where: { $0.id == provider })?.label ?? (provider.isEmpty ? "Provider" : provider)
	}
	public var modelLabel: String { selectedModel.isEmpty ? "Default model" : selectedModel }

	/// Only the leader session and mission leads get the mode control: the
	/// leader, a mission led by the leader (the same session), and an agent
	/// (or mission lead) with `canSpawn`.
	public var showsModeControl: Bool {
		switch selection {
		case .leader:
			return true
		case .agent(let id):
			return store.agentsById[id]?.canSpawn == true
		case .mission(let id):
			guard let mission = store.missionsById[id] else { return false }
			switch mission.lead {
			case .leader:
				return true
			case .agent(let agentId):
				return store.agentsById[agentId]?.canSpawn == true
			}
		}
	}

	/// The field prompt: per-selection when live, fixed once archived.
	public var placeholder: String {
		if isArchived { return "Read-only · archived" }
		if isQueued { return "Waiting for writer access" }
		switch selection {
		case .leader:
			return "Message the workspace leader"
		case .mission(let id):
			if let mission = store.missionsById[id] {
				return "Message #\(mission.number) \(mission.name)"
			}
			return "Message the workspace leader"
		case .agent(let id):
			if let agent = store.agentsById[id] {
				return "Message \(agent.name)"
			}
			return "Message the workspace leader"
		}
	}

	/// The leader's current mode, backing the compact control's selection.
	public var mode: LeaderMode {
		store.leader?.mode ?? .lead
	}

	/// Lists the selection's provider models (`models.list`) and points the
	/// picker at the session's current model.
	public func loadModels() async {
		guard store.sessionsReady, !sessionId.isEmpty else { return }
		let fetched: [ModelInfo]
		do {
			fetched = try await client.listModels(sessionId: sessionId)
			models = fetched
			providerError = nil
		} catch {
			providerError = "Could not load models: \(error.localizedDescription)"
			return
		}
		let current = currentModel
		if !current.isEmpty {
			selectedModel = current
		} else if selectedModel.isEmpty, let first = fetched.first {
			selectedModel = first.id
		}
	}

	public func loadProviders() async {
		guard store.sessionsReady, !sessionId.isEmpty else { return }
		do {
			providers = try await client.listProviders(sessionId: sessionId)
			providerError = nil
		} catch {
			providerError = "Could not load providers: \(error.localizedDescription)"
		}
	}

	public func loadCapabilities() async {
		guard store.sessionsReady, !sessionId.isEmpty else { return }
		do { capabilities = try await client.capabilities(sessionId: sessionId); attachmentError = nil }
		catch NodeClientError.rpc(let code, _) where code == -32601 {
			attachmentError = "Restart the Neta service to enable attachments."
		} catch { attachmentError = error.localizedDescription }
	}

	public func addFiles(_ urls: [URL]) {
		for url in urls {
			do {
				let data = try Data(contentsOf: url, options: .mappedIfSafe)
				let type = UTType(filenameExtension: url.pathExtension)
				let isImage = type?.conforms(to: .image) == true
				try add(.init(kind: isImage ? .image : .file, name: url.lastPathComponent, mimeType: type?.preferredMIMEType ?? "application/octet-stream", data: data))
			} catch { attachmentError = error.localizedDescription }
		}
	}

	public func addImagePNG(_ data: Data, name: String = "Pasted Image.png") {
		do { try add(.init(kind: .image, name: name, mimeType: "image/png", data: data)) }
		catch { attachmentError = error.localizedDescription }
	}

	public func removeAttachment(id: String) { attachments.removeAll { $0.id == id } }

	private func add(_ attachment: AttachmentDraft) throws {
		guard attachments.count < 10 else { throw AttachmentError.message("You can attach up to 10 items.") }
		guard attachment.data.count <= 4 * 1024 * 1024 else { throw AttachmentError.message("\(attachment.name) exceeds 4 MiB.") }
		guard attachments.reduce(attachment.data.count, { $0 + $1.data.count }) <= 5 * 1024 * 1024 else { throw AttachmentError.message("Attachments exceed 5 MiB total.") }
		guard attachment.kind == .image ? capabilities.image : capabilities.embeddedContext else { throw AttachmentError.message(attachment.kind == .image ? "This provider does not support image prompts." : "This provider does not support file prompts.") }
		attachments.append(attachment); attachmentError = nil
	}

	public func handoff() async -> String? {
		guard providerPickerEnabled else { return nil }
		providerError = nil
		isPreparingHandoff = true
		defer { isPreparingHandoff = false }
		do {
			return try await client.prepareHandoff(sessionId: sessionId)
		} catch {
			providerError = error.localizedDescription
			return nil
		}
	}

	public func setProvider(_ provider: ProviderInfo, handoff: String?) async -> Bool {
		guard providerPickerEnabled else { return false }
		providerError = nil
		isSwitchingProvider = true
		defer { isSwitchingProvider = false }
		do {
			let result = try await client.setProvider(
				sessionId: sessionId, provider: provider.id,
				model: nil,
				handoff: handoff)
			await loadModels()
			await loadCapabilities()
			await loadProviders()
			// The owner snapshot announcing the new provider may arrive after
			// this request. Keep the acknowledged model instead of briefly
			// restoring the old owner's model from the store.
			selectedModel = result.model
			store.setNodeError(nil)
			return result.contextReset
		} catch {
			providerError = error.localizedDescription
			return false
		}
	}

	/// Prompts with the trimmed draft and clears it. Empty drafts and
	/// archived or queued sessions never prompt.
	///
	/// The echo goes in first so the person sees their own message with no
	/// wait, and comes back out again when the prompt throws: the draft is
	/// returned to the field (unless a new one has been started) and the
	/// echoed turn is retired, so the transcript never shows a message the
	/// Node never received.
	public func send() async {
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		let sentDraft = draft
		let sentAttachments = attachments
		guard store.sessionsReady, !sessionId.isEmpty,
			!isArchived, !isQueued, !isSubmitting, !isStopping,
			!text.isEmpty || !sentAttachments.isEmpty else { return }
		let localEchoId = onSendRich?(text, sentAttachments)
		if onSendRich == nil { onSend?(text) }
		isSubmitting = true
		defer { isSubmitting = false }
		do {
			let turnId = try await client.prompt(sessionId: sessionId, text: text, attachments: sentAttachments.map(\.prompt))
			onPromptAccepted?(turnId)
			if draft == sentDraft { draft = "" }
			let ids = Set(sentAttachments.map(\.id)); attachments.removeAll { ids.contains($0.id) }
			attachmentError = nil
		} catch {
			if let localEchoId { onSendFailedId?(localEchoId) } else { onSendFailed?(text) }
			attachmentError = error.localizedDescription
		}
	}

	/// Cancels the open turn.
	public func stop() async {
		guard hasOpenTurn || isSubmitting else { return }
		isStopping = true
		defer { isStopping = false }
		do {
			try await client.cancel(sessionId: sessionId)
		} catch {
			providerError = error.localizedDescription
		}
	}

	/// Switches the session model (`conversation.setModel`).
	public func setModel(_ id: String) async {
		guard modelPickerEnabled else { return }
		providerError = nil
		isSettingModel = true
		defer { isSettingModel = false }
		do {
			try await client.setModel(sessionId: sessionId, model: id)
			selectedModel = id
		} catch {
			providerError = error.localizedDescription
		}
	}

	/// Switches the leader mode (`leader.setMode`), even with a turn open.
	public func setMode(_ mode: LeaderMode) async {
		guard let workspaceId = workspaceId else { return }
		providerError = nil
		do {
			try await client.setMode(workspaceId: workspaceId, mode: mode)
		} catch {
			providerError = "Could not change mode: \(error.localizedDescription)"
		}
	}

	// MARK: - Private

	/// The provider owning this session's model.
	private var provider: String {
		switch selection {
		case .leader:
			return store.leader?.provider ?? ""
		case .mission(let id):
			guard let mission = store.missionsById[id] else {
				return store.leader?.provider ?? ""
			}
			switch mission.lead {
			case .leader:
				return store.leader?.provider ?? ""
			case .agent(let agentId):
				return store.agentsById[agentId]?.provider
					?? store.leader?.provider ?? ""
			}
		case .agent(let id):
			return store.agentsById[id]?.provider ?? store.leader?.provider ?? ""
		}
	}

	/// The session's current model id, for the picker's selection.
	private var currentModel: String {
		switch selection {
		case .leader:
			return store.leader?.model ?? ""
		case .mission(let id):
			guard let mission = store.missionsById[id] else {
				return store.leader?.model ?? ""
			}
			switch mission.lead {
			case .leader:
				return store.leader?.model ?? ""
			case .agent(let agentId):
				return store.agentsById[agentId]?.model
					?? store.leader?.model ?? ""
			}
		case .agent(let id):
			return store.agentsById[id]?.model ?? store.leader?.model ?? ""
		}
	}

	/// The workspace owning leader mode: the leader's, else the selection's.
	private var workspaceId: WorkspaceId? {
		if let leader = store.leader { return leader.workspaceId }
		switch selection {
		case .leader:
			return nil
		case .mission(let id):
			return store.missionsById[id]?.workspaceId
		case .agent(let id):
			return store.agentsById[id]?.workspaceId
		}
	}
}

private enum AttachmentError: LocalizedError {
	case message(String)
	var errorDescription: String? { if case .message(let value) = self { value } else { nil } }
}
