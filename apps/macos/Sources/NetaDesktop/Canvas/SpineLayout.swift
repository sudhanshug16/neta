import CoreGraphics
import Foundation

/// Which row of the spine a mission branches to (T10.3).
///
/// The side is a pure function of the permanent mission number — odd above,
/// even below — so a side never changes after placement, and no two missions
/// stack vertically on one side: each side is one row of lead cards.
public enum SpineSide: Sendable, Equatable {
	case above
	case below
}

/// One mission's mark on the time axis: its anchor position plus its state.
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
/// `slot` is always `metrics.leadCardWidth` wide whatever the mission state,
/// so finishing a mission changes state, not place. For open missions `card
/// == slot`, its near edge `metrics.spineOffset` from the axis. A closed
/// mission's card is `closedNodeWidth x closedNodeHeight` centred in the
/// slot. `rows` holds one rect per `stack.items` entry in the same order for
/// open missions, and is empty when `collapsed`.
public struct MissionColumn: Sendable, Equatable, Identifiable {
	public let id: MissionId
	public let number: Int
	public let side: SpineSide
	public let anchor: CGPoint
	public let slot: CGRect
	public let card: CGRect
	public let connector: [CGPoint]
	public let stack: AgentStack
	public let rows: [CGRect]
	public let collapsed: Bool

	public init(
		id: MissionId, number: Int, side: SpineSide, anchor: CGPoint,
		slot: CGRect, card: CGRect, connector: [CGPoint],
		stack: AgentStack, rows: [CGRect], collapsed: Bool
	) {
		self.id = id
		self.number = number
		self.side = side
		self.anchor = anchor
		self.slot = slot
		self.card = card
		self.connector = connector
		self.stack = stack
		self.rows = rows
		self.collapsed = collapsed
	}
}

/// The whole laid-out spine: the axis height, the pinned leader card, one
/// column per mission in index order, and one tick per mission.
public struct Placement: Sendable, Equatable {
	public let spineY: CGFloat
	public let leader: CGRect
	public let columns: [MissionColumn]
	public let ticks: [MissionTick]

	public init(spineY: CGFloat, leader: CGRect, columns: [MissionColumn], ticks: [MissionTick]) {
		self.spineY = spineY
		self.leader = leader
		self.columns = columns
		self.ticks = ticks
	}
}

/// Pure spine layout (T10.3): anchors on the axis, one row of lead cards per
/// side, bent connectors. No `Store`, no bare `Date()`, no SwiftUI state.
///
/// Slot x-positions depend only on the index, the lens and the metrics, never
/// on the viewport or on mission state/attention, so columns are stable under
/// pan and across state changes.
public enum SpineLayout {
	public static func layout(
		index: SpineIndex,
		agents: [MissionId: [Agent]],
		lens: TimeLens,
		viewport: CGRect,
		metrics: SpineMetrics = .standard,
		expanded: Set<MissionId> = []
	) -> Placement {
		let spineY = viewport.midY
		let nowX = CGFloat(lens.x(lens.options.now))
		let leader = CGRect(
			x: nowX - metrics.leadCardWidth / 2,
			y: spineY - metrics.leadCardHeight / 2,
			width: metrics.leadCardWidth,
			height: metrics.leadCardHeight)

		// Per side, newest to oldest (index order reversed).
		var perSide: [SpineSide: [(mission: Mission, anchorX: CGFloat)]] = [
			.above: [], .below: [],
		]
		for i in (0 ..< index.count).reversed() {
			let mission = index[i]
			let anchorX = CGFloat(lens.x(mission.createdAt.timeIntervalSince1970 * 1000))
			perSide[side(for: mission.number), default: []].append((mission, anchorX))
		}

		var byId: [MissionId: MissionColumn] = [:]
		byId.reserveCapacity(index.count)
		for side in [SpineSide.above, SpineSide.below] {
			for column in layoutSide(
				perSide[side] ?? [], side: side, agents: agents,
				spineY: spineY, metrics: metrics, expanded: expanded)
			{
				byId[column.id] = column
			}
		}

		// Columns and ticks follow index order (oldest to newest).
		var columns: [MissionColumn] = []
		var ticks: [MissionTick] = []
		columns.reserveCapacity(index.count)
		ticks.reserveCapacity(index.count)
		for i in 0 ..< index.count {
			let mission = index[i]
			columns.append(byId[mission.id]!)
			ticks.append(MissionTick(
				x: CGFloat(lens.x(mission.createdAt.timeIntervalSince1970 * 1000)),
				state: mission.state))
		}
		return Placement(spineY: spineY, leader: leader, columns: columns, ticks: ticks)
	}

	/// The side rule: even numbers below, odd above.
	public static func side(for number: Int) -> SpineSide {
		number.isMultiple(of: 2) ? .below : .above
	}

	// MARK: - One side

