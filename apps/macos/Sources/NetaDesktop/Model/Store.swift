import Foundation
import Observation

/// The app's picture of the Node (09-desktop-shell T9.5).
///
/// The app never owns a session and only reads `~/.neta/node.json` through a
/// `NodeClient`. On reconnect the cache is replaced whole, never patched:
/// `replace(snapshot:)` swaps every collection and resets the window, so
/// nothing survives the previous connection. Live `NodeNotification`s patch
/// the picture via `apply(notification:)`.
///
/// `attention` is derived on read, never stored. The block cache follows
/// `MANIFESTO.md` "Clients, cache, and offline state": at most 1 MB of
/// display blocks per session and 100 sessions, evicting the least recently
/// viewed session whole. Only `noteViewed` moves a session in the recency
/// order; caching or live appends never reorder it.
@Observable @MainActor public final class Store {
	/// Maximum cached sessions; the least recently viewed is evicted whole.
	public static let maxCachedSessions = 100
	/// Maximum cached display bytes per session; oldest blocks drop first.
	public static let maxBytesPerSession = 1_000_000

	public private(set) var machine: Machine?
	public private(set) var workspaces: [Workspace] = []
	/// Every leader the snapshot carried, by workspace. The Node lists one
	/// per open workspace, and more than one workspace is open the moment a
	/// `neta` command runs in a second repo.
	public private(set) var leaders: [WorkspaceId: Leader] = [:]
	/// The workspace the shell is showing; `leader` follows it.
	public private(set) var currentWorkspaceId: WorkspaceId?
	public private(set) var nodeState: NodeLifecycle?
	/// True once the app has given up reaching the Node. Cleared by the next
	/// snapshot, so the machine reads `Online` again as soon as it connects.
	///
	/// This, not `nodeState`, is the source for the navigator's machine row:
	/// `NodePhase` (`Model/Domain.swift`, 01-domain) has only `restarting`
	/// and `stopping`, and the Node cannot send a lifecycle notification
	/// while it is unreachable, so an unreachable Node can never appear on
	/// `nodeState`. The row reads `Offline` when `nodeOffline`, else
	/// `Online`, with a text label beside the dot — status is never colour
	/// alone.
	public private(set) var nodeOffline = false
	public private(set) var nodeError: String?
	public private(set) var nodeRecoveryAvailable = false
	public private(set) var nodeRecoveryGeneration = 0
	public private(set) var nodeRecoveryRequest = 0
	public private(set) var nodeRecoveryInProgress = false
	public private(set) var sessionReadinessGeneration = 0
	/// False while the desktop is reconnecting the persisted ACP session.
	/// Snapshot records remain visible during this interval, but writes must
	/// wait until `workspace.open` has successfully resumed the provider.
	public private(set) var sessionsReady = true

	/// The current workspace's leader. Never `leaders.first`: with two
	/// workspaces open that picked whichever the Node listed first, not the
	/// one the person is looking at.
	public var leader: Leader? {
		guard let currentWorkspaceId else { return nil }
		return leaders[currentWorkspaceId]
	}
	/// Sorted by `createdAt` ascending (ties by number).
	///
	/// Every open workspace's missions, because the Node lists them all in
	/// one snapshot. Nothing that draws the current workspace may read this:
	/// the spine, the mission bar and the navigator read `currentMissions`,
	/// or two open workspaces interleave on the spine and the bar draws two
	/// `#1`s.
	public private(set) var missions: [Mission] = []
	public private(set) var missionsById: [Ulid: Mission] = [:]
	public private(set) var missionsByNumber: [Int: Mission] = [:]
	public private(set) var agentsById: [Ulid: Agent] = [:]
	/// Sorted by `seq` ascending.
	public private(set) var events: [Event] = []
	/// What the canvas may draw.
	public private(set) var window: ClosedRange<Date> = Date.distantPast...Date.distantPast

	/// Session blocks oldest-first; `recency` is most-recent-first and holds
	/// exactly the cached sessions.
	private var blockCache: [SessionId: [Block]] = [:]
	private var recency: [SessionId] = []

	public init() {}

	/// The current workspace's missions, in the same order. The one list
	/// the shell draws: `Shell/RootView.swift`'s mission bar and
	/// `Canvas/SpineCanvasView.swift`'s index and agent map both read it,
	/// the way `Shell/Navigator.swift` already filtered for itself.
	///
	/// Before the first snapshot names a workspace there is nothing to
	/// filter against, so every mission stands; that is also what keeps a
	/// fixture with no workspace record drawing.
	public var currentMissions: [Mission] {
		guard let currentWorkspaceId else { return missions }
		return missions.filter { $0.workspaceId == currentWorkspaceId }
	}

