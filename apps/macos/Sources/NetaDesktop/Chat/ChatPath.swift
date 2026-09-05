import Foundation

/// The chat header's path, subtitle and leader tag (11-desktop-chat T11.5).
///
/// Segments always start at the workspace leader, then drill down: `#<number>
/// <name>` for a mission, the agent's name for an agent — `Halden › #304 Rate
/// limiter on /search › Thane`, or `Halden` alone for the leader. A mission
/// led by the leader ends at the mission; a mission led by an agent appends
/// that agent, since the mission opens the lead's session. Unknown ids fall
/// back to the leader alone, mirroring `ShellState.sessionId(in:)`.
public struct ChatPathSegment: Identifiable, Equatable, Sendable {
	public let id: String
	public let label: String
	public let selection: Selection
	public let isLast: Bool

	public init(id: String, label: String, selection: Selection, isLast: Bool) {
		self.id = id
		self.label = label
		self.selection = selection
		self.isLast = isLast
	}
}

public enum ChatPath {
	/// The breadcrumb for a selection. Only the last segment is primary;
	/// earlier ones are links back to their selections.
	@MainActor public static func segments(for s: Selection, store: Store) -> [ChatPathSegment] {
		let leader = leaderSegment(in: store, isLast: true)
		switch s {
		case .leader:
			return [leader]
		case .mission(let id):
			guard let mission = store.missionsById[id] else { return [leader] }
			var segments = [
				withLast(false, leader),
				missionSegment(mission, selection: .mission(id), isLast: true),
			]
			if case .agent(let agentId) = mission.lead,
				let agent = store.agentsById[agentId]
			{
				segments[1] = missionSegment(mission, selection: .mission(id), isLast: false)
				segments.append(agentSegment(agent, isLast: true))
			}
			return segments
		case .agent(let id):
			guard let agent = store.agentsById[id] else { return [leader] }
			var segments = [withLast(false, leader)]
			if let mission = store.missionsById[agent.missionId] {
				segments.append(missionSegment(
					mission, selection: .mission(mission.id), isLast: false))
			}
			segments.append(agentSegment(agent, isLast: true))
			return segments
		}
	}

	/// `provider · model · State` for the session the selection opens, with
	/// `read-only`/`read-write` before the state for agents. A mission
	/// resolves to its lead (the leader's session when the lead is the
	/// leader); unknown ids fall back to the leader.
	@MainActor public static func subtitle(
		for s: Selection, store: Store, isResponding: Bool = false
	) -> String {
		switch s {
		case .leader:
			return leaderSubtitle(store.leader, isResponding: isResponding)
		case .mission(let id):
			guard let mission = store.missionsById[id] else {
				return leaderSubtitle(store.leader, isResponding: isResponding)
			}
			switch mission.lead {
			case .leader:
				return leaderSubtitle(store.leader, isResponding: isResponding)
			case .agent(let agentId):
				guard let agent = store.agentsById[agentId] else {
					return leaderSubtitle(store.leader, isResponding: isResponding)
				}
				return agentSubtitle(agent, isResponding: isResponding)
			}
		case .agent(let id):
			guard let agent = store.agentsById[id] else {
				return leaderSubtitle(store.leader, isResponding: isResponding)
			}
			return agentSubtitle(agent, isResponding: isResponding)
		}
	}

	/// The `WORKSPACE LEADER` tag shows only for `.leader`.
	public static func showsLeaderTag(for s: Selection) -> Bool {
		s == .leader
	}

	// MARK: - Private

	@MainActor private static func leaderSegment(in store: Store, isLast: Bool) -> ChatPathSegment {
		let label = MissionBarModel.leaderDisplayName(store.leader)
		return ChatPathSegment(id: "leader", label: label, selection: .leader, isLast: isLast)
	}

	private static func missionSegment(
		_ mission: Mission, selection: Selection, isLast: Bool
	) -> ChatPathSegment {
		ChatPathSegment(
			id: "mission-\(mission.id)", label: "#\(mission.number) \(mission.name)",
			selection: selection, isLast: isLast)
	}

	private static func agentSegment(_ agent: Agent, isLast: Bool) -> ChatPathSegment {
		ChatPathSegment(
			id: "agent-\(agent.id)", label: agent.name,
			selection: .agent(agent.id), isLast: isLast)
	}

	private static func withLast(_ isLast: Bool, _ segment: ChatPathSegment) -> ChatPathSegment {
		ChatPathSegment(
			id: segment.id, label: segment.label,
			selection: segment.selection, isLast: isLast)
	}

	private static func leaderSubtitle(_ leader: Leader?, isResponding: Bool) -> String {
		guard let leader else { return "" }
		let state = isResponding ? "Responding" : leaderStateLabel(leader.state)
		return "\(leader.provider) · \(leader.model) · \(state)"
	}

	private static func agentSubtitle(_ agent: Agent, isResponding: Bool) -> String {
		let state = isResponding ? "Responding" : agentStateLabel(agent.state)
		return "\(agent.provider) · \(agent.model) · \(accessLabel(agent.access)) · \(state)"
	}

	private static func accessLabel(_ access: Access) -> String {
		switch access {
		case .readOnly: return "read-only"
		case .readWrite: return "read-write"
		}
	}

	private static func leaderStateLabel(_ state: LeaderState) -> String {
		switch state {
		case .idle: return "Idle"
		case .running: return "Running"
		case .failed: return "Failed"
		}
	}

	private static func agentStateLabel(_ state: AgentState) -> String {
		switch state {
		case .queued: return "Queued"
		case .starting: return "Starting"
		case .running: return "Running"
		case .blocked: return "Blocked"
		case .failed: return "Failed"
		case .completed: return "Completed"
		case .interrupted: return "Interrupted"
		case .archived: return "Archived"
		}
	}
}
