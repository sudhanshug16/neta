import Foundation

/// The Details inspector's content and adaptive placement (11-desktop-chat
/// T11.7).
///
/// Details is the one secondary action on the chat surface (MANIFESTO.md
/// "Desktop information architecture"): it either sits beside the transcript
/// on wide windows or replaces it on narrow ones. It is never a tab bar.
/// Absent optionals are omitted, never rendered blank.
public enum DetailsPlacement: Equatable, Sendable {
	case beside
	case replacing

	/// `.beside` at 1500 points and above, `.replacing` below.
	public static func forWidth(_ width: CGFloat) -> DetailsPlacement {
		width >= 1500 ? .beside : .replacing
	}
}

public struct DetailsField: Identifiable, Equatable, Sendable {
	public let id: String
	public let label: String
	public let value: String
	public let mono: Bool

	public init(id: String, label: String, value: String, mono: Bool = false) {
		self.id = id
		self.label = label
		self.value = value
		self.mono = mono
	}
}

public enum DetailsModel {
	/// The inspector title: the leader's display name, `#<number> <name>`
	/// for a mission, the agent's name. Unknown ids fall back to the leader,
	/// mirroring `ShellState.sessionId(in:)`.
	@MainActor public static func title(for s: Selection, store: Store) -> String {
		switch s {
		case .leader:
			return leaderTitle(store.leader)
		case .mission(let id):
			guard let mission = store.missionsById[id] else {
				return leaderTitle(store.leader)
			}
			return "#\(mission.number) \(mission.name)"
		case .agent(let id):
			guard let agent = store.agentsById[id] else {
				return leaderTitle(store.leader)
			}
			return agent.name
		}
	}

	/// The inspector rows for a selection. A mission lead's rows are the
	/// permanent number, name, objective, one row per accepted change newest
	/// first, worktree path and branch, integration, and disposition. An
	/// agent's rows are task, access, provider, model, skills, activity, and
	/// outcome. The leader's rows are the mode with active minutes, then the
	/// nine decision-record lines, or `No Lead++ decision recorded` when
	/// `decision` is nil.
	@MainActor public static func fields(
		for s: Selection, store: Store, decision: DecisionRecord?
	) -> [DetailsField] {
		switch s {
		case .leader:
			return leaderFields(leader: store.leader, decision: decision)
		case .mission(let id):
			guard let mission = store.missionsById[id] else { return [] }
			return missionFields(mission)
		case .agent(let id):
			guard let agent = store.agentsById[id] else { return [] }
			return agentFields(agent)
		}
	}

	// MARK: - Missions

	private static func missionFields(_ mission: Mission) -> [DetailsField] {
		var fields = [
			DetailsField(id: "number", label: "Number", value: "\(mission.number)", mono: true),
			DetailsField(id: "name", label: "Name", value: mission.name),
			DetailsField(id: "objective", label: "Objective", value: mission.objective),
		]
		for (index, change) in mission.changes.reversed().enumerated() {
			fields.append(DetailsField(
				id: "change-\(index)", label: "Scope change", value: change.text))
		}
		if let worktree = mission.worktree {
			fields.append(DetailsField(
				id: "worktree-path", label: "Worktree path",
				value: worktree.path, mono: true))
			fields.append(DetailsField(
				id: "worktree-branch", label: "Branch",
				value: worktree.branch, mono: true))
		}
		if let integration = mission.integration {
			fields.append(DetailsField(
				id: "integration", label: "Integration",
				value: "merged \(integration.commit) into \(integration.base)",
				mono: true))
		} else {
			fields.append(DetailsField(
				id: "integration", label: "Integration", value: "not merged"))
		}
		if let disposition = mission.disposition {
			fields.append(DetailsField(
				id: "disposition", label: "Disposition",
				value: dispositionLabel(disposition)))
		}
		return fields
	}

	private static func dispositionLabel(_ disposition: Disposition) -> String {
		switch disposition {
		case .merged: return "Merged"
		case .abandoned: return "Abandoned"
		}
	}

	// MARK: - Agents

	private static func agentFields(_ agent: Agent) -> [DetailsField] {
		var fields = [
			DetailsField(id: "task", label: "Task", value: agent.task),
			DetailsField(
				id: "access", label: "Access",
				value: agent.access == .readWrite ? "read-write" : "read-only"),
			DetailsField(id: "provider", label: "Provider", value: agent.provider),
			DetailsField(id: "model", label: "Model", value: agent.model, mono: true),
		]
		if !agent.skills.isEmpty {
			fields.append(DetailsField(
				id: "skills", label: "Skills",
				value: agent.skills.joined(separator: ", ")))
		}
		if let activity = agent.activity {
			fields.append(DetailsField(
				id: "activity", label: "Activity", value: activity.text))
		}
		if let outcome = agent.outcome {
			fields.append(DetailsField(
				id: "outcome", label: "Outcome", value: outcome))
		}
		return fields
	}

	// MARK: - Leader

	private static func leaderFields(
		leader: Leader?, decision: DecisionRecord?
	) -> [DetailsField] {
		var fields: [DetailsField] = []
		if let leader {
			fields.append(DetailsField(
				id: "mode", label: "Mode", value: modeText(leader)))
		}
		if let decision {
			fields += decisionFields(decision)
		} else {
			fields.append(DetailsField(
				id: "decision", label: "Decision",
				value: "No Lead++ decision recorded"))
		}
		return fields
	}

	private static func modeText(_ leader: Leader) -> String {
		guard leader.mode == .leadPlus else { return "Lead" }
		return "Lead++ · \(leader.modeActiveMs / 60_000) min active"
	}

	private static func decisionFields(_ decision: DecisionRecord) -> [DetailsField] {
		var fields = [
			DetailsField(
				id: "decision-objective", label: "Objective",
				value: decision.objective),
			DetailsField(
				id: "decision-why", label: "Why Lead is insufficient",
				value: decision.whyLeadInsufficient),
			DetailsField(
				id: "decision-mission", label: "Mission",
				value: decision.missionId, mono: true),
		]
		if let worktreePath = decision.worktreePath {
			fields.append(DetailsField(
				id: "decision-worktree", label: "Worktree path",
				value: worktreePath, mono: true))
		}
		fields += [
			DetailsField(
				id: "decision-mutation", label: "Mutation kind",
				value: decision.mutationKind),
			DetailsField(
				id: "decision-files", label: "Estimated files",
				value: "\(decision.estimatedFiles)", mono: true),
			DetailsField(
				id: "decision-validation", label: "Validation",
				value: decision.validation),
			DetailsField(
				id: "decision-minutes", label: "Estimated minutes",
				value: "\(decision.estimatedMinutes)", mono: true),
			DetailsField(
				id: "decision-external", label: "External effects",
				value: decision.externalEffects),
		]
		return fields
	}

	// MARK: - Titles

	private static func leaderTitle(_ leader: Leader?) -> String {
		MissionBarModel.leaderDisplayName(leader)
	}
}