	/// Walk newest to oldest, splitting into chains at each chain break (an
	/// anchor more than `leadCardWidth + columnGap` older than its newer
	/// neighbour) or after `maxChainWalk` steps, then sweep each chain
	/// newest to oldest: centre each slot on its anchor, then push it outward
	/// (away from Now, i.e. left) until its trailing edge clears the next
	/// newer slot by `columnGap`. The trailing edge threads across chain
	/// boundaries, so no two slots on a side ever overlap even past a forced
	/// split; past a genuine break the centred slot already clears.
	private static func layoutSide(
		_ ordered: [(mission: Mission, anchorX: CGFloat)],
		side: SpineSide,
		agents: [MissionId: [Agent]],
		spineY: CGFloat,
		metrics: SpineMetrics,
		expanded: Set<MissionId>
	) -> [MissionColumn] {
		let breakGap = metrics.leadCardWidth + metrics.columnGap
		var chains: [[(mission: Mission, anchorX: CGFloat)]] = []
		chains.reserveCapacity(max(1, ordered.count))
		for entry in ordered {
			if let current = chains.last,
				current.count < metrics.maxChainWalk,
				let newer = current.last,
				newer.anchorX - entry.anchorX <= breakGap
			{
				chains[chains.count - 1].append(entry)
			} else {
				chains.append([entry])
			}
		}

		let slotWidth = metrics.leadCardWidth
		var columns: [MissionColumn] = []
		columns.reserveCapacity(ordered.count)
		var newerMinX = CGFloat.infinity
		for chain in chains {
			for entry in chain {
				let mission = entry.mission
				let anchorX = entry.anchorX
				let centredMinX = anchorX - slotWidth / 2
				let pushedMinX = newerMinX - metrics.columnGap - slotWidth
				let slotMinX = min(centredMinX, pushedMinX)

				let openHeight: CGFloat =
					mission.attention != nil
					? metrics.leadAttentionHeight : metrics.leadCardHeight
				let slotY =
					side == .above
					? spineY - metrics.spineOffset - openHeight
					: spineY + metrics.spineOffset
				let slot = CGRect(
					x: slotMinX, y: slotY, width: slotWidth, height: openHeight)

				let card: CGRect
				let stack: AgentStack
				let rows: [CGRect]
				let collapsed: Bool
				if mission.state == .closed {
					card = CGRect(
						x: slot.midX - metrics.closedNodeWidth / 2,
						y: slot.midY - metrics.closedNodeHeight / 2,
						width: metrics.closedNodeWidth,
						height: metrics.closedNodeHeight)
					stack = .empty
					rows = []
					collapsed = true
				} else {
					card = slot
					stack = AgentStack.build(
						agents: agents[mission.id] ?? [],
						expanded: expanded.contains(mission.id),
						metrics: metrics)
					rows = rowRects(stack: stack, card: card, side: side, metrics: metrics)
					collapsed = false
				}

				let anchor = CGPoint(x: anchorX, y: spineY)
				let connector = connectorPoints(
					anchor: anchor, card: card, side: side,
					spineY: spineY, metrics: metrics)

				columns.append(MissionColumn(
					id: mission.id, number: mission.number, side: side,
					anchor: anchor, slot: slot, card: card,
					connector: connector, stack: stack, rows: rows,
					collapsed: collapsed))
				newerMinX = slotMinX
			}
		}
		return columns
	}

	/// Agent rows are `agentRowWidth` wide, centred on the card, growing away
	/// from the spine with the first row `leadGap` past the card's far edge.
	/// Entry `i` follows `stack.items[i]`'s offset/height.
	private static func rowRects(
		stack: AgentStack, card: CGRect, side: SpineSide, metrics: SpineMetrics
	) -> [CGRect] {
		let rowX = card.midX - metrics.agentRowWidth / 2
		return stack.items.map { item in
			let y =
				side == .above
				? card.minY - metrics.leadGap - (item.offset + item.height)
				: card.maxY + metrics.leadGap + item.offset
			return CGRect(
				x: rowX, y: y, width: metrics.agentRowWidth, height: item.height)
		}
	}

	/// Two points (anchor straight into the card's near edge) when the card
	/// sits over its anchor, else four: vertical to `spineY +/- spineOffset /
	/// 2`, horizontal to `card.midX`, vertical into the card.
	private static func connectorPoints(
		anchor: CGPoint, card: CGRect, side: SpineSide,
		spineY: CGFloat, metrics: SpineMetrics
	) -> [CGPoint] {
		let cardEdgeY = side == .above ? card.maxY : card.minY
		if (card.midX - anchor.x).magnitude <= 0.5 {
			return [anchor, CGPoint(x: anchor.x, y: cardEdgeY)]
		}
		let bendY =
			side == .above
			? spineY - metrics.spineOffset / 2 : spineY + metrics.spineOffset / 2
		return [
			anchor,
			CGPoint(x: anchor.x, y: bendY),
			CGPoint(x: card.midX, y: bendY),
			CGPoint(x: card.midX, y: cardEdgeY),
		]
	}
}