	/// The current workspace's agents, keyed by mission, for the spine's
	/// stacks. Filtered on the agent's own workspace, so an agent whose
	/// mission has aged out of the window still lands under the right
	/// workspace.
	public var currentAgentsByMission: [MissionId: [Agent]] {
		guard let currentWorkspaceId else {
			return Dictionary(grouping: agentsById.values, by: \.missionId)
		}
		return Dictionary(
			grouping: agentsById.values.filter {
				$0.workspaceId == currentWorkspaceId
			},
			by: \.missionId)
	}

	/// The current workspace's events, for the spine's checkpoints.
	public var currentEvents: [Event] {
		guard let currentWorkspaceId else { return events }
		return events.filter { $0.workspaceId == currentWorkspaceId }
	}

	/// Derived on every read, never stored: missions needing the person,
	/// ordered blocked, failed, readyToClose, mergedNotClosed, then by number.
	public var attention: [Mission] {
		missions
			.filter(\.needsPerson)
			.sorted { (Store.attentionRank($0.state), $0.number) < (Store.attentionRank($1.state), $1.number) }
	}

	/// Swaps every collection in one assignment set and resets `window` to
	/// `[oldest open mission's createdAt, snapshot.at]`; nothing survives the
	/// previous connection, including the block cache and node state.
	public func replace(snapshot: Snapshot) {
		machine = snapshot.machine
		workspaces = snapshot.workspaces
		var byWorkspace: [WorkspaceId: Leader] = [:]
		for leader in snapshot.leaders { byWorkspace[leader.workspaceId] = leader }
		leaders = byWorkspace
		// The selection survives a snapshot that still carries it: a reconnect
		// must not throw a person who picked the second workspace back to the
		// first. Only an unset selection, or one whose workspace the Node no
		// longer lists, takes the default: the first workspace when it has a
		// leader, else the first leader's workspace, else the first workspace.
		let keepsSelection = currentWorkspaceId.map { id in
			snapshot.workspaces.contains { $0.id == id }
		} ?? false
		if !keepsSelection {
			if let first = snapshot.workspaces.first, byWorkspace[first.id] != nil {
				currentWorkspaceId = first.id
			} else {
				currentWorkspaceId = snapshot.leaders.first?.workspaceId ?? snapshot.workspaces.first?.id
			}
		}
		nodeState = nil
		nodeOffline = false
		missions = snapshot.missions.sorted(by: Store.missionOrder)
		reindexMissions()
		var agents: [Ulid: Agent] = [:]
		for agent in snapshot.agents { agents[agent.id] = agent }
		agentsById = agents
		events = snapshot.events.sorted { $0.seq < $1.seq }
		let upper = snapshot.at
		let oldestOpen = snapshot.missions
			.filter { $0.state != .closed }
			.map(\.createdAt)
			.min()
		window = (oldestOpen.map { min($0, upper) } ?? upper)...upper
		blockCache = [:]
		recency = []
	}

	/// Patches the picture: `event` appends (kept sorted, even for an unknown
	/// mission), `state` upserts a Mission, Agent or Leader, `turn` appends a
	/// live block to that session's cache, `node` stores the lifecycle.
	public func apply(notification: NodeNotification) {
		switch notification {
		case .event(let event):
			events.append(event)
			events.sort { $0.seq < $1.seq }
		case .state(let change):
			switch change.record {
			case .mission(let mission):
				upsertMission(mission)
			case .agent(let agent):
				agentsById[agent.id] = agent
			case .leader(let next):
				leaders[next.workspaceId] = next
				if currentWorkspaceId == nil { currentWorkspaceId = next.workspaceId }
			}
		case .turn(let change):
			if let block = change.block {
				storeBlocks([block], for: change.sessionId)
			}
		case .node(let lifecycle):
			nodeState = lifecycle
		case .glance:
			break
		}
	}

	/// Points `leader` at another open workspace. The shell calls it when the
	/// person picks a workspace; an id with no leader leaves `leader` nil
	/// rather than falling back to another workspace's.
	///
	/// This is the only writer of the selection outside `replace(snapshot:)`.
	/// The workspace picker (`Shell/ToolbarCapsule.swift`) and the navigator's
	/// workspace rows (`Shell/Navigator.swift`) must call it and read the
	/// selection from `currentWorkspaceId`, never derive it from
	/// `leader?.workspaceId`, which now follows the selection and is circular.
	public func setCurrentWorkspace(_ workspaceId: WorkspaceId) {
		currentWorkspaceId = workspaceId
	}

