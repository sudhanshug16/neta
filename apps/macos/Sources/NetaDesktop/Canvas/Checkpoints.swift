import CoreGraphics
import Foundation
import Observation

/// Axis checkpoints (T10.7): one icon per state-changing event kind.
///
/// Icon table (PAPER-SPINE item 10): `leader.modeChanged` bolt;
/// `mission.merged` and `base.integrated` merge; `user.pinned` diamond;
/// `mission.failed` x; `charter.changed` document; `node.restarted` power;
/// `mission.closed` check; `mission.blocked` question. Every other
/// `EventKind` maps to `nil` and is not a checkpoint. Placement is pure: no
/// `Store`, no bare `Date()`, no SwiftUI state.
public enum CheckpointIcon: String, Sendable, CaseIterable {
	case bolt
	case merge
	case diamond
	case x
	case document
	case power
	case check
	case question
}

/// What opening a checkpoint requests. T10.11 consumes this; `open` sets
/// `pending` only and opens no surface.
public enum CheckpointAction: Sendable, Equatable {
	case scrollToTurn(sessionId: SessionId, turnId: TurnId)
	case openDecisionRecord(missionId: MissionId, seq: Int)
}

/// One checkpoint-eligible event placed on the axis.
///
/// `id` is `String(seq)`; `x` is `lens.x(at)`; `label` is the kind phrase
/// with a ` · #<number>` suffix when the event carries one in `data`
/// (for example "Lead++ · #308"); `relative` is the age from `now`
/// (for example "14m ago").
public struct Checkpoint: Sendable, Equatable, Identifiable {
	public let id: String
	public let seq: Int
	public let at: Date
	public let kind: EventKind
	public let icon: CheckpointIcon
	public let label, relative: String
	public let x: CGFloat
	public let missionId: MissionId?
	public let sessionId: SessionId?
	public let turnId: TurnId?

	public init(
		id: String, seq: Int, at: Date, kind: EventKind, icon: CheckpointIcon,
		label: String, relative: String, x: CGFloat,
		missionId: MissionId?, sessionId: SessionId?, turnId: TurnId?
	) {
		self.id = id
		self.seq = seq
		self.at = at
		self.kind = kind
		self.icon = icon
		self.label = label
		self.relative = relative
		self.x = x
		self.missionId = missionId
		self.sessionId = sessionId
		self.turnId = turnId
	}
}

/// Older checkpoints coalesced into one `N more` chip at the members'
/// mean x. Members are in `seq` order.
public struct CheckpointCluster: Sendable, Equatable, Identifiable {
	public let id: String
	public let x: CGFloat
	public let members: [Checkpoint]

	public init(id: String, x: CGFloat, members: [Checkpoint]) {
		self.id = id
		self.x = x
		self.members = members
	}
}

/// The known `EventKind` cases in domain order.
///
/// `EventKind` has an open-ended `unknown` case, so `CaseIterable` cannot
/// be synthesised; this lists the seventeen contract kinds for the
/// icon-table test.
extension EventKind: CaseIterable {
	public static var allCases: [EventKind] {
		[
			.missionCreated, .missionChanged, .missionBlocked, .missionUnblocked,
			.missionFailed, .missionReadyToClose, .missionMerged, .missionClosed,
			.agentSpawned, .agentFinished, .agentArchived,
			.leaderModeChanged, .leaderModeReminder,
			.baseIntegrated, .charterChanged, .nodeRestarted, .userPinned,
		]
	}
}

/// Routes checkpoint taps: `.scrollToTurn` when the checkpoint carries both
/// `sessionId` and `turnId`, else `.openDecisionRecord` (with `""` for the
/// mission when the event names none, so workspace-level events still
/// route). It opens no surface.
@Observable @MainActor public final class CheckpointRouter {
	public private(set) var pending: CheckpointAction?

	public init() {}

	public func open(_ checkpoint: Checkpoint) {
		if let sessionId = checkpoint.sessionId, let turnId = checkpoint.turnId {
			pending = .scrollToTurn(sessionId: sessionId, turnId: turnId)
		} else {
			pending = .openDecisionRecord(
				missionId: checkpoint.missionId ?? "", seq: checkpoint.seq)
		}
	}

	/// Returns `pending` and clears it.
	public func consume() -> CheckpointAction? {
		let action = pending
		pending = nil
		return action
	}
}

