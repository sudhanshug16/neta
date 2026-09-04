import CoreGraphics
import Foundation
import Observation

/// Axis checkpoints (T10.8): one icon per state-changing event kind.
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

/// What opening a checkpoint requests. The chat workstream consumes this;
/// `open` sets `pending` only and opens no surface.
public enum CheckpointAction: Sendable, Equatable {
	case scrollToTurn(sessionId: SessionId, turnId: TurnId)
	case openDecisionRecord(missionId: MissionId, seq: Int)
}

/// One checkpoint-eligible event placed on the axis.
///
/// `id` is `String(seq)`; `x` is the checkpoint's screen x, taken from
/// `index.x` of its sequence item (never from a separate scale); `label` is
/// the kind phrase with a ` · #<number>` suffix when the event carries one
/// in `data` (for example "Lead++ · #308"); `relative` is the age from `now`
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

/// Checkpoint placement (T10.8).
///
/// A checkpoint is an item in the sequence, so its x comes from `index.x`,
/// mapped to screen coordinates; the spacing rule keeps neighbours
/// `checkpointPitch` apart, so checkpoints never pile up and nothing
/// coalesces. Events whose kind has no icon are dropped. Points are in
/// `seq` order.
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
		index: SpineIndex,
		events: [Event],
		range: Range<Int>,
		scrollX: CGFloat,
		viewport: CGRect,
		now: Date
	) -> [Checkpoint] {
		var bySeq: [Int: Event] = [:]
		bySeq.reserveCapacity(events.count)
		for event in events { bySeq[event.seq] = event }
		let lo = max(0, range.lowerBound)
		let hi = min(index.count, range.upperBound)
		var points: [Checkpoint] = []
		for i in lo ..< hi {
			guard case .checkpoint(let seq, _) = index[i],
				let event = bySeq[seq],
				let icon = icon(for: event.kind)
			else {
				continue
			}
			points.append(Checkpoint(
				id: String(event.seq),
				seq: event.seq,
				at: event.at,
				kind: event.kind,
				icon: icon,
				label: label(for: event),
				relative: relativeString(at: event.at, now: now),
				x: index.x(i) - scrollX + viewport.minX,
				missionId: event.missionId,
				sessionId: event.sessionId,
				turnId: event.turnId))
		}
		points.sort { $0.seq < $1.seq }
		return points
	}

	// MARK: - Private

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
}
