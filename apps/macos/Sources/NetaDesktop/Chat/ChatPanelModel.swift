import Foundation
import Observation

/// The chat panel's state: one transcript plus one composer per selection
/// (11-desktop-chat T11.8).
///
/// The panel owns nothing itself: `client` is the Node transport, `store`
/// the app's picture of the Node, `shell` the person's view. `select`
/// moves the shell and rebuilds both view models for the new selection's
/// session, so a stale transcript can never linger behind a breadcrumb.
/// `scrollTo` forwards to the transcript; `start` tails the live end.
/// `syncComposer` re-derives the composer's `hasOpenTurn` from the
/// transcript's open turn and its `isArchived` from the store, and runs
/// after every rebuild, tail and scroll.
@MainActor @Observable public final class ChatPanelModel {
	public let client: any NodeClient
	public let store: Store
	public let shell: ShellState
	public private(set) var selection: Selection
	public private(set) var sessionId: SessionId
	public private(set) var transcript: ChatViewModel
	public private(set) var composer: ComposerModel
	/// Whether the Details inspector is open. Toggled by the header's
	/// Details button; the panel keeps it across live updates and leaves
	/// it alone on `select`, since the inspector reads the new selection.
	public var isDetailsOpen = false
	/// The Lead++ decision record shown in the inspector, when recorded.
	public var decision: DecisionRecord?

	public init(
		client: any NodeClient, store: Store, shell: ShellState,
		selection: Selection? = nil, decision: DecisionRecord? = nil
	) {
		self.client = client
		self.store = store
		self.shell = shell
		let resolved = selection ?? shell.selection
		self.selection = resolved
		self.decision = decision
		let sid = Self.sessionId(for: resolved, in: store)
		self.sessionId = sid
		self.transcript = ChatViewModel(client: client, sessionId: sid)
		self.composer = ComposerModel(
			client: client, store: store, sessionId: sid, selection: resolved)
		followOpenTurn()
		syncComposer()
	}

	/// Moves to `selection` and rebuilds both view models for its session:
	/// a fresh transcript and a fresh composer, so the panel never shows
	/// one selection's turns under another's header.
	public func select(_ selection: Selection) {
		shell.select(selection)
		self.selection = selection
		let sid = Self.sessionId(for: selection, in: store)
		sessionId = sid
		transcript.stop()
		transcript = ChatViewModel(client: client, sessionId: sid)
		composer = ComposerModel(
			client: client, store: store, sessionId: sid, selection: selection)
		followOpenTurn()
		syncComposer()
	}

	/// Reveals `turnId`, flashing it when it is already loaded; otherwise
	/// pages back until it arrives. Forwards to the transcript, whose
	/// `pendingScroll` the panel view drains via `consumeScroll`.
	public func scrollTo(turnId: TurnId) async {
		await transcript.scrollTo(turnId: turnId)
		syncComposer()
	}

	/// Tails the newest page, then streams this session's live turns.
	public func start() async {
		await transcript.start()
		syncComposer()
	}

	/// Re-derives the composer flags: Stop while the transcript has an
	/// open turn, read-only when the store says the session is archived.
	public func syncComposer() {
		composer.hasOpenTurn = transcript.openTurnId != nil
		composer.isArchived = Self.archived(for: selection, in: store)
	}

	/// Makes the composer follow the transcript's open turn as it changes,
	/// not only after a tail or a select: the turn closes on a streamed
	/// notification, and Stop has to become Send at that moment.
	private func followOpenTurn() {
		transcript.onOpenTurnChange = { [weak self] in
			self?.syncComposer()
		}
	}

	// MARK: - Private

	/// The ACP session a selection opens, mirroring
	/// `ShellState.sessionId(in:)` without moving the shell: the leader's
	/// session for the leader and leader-led missions, the agent's for
	/// agents and agent-led missions. Unknown ids fall back to the leader.
	private static func sessionId(for s: Selection, in store: Store) -> SessionId {
		switch s {
		case .leader:
			return store.leader?.sessionId ?? ""
		case .mission(let id):
			guard let mission = store.missionsById[id] else {
				return store.leader?.sessionId ?? ""
			}
			switch mission.lead {
			case .leader:
				return store.leader?.sessionId ?? ""
			case .agent(let agentId):
				return store.agentsById[agentId]?.sessionId
					?? store.leader?.sessionId ?? ""
			}
		case .agent(let id):
			return store.agentsById[id]?.sessionId
				?? store.leader?.sessionId ?? ""
		}
	}

	/// Whether the selection's session is read-only: an archived agent, or
	/// a closed (archived) mission. The leader's session is never archived.
	private static func archived(for s: Selection, in store: Store) -> Bool {
		switch s {
		case .leader:
			return false
		case .mission(let id):
			return store.missionsById[id]?.state == .closed
		case .agent(let id):
			return store.agentsById[id]?.state == .archived
		}
	}
}
