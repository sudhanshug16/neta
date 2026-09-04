import CoreGraphics
import Foundation

/// Which side of the spine a mission's card sits on (T10.3).
///
/// The side is a pure function of the permanent mission number — odd above,
/// even below — so a side never changes and neighbours always alternate.
public enum SpineSide: Sendable, Equatable {
	case above
	case below
}

/// One mission's mark on the time axis: its position plus its state.
public struct MissionTick: Sendable, Equatable {
	public let x: CGFloat
	public let state: MissionState

	public init(x: CGFloat, state: MissionState) {
		self.x = x
		self.state = state
	}
}

/// The laid-out column for one mission (T10.3).
///
/// The card sits directly over (above) or under (below) its own anchor,
/// centred on `anchor.x` with its near edge `spineOffset` from the axis. A
/// closed mission's card is `closedNodeWidth x closedNodeHeight` centred the
/// same way, `collapsed`, with no `rows`. `rows` holds one rect per
/// `stack.items` entry in the same order. `connector` is exactly two points —
/// the anchor and the card's near edge, both at `anchor.x`: nothing bends.
public struct MissionColumn: Sendable, Equatable, Identifiable {
	public let id: MissionId
	public let number: Int
	public let side: SpineSide
	/// The mission state, carried for anchor/tick painting (T10.5): a state
	/// change never moves the column, but it does recolour its anchor.
	public let state: MissionState
	public let anchor: CGPoint
	public let card: CGRect
	public let connector: [CGPoint]
	public let stack: AgentStack
	public let rows: [CGRect]
	public let collapsed: Bool

	public init(
		id: MissionId, number: Int, side: SpineSide, state: MissionState,
		anchor: CGPoint, card: CGRect, connector: [CGPoint],
		stack: AgentStack, rows: [CGRect], collapsed: Bool
	) {
		self.id = id
		self.number = number
		self.side = side
		self.state = state
		self.anchor = anchor
		self.card = card
		self.connector = connector
		self.stack = stack
		self.rows = rows
		self.collapsed = collapsed
	}
}

/// The whole placed spine: the axis height, the pinned leader card, one
/// column per mission in the requested range, and one tick per mission.
public struct Placement: Sendable, Equatable {
	public let spineY: CGFloat
	public let leader: CGRect
	public let columns: [MissionColumn]
	public let ticks: [MissionTick]

	public init(
		spineY: CGFloat, leader: CGRect, columns: [MissionColumn],
		ticks: [MissionTick]
	) {
		self.spineY = spineY
		self.leader = leader
		self.columns = columns
		self.ticks = ticks
	}
}

/// Pure spine placement (T10.3): every anchor on the spine under or over its
/// own card, straight connectors. No `Store`, no bare `Date()`, no SwiftUI
/// state.
///
/// Screen x is `index.x(i) - scrollX + viewport.minX`: no offsetting and no
/// resolver. A mission's x depends only on the items before it, never on
/// state, attention or the viewport, so appending a newer mission moves no
/// existing anchor and a state change moves nothing.
public enum SpinePlacement {
	/// Content gap between the newest item and the leader card's leading
	/// edge: half the default minimum column.
	public static let leaderGap: CGFloat = 60

	/// The side rule: even numbers below, odd above.
	public static func side(for number: Int) -> SpineSide {
		number.isMultiple(of: 2) ? .below : .above
	}