/// Checkpoint placement (T10.7).
///
/// Events whose kind has no icon are dropped. Events at or after
/// `lens.options.focusStart` stay individual `points`; older events
/// coalesce into `clusters`, grouped by x within
/// `metrics.checkpointClusterGap`, each at its members' mean x. Points are
/// in `seq` order; clusters run oldest to newest.
public enum Checkpoints {
	public static func icon(for kind: EventKind) -> CheckpointIcon? {
		switch kind {
		case .leaderModeChanged:
			return .bolt
		case .missionMerged, .baseIntegrated:
			return .merge
		case .userPinned:
			return .diamond
		case .missionFailed:
			return .x
		case .charterChanged:
			return .document
		case .nodeRestarted:
			return .power
		case .missionClosed:
			return .check
		case .missionBlocked:
			return .question
		case .missionCreated, .missionChanged, .missionUnblocked,
			.missionReadyToClose, .agentSpawned, .agentFinished,
			.agentArchived, .leaderModeReminder, .unknown:
			return nil
		}
	}

	public static func place(
		events: [Event],
		lens: TimeLens,
		now: Date,
		metrics: SpineMetrics = .standard
	) -> (points: [Checkpoint], clusters: [CheckpointCluster]) {
		let focusStart = lens.options.focusStart
		var points: [Checkpoint] = []
		var older: [Checkpoint] = []
		for event in events {
			guard let checkpoint = checkpoint(for: event, lens: lens, now: now) else {
				continue
			}
			if event.at.timeIntervalSince1970 * 1000 >= focusStart {
				points.append(checkpoint)
			} else {
				older.append(checkpoint)
			}
		}
		points.sort { $0.seq < $1.seq }
		return (points, cluster(older, gap: metrics.checkpointClusterGap))
	}

	// MARK: - Private

	private static func checkpoint(
		for event: Event, lens: TimeLens, now: Date
	) -> Checkpoint? {
		guard let icon = icon(for: event.kind) else { return nil }
		let atMs = event.at.timeIntervalSince1970 * 1000
		return Checkpoint(
			id: String(event.seq),
			seq: event.seq,
			at: event.at,
			kind: event.kind,
			icon: icon,
			label: label(for: event),
			relative: relativeString(at: event.at, now: now),
			x: CGFloat(lens.x(atMs)),
			missionId: event.missionId,
			sessionId: event.sessionId,
			turnId: event.turnId)
	}

	/// Product-language kind phrase, with a ` · #<number>` suffix when the
	/// event carries one in `data` (under `number` or `missionNumber`).
	private static func label(for event: Event) -> String {
		let base: String
		switch event.kind {
		case .leaderModeChanged:
			if case .string(let mode) = event.data["mode"], mode == "lead" {
				base = "Lead"
			} else {
				base = "Lead++"
			}
		case .missionMerged:
			base = "Merged"
		case .baseIntegrated:
			base = "Integrated"
		case .userPinned:
			base = "Pinned"
		case .missionFailed:
			base = "Failed"
		case .charterChanged:
			base = "Charter changed"
		case .nodeRestarted:
			base = "Node restarted"
		case .missionClosed:
			base = "Closed"
		case .missionBlocked:
			base = "Blocked"
		default:
			base = event.kind.rawValue
		}
		if let number = missionNumber(in: event.data) {
			return "\(base) · #\(number)"
		}
		return base
	}

	private static func missionNumber(in data: [String: DataValue]) -> Int? {
		for key in ["number", "missionNumber"] {
			if case .number(let value) = data[key] {
				return Int(value)
			}
		}
		return nil
	}

	/// Coarsest age bucket with an `ago` suffix, mirroring the lead card's
	/// `25m` / `2h` / `3d` / `2w` buckets.
	private static func relativeString(at date: Date, now: Date) -> String {
		let seconds = max(0, now.timeIntervalSince(date))
		if seconds < 60 { return "just now" }
		let minutes = Int(seconds / 60)
		if minutes < 60 { return "\(minutes)m ago" }
		let hours = Int(seconds / 3600)
		if hours < 24 { return "\(hours)h ago" }
		let days = Int(seconds / 86400)
		if days < 7 { return "\(days)d ago" }
		return "\(days / 7)w ago"
	}

	/// Single-linkage grouping over x-sorted checkpoints: a checkpoint
	/// joins the current group while it sits within `gap` of its
	/// predecessor, so every group is a run of neighbours at most `gap`
	/// apart. Each cluster sits at its members' mean x.
	private static func cluster(
		_ checkpoints: [Checkpoint], gap: CGFloat
	) -> [CheckpointCluster] {
		var groups: [[Checkpoint]] = []
		for checkpoint in checkpoints.sorted(by: { $0.x < $1.x }) {
			if let last = groups.last?.last,
				checkpoint.x - last.x > gap
			{
				groups.append([checkpoint])
			} else if groups.isEmpty {
				groups.append([checkpoint])
			} else {
				groups[groups.count - 1].append(checkpoint)
			}
		}
		return groups.map { group in
			let members = group.sorted { $0.seq < $1.seq }
			let meanX = group.reduce(CGFloat(0)) { $0 + $1.x } / CGFloat(group.count)
			return CheckpointCluster(
				id: "cluster-\(members.map(\.seq).min() ?? 0)",
				x: meanX,
				members: members)
		}
	}
}
