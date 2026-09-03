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

	public var draft = ""
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
	public func send() async {
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !isArchived, !text.isEmpty else { return }
		_ = try? await client.prompt(sessionId: sessionId, text: text)
		draft = ""
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
