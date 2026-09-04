import Foundation
import Observation

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
	public var hasOpenTurn = false
	public var isArchived = false
	public private(set) var models: [ModelInfo] = []
	public private(set) var selectedModel: String

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
		if hasOpenTurn { return .stop }
		return draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .sendDisabled : .send
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
		"\(instance.uuidString)\u{1}\(sessionId)\u{1}\(provider)"
	}

	/// The picker is dead while a turn streams or the session is archived.
	public var modelPickerEnabled: Bool {
		!hasOpenTurn && !isArchived
	}

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
		let provider = provider
		guard !provider.isEmpty else { return }
		guard let fetched = try? await client.listModels(provider: provider) else { return }
		models = fetched
		let current = currentModel
		if !current.isEmpty {
			selectedModel = current
		} else if selectedModel.isEmpty, let first = fetched.first {
			selectedModel = first.id
		}
	}

	/// Prompts with the trimmed draft and clears it. Empty drafts and
	/// archived sessions never prompt.
	///
	/// The echo goes in first so the person sees their own message with no
	/// wait, and comes back out again when the prompt throws: the draft is
	/// returned to the field (unless a new one has been started) and the
	/// echoed turn is retired, so the transcript never shows a message the
	/// Node never received.
	public func send() async {
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !isArchived, !text.isEmpty else { return }
		draft = ""
		onSend?(text)
		do {
			_ = try await client.prompt(sessionId: sessionId, text: text)
		} catch {
			onSendFailed?(text)
			if draft.isEmpty { draft = text }
		}
	}

	/// Cancels the open turn.
	public func stop() async {
		try? await client.cancel(sessionId: sessionId)
	}

	/// Switches the session model (`conversation.setModel`).
	public func setModel(_ id: String) async {
		try? await client.setModel(sessionId: sessionId, model: id)
		selectedModel = id
	}

	/// Switches the leader mode (`leader.setMode`), even with a turn open.
	public func setMode(_ mode: LeaderMode) async {
		guard let workspaceId = workspaceId else { return }
		try? await client.setMode(workspaceId: workspaceId, mode: mode)
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