	public static func place(
		index: SpineIndex,
		agents: [MissionId: [Agent]],
		range: Range<Int>,
		scrollX: CGFloat,
		viewport: CGRect,
		metrics: SpineMetrics = .standard,
		expanded: Set<MissionId> = []
	) -> Placement {
		let spineY = viewport.midY
		let leader = leaderRect(
			index: index, scrollX: scrollX, viewport: viewport,
			spineY: spineY)
		let lo = max(0, range.lowerBound)
		let hi = min(index.count, range.upperBound)
		var columns: [MissionColumn] = []
		var ticks: [MissionTick] = []
		if hi > lo {
			columns.reserveCapacity(hi - lo)
			ticks.reserveCapacity(hi - lo)
		}
		for i in lo ..< hi {
			guard let mission = index.mission(i) else { continue }
			let anchorX = index.x(i) - scrollX + viewport.minX
			let anchor = CGPoint(x: anchorX, y: spineY)
			let side = side(for: mission.number)
			let card = cardRect(
				mission: mission, anchorX: anchorX, side: side,
				spineY: spineY, metrics: metrics)
			let nearY =
				side == .above ? card.maxY : card.minY
			let stack: AgentStack
			let rows: [CGRect]
			let collapsed: Bool
			if mission.state == .closed {
				stack = .empty
				rows = []
				collapsed = true
			} else {
				stack = AgentStack.build(
					agents: agents[mission.id] ?? [],
					expanded: expanded.contains(mission.id),
					metrics: metrics)
				rows = rowRects(
					stack: stack, card: card, side: side, metrics: metrics)
				collapsed = false
			}
			columns.append(MissionColumn(
				id: mission.id, number: mission.number, side: side,
				state: mission.state,
				anchor: anchor, card: card,
				connector: [anchor, CGPoint(x: anchorX, y: nearY)],
				stack: stack, rows: rows, collapsed: collapsed))
			ticks.append(MissionTick(x: anchorX, state: mission.state))
		}
		return Placement(
			spineY: spineY, leader: leader, columns: columns, ticks: ticks)
	}

	/// The leader card pinned past the newest item, spine-centred.
	public static func leaderRect(
		index: SpineIndex, scrollX: CGFloat, viewport: CGRect,
		spineY: CGFloat,
		metrics: SpineMetrics = .standard
	) -> CGRect {
		let lastX = index.count > 0 ? index.x(index.count - 1) : 0
		return CGRect(
			x: lastX + leaderGap - scrollX + viewport.minX,
			y: spineY - metrics.leadCardHeight / 2,
			width: metrics.leadCardWidth,
			height: metrics.leadCardHeight)
	}

	// MARK: - Private

	/// `leadCardWidth` wide, attention height when `attention != nil`,
	/// centred on `anchorX` with the near edge `spineOffset` from the axis;
	/// closed missions centre a `closedNodeWidth x closedNodeHeight` node
	/// the same way.
	private static func cardRect(
		mission: Mission, anchorX: CGFloat, side: SpineSide,
		spineY: CGFloat, metrics: SpineMetrics
	) -> CGRect {
		if mission.state == .closed {
			let midY =
				side == .above
				? spineY - metrics.spineOffset - metrics.closedNodeHeight / 2
				: spineY + metrics.spineOffset + metrics.closedNodeHeight / 2
			return CGRect(
				x: anchorX - metrics.closedNodeWidth / 2,
				y: midY - metrics.closedNodeHeight / 2,
				width: metrics.closedNodeWidth,
				height: metrics.closedNodeHeight)
		}
		let height: CGFloat =
			mission.attention != nil
			? metrics.leadAttentionHeight : metrics.leadCardHeight
		let y =
			side == .above
			? spineY - metrics.spineOffset - height
			: spineY + metrics.spineOffset
		return CGRect(
			x: anchorX - metrics.leadCardWidth / 2, y: y,
			width: metrics.leadCardWidth, height: height)
	}

	/// Agent rows are `agentRowWidth` wide, centred on the card, growing away
	/// from the spine with the first row `leadGap` past the card's far edge.
	/// Entry `i` follows `stack.items[i]`'s offset/height, so the 10 pt
	/// `rowGap` shows the stack link.
	private static func rowRects(
		stack: AgentStack, card: CGRect, side: SpineSide,
		metrics: SpineMetrics
	) -> [CGRect] {
		let rowX = card.midX - metrics.agentRowWidth / 2
		return stack.items.map { item in
			let y =
				side == .above
				? card.minY - metrics.leadGap - (item.offset + item.height)
				: card.maxY + metrics.leadGap + item.offset
			return CGRect(
				x: rowX, y: y, width: metrics.agentRowWidth,
				height: item.height)
		}
	}
}