	/// Records that the app could not reach the Node, so the machine reads
	/// `Offline`. The next snapshot clears it.
	public func setNodeOffline(_ offline: Bool) {
		nodeOffline = offline
	}
	public func setNodeError(_ message: String?, recoveryAvailable: Bool = false) {
		nodeError = message
		nodeRecoveryAvailable = message != nil && recoveryAvailable
	}
	public func beginNodeRecovery() { nodeRecoveryInProgress = true }
	public func requestNodeRecovery() { nodeRecoveryRequest += 1 }
	public func markSessionsReady() {
		sessionsReady = true
		sessionReadinessGeneration += 1
	}
	public func beginSessionsResume() { sessionsReady = false }
	public func finishNodeRecovery(error: String?) {
		nodeRecoveryInProgress = false
		nodeError = error
		nodeRecoveryAvailable = false
		if error == nil { nodeRecoveryGeneration += 1 }
	}

	/// Merges older pages and moves `window.lowerBound` back. Nothing loaded
	/// is dropped: missions upsert by id, events merge by seq.
	public func extendWindow(back: Date, missions newMissions: [Mission], events newEvents: [Event]) {
		for mission in newMissions {
			if let index = missions.firstIndex(where: { $0.id == mission.id }) {
				missions[index] = mission
			} else {
				missions.append(mission)
			}
		}
		missions.sort(by: Store.missionOrder)
		reindexMissions()
		var knownSeqs = Set(events.map(\.seq))
		for event in newEvents where knownSeqs.insert(event.seq).inserted {
			events.append(event)
		}
		events.sort { $0.seq < $1.seq }
		window = min(back, window.lowerBound)...window.upperBound
	}

	/// Cached display blocks for a session, oldest-first. A pure read: it
	/// never reorders recency.
	public func blocks(for sessionId: Ulid) -> [Block] {
		blockCache[sessionId] ?? []
	}

	/// Marks a session viewed, moving it to the recency front. The only
	/// operation that reorders recency; unknown sessions are ignored.
	public func noteViewed(_ sessionId: Ulid) {
		guard let index = recency.firstIndex(of: sessionId) else { return }
		recency.remove(at: index)
		recency.insert(sessionId, at: 0)
	}

	/// Merges a fetched page into the session's cache. New sessions enter at
	/// the recency front; re-caching a known session keeps its place.
	public func cache(_ page: ConversationPage, for sessionId: Ulid) {
		storeBlocks(page.blocks, for: sessionId)
	}

	/// Cached sessions, most recent first.
	public var cachedSessionIds: [Ulid] { recency }

	/// Cached display bytes for a session: the UTF-8 length of its block texts.
	public func cachedBytes(for sessionId: Ulid) -> Int {
		(blockCache[sessionId] ?? []).reduce(0) { $0 + $1.text.utf8.count }
	}

	// MARK: - Private

	private func upsertMission(_ mission: Mission) {
		if let index = missions.firstIndex(where: { $0.id == mission.id }) {
			missions[index] = mission
		} else {
			missions.append(mission)
		}
		missions.sort(by: Store.missionOrder)
		reindexMissions()
	}

	/// Rebuilds both indexes from `missions`, so a renumbered mission leaves
	/// no stale entry behind.
	private func reindexMissions() {
		var byId: [Ulid: Mission] = [:]
		var byNumber: [Int: Mission] = [:]
		for mission in missions {
			byId[mission.id] = mission
			byNumber[mission.number] = mission
		}
		missionsById = byId
		missionsByNumber = byNumber
	}

	private func storeBlocks(_ newBlocks: [Block], for sessionId: Ulid) {
		var current = blockCache[sessionId] ?? []
		current.append(contentsOf: newBlocks)
		var seen = Set<String>()
		current = current.filter { seen.insert("\($0.turnId)#\($0.seq)").inserted }
		current.sort { ($0.at, $0.seq) < ($1.at, $1.seq) }
		var bytes = current.reduce(0) { $0 + $1.text.utf8.count }
		while bytes > Self.maxBytesPerSession, !current.isEmpty {
			bytes -= current.removeFirst().text.utf8.count
		}
		if blockCache[sessionId] == nil {
			recency.insert(sessionId, at: 0)
		}
		blockCache[sessionId] = current
		while recency.count > Self.maxCachedSessions {
			blockCache.removeValue(forKey: recency.removeLast())
		}
	}

	private static func missionOrder(_ a: Mission, _ b: Mission) -> Bool {
		(a.createdAt, a.number) < (b.createdAt, b.number)
	}

	private static func attentionRank(_ state: MissionState) -> Int {
		switch state {
		case .blocked: return 0
		case .failed: return 1
		case .readyToClose: return 2
		case .mergedNotClosed: return 3
		case .running, .closed: return 4
		}
	}
}
