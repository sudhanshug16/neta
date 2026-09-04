import Foundation
import Observation

/// The chat panel's state: one transcript plus one composer per selection
/// (11-desktop-chat T11.8).
///
/// The panel owns nothing itself: `client` is the Node transport, `store`
/// the app's picture of the Node, `shell` the person's view. `select`
/// moves the shell and rebuilds the composer for the new selection, plus
/// the transcript when the selection opens a different session, so a stale
/// transcript can never linger behind a breadcrumb and a live one is never
/// replaced by a blank.
/// `sync` re-resolves the selection and the session against the shell and
/// the store and rebuilds when either moved, which is how a workspace
/// switch, a reconnect or the first snapshot (the leader, and with it the
/// session id, arrives after the panel is built) reaches the panel: the
/// panel model itself is owned by `RootView` in `@State` and outlives every
/// body pass, so nothing else rebuilds it.
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

	/// The session the shell's current selection resolves to right now.
	/// Reading it tracks both the shell and the store, so a view can observe
	/// it and call `sync()` when the store brings the leader in or the person
	/// switches workspace.
	public var currentSessionId: SessionId {
		Self.sessionId(for: shell.selection, in: store)
	}

	/// Moves to `selection` and rebuilds for its session: a fresh composer,
	/// and a fresh transcript when the session changed, so the panel never
	/// shows one selection's turns under another's header.
	///
	/// The rebuild is conditional: the same selection resolving to the same
	/// session is left exactly as it is, draft, scroll position and open
	/// inspector included, so a live update that re-runs this cannot wipe
	/// what the person is typing.
	public func select(_ selection: Selection) {
		shell.select(selection)
		rebuild(selection: selection, sessionId: Self.sessionId(for: selection, in: store))
	}

	/// Re-resolves against the shell and the store, rebuilding only when the
	/// selection or its session moved. The panel view calls it when either
	/// changes; `select` is the same thing with the shell moved first.
	public func sync() {
		rebuild(selection: shell.selection, sessionId: currentSessionId)
	}

	/// Routes a checkpoint the canvas opened (10-desktop-spine T10.8: the
	/// canvas fills `CheckpointRouter` and 11 consumes it). A checkpoint on
	/// a conversation turn scrolls the transcript to that turn; anything
	/// else opens the decision record in Details, on that mission's
	/// conversation when the checkpoint names one.
	public func handle(_ action: CheckpointAction) async {
		switch action {
		case .scrollToTurn(let sessionId, let turnId):
			if sessionId != self.sessionId,
				let selection = Self.selection(forSession: sessionId, in: store)
			{
				select(selection)
				await start()
			}
			await scrollTo(turnId: turnId)
		case .openDecisionRecord(let missionId, _):
			if !missionId.isEmpty, store.missionsById[missionId] != nil {
				select(.mission(missionId))
			}
			isDetailsOpen = true
		}
	}

	// MARK: - Rebuild

	/// The one rebuild path: a fresh composer for a selection that moved, and
	/// a fresh transcript only for a session that actually changed.
	///
	/// The transcript is deliberately kept when the session id is unchanged.
	/// A fresh `ChatViewModel` has neither tailed nor subscribed until
	/// something calls `start()`, and nothing here can call it — `start()` is
	/// async and this path is not. Every leader-led mission resolves to the
	/// leader's session, so `.leader -> .mission(m)` used to stop the live
	/// transcript and install a blank one that never tailed and never
	/// streamed: the conversation blanked and a prompt sent from that
	/// composer streamed into nothing. Keeping the live transcript is the
	/// fix; `transcriptId` is the backstop that makes an unstarted one
	/// visible to the panel view.
	///
	/// The composer is rebuilt whenever the selection or the session moved,
	/// because its placeholder, its mode control, its provider and its model
	/// all read the selection, not only the session.
	private func rebuild(selection: Selection, sessionId sid: SessionId) {
		guard selection != self.selection || sid != sessionId else { return }
		self.selection = selection
		if sid != sessionId {
			sessionId = sid
			transcript.stop()
			transcript = ChatViewModel(client: client, sessionId: sid)
		}
		composer = ComposerModel(
			client: client, store: store, sessionId: sid, selection: selection)
		followOpenTurn()
		syncComposer()
	}

	/// Identifies the transcript now installed. `ChatPanel` observes this
	/// rather than `sessionId`, so that any path which does install a fresh
	/// `ChatViewModel` restarts it. A session-id watch missed exactly the
	/// case above: the transcript was replaced while the id stood still, and
	/// the replacement was left untailed and unstreamed for the life of the
	/// selection.
	public var transcriptId: ObjectIdentifier { ObjectIdentifier(transcript) }

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
		composer.onSend = { [weak self] text in
			self?.transcript.echoUserMessage(text)
		}
		composer.onSendFailed = { [weak self] text in
			self?.transcript.retireEcho(text)
		}
	}

	/// Which selection owns a session, for a checkpoint that names one.
	/// The leader first, then agents; an unknown session has no selection.
	private static func selection(
		forSession sessionId: SessionId, in store: Store
	) -> Selection? {
		if store.leader?.sessionId == sessionId { return .leader }
		if let agent = store.agentsById.values.first(where: {
			$0.sessionId == sessionId
		}) {
			return .agent(agent.id)
		}
		return nil
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
