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

	/// Gap between the leader card's far edge and the chat panel's leading
	/// edge (PAPER-SPINE artboard 1 item 8: the leader card sits just left
	/// of the chat).
	public static let chatGap: CGFloat = 24

	/// The `scrollX` that puts the live edge — the leader card's far edge —
	/// at the canvas's usable right edge, `trailingInset` in from
	/// `viewport.maxX` (the chat's leading edge less `chatGap` while the
	/// chat is visible, else the window inset).
	///
	/// It is negative when the whole sequence is narrower than the usable
	/// width: the leader still sits at Now and the spine runs off to its
	/// left. `fit` and `jumpToNow` both land here, so both right-align.
	public static func liveScrollX(
		index: SpineIndex, viewport: CGRect, trailingInset: CGFloat
	) -> CGFloat {
		index.contentWidth - max(0, viewport.width - trailingInset)
	}

	/// Half the widest node drawn in the column of item `i`: how far that
	/// item's node reaches to the left of its own anchor.
	///
	/// Every node is centred on its anchor (`cardRect`, `rowRects`), so the
	/// anchor is not the item's left edge. An open mission's widest node is
	/// its agent row, a closed one's is its 180 pt collapsed node, and a
	/// checkpoint's is its 26 pt hit target.
	public static func halfWidth(
		of i: Int, in index: SpineIndex, metrics: SpineMetrics = .standard
	) -> CGFloat {
		guard i >= 0, i < index.count else { return 0 }
		guard let mission = index.mission(i) else {
			return metrics.minHitHeight / 2
		}
		if mission.state == .closed { return metrics.closedNodeWidth / 2 }
		return max(metrics.leadCardWidth, metrics.agentRowWidth) / 2
	}

	/// The range `scrollX` may take: back to the oldest item's LEFT EDGE at
	/// the left edge of the band, forward no further than the live edge.
	/// Nothing exists right of Now, so `liveScrollX` is always the upper
	/// bound — when it is negative (a sequence narrower than the usable
	/// width) it is the only value, and the leader cannot be pushed off Now
	/// by a pan or a zoom.
	///
	/// The lower bound is `x(0) - halfWidth(of: 0)`, not 0: item 0's anchor
	/// is its centre, so flooring at the anchor left half of the oldest
	/// node permanently off the left edge, unreachable by any pan.
	public static func clampScrollX(
		_ scrollX: CGFloat, index: SpineIndex, viewport: CGRect,
		trailingInset: CGFloat, metrics: SpineMetrics = .standard
	) -> CGFloat {
		let live = liveScrollX(
			index: index, viewport: viewport, trailingInset: trailingInset)
		let back = index.count > 0
			? index.x(0) - halfWidth(of: 0, in: index, metrics: metrics) : 0
		return min(max(scrollX, min(back, live)), live)
	}

	/// The `scrollX` that brings one mission's column into the canvas's
	/// usable band, or `nil` when it is already there and nothing should
	/// move.
	///
	/// MANIFESTO.md "The mission inbox": "Clicking a mission in the bar pans
	/// the spine to that mission and opens its lead's conversation." The
	/// navigator is the same wire (a jump list). The column is
	/// `leadCardWidth` wide centred on its anchor, so it counts as in view
	/// only when both card edges sit inside
	/// `viewport.minX ... viewport.maxX - trailingInset`; otherwise the
	/// anchor is centred in that band and the result is clamped to the
	/// pannable range, so a jump can never push the leader off Now.
	public static func revealScrollX(
		mission id: MissionId, index: SpineIndex, scrollX: CGFloat,
		viewport: CGRect, trailingInset: CGFloat,
		metrics: SpineMetrics = .standard
	) -> CGFloat? {
		guard let position = position(of: id, in: index) else { return nil }
		let right = viewport.maxX - trailingInset
		guard right > viewport.minX else { return nil }
		let contentX = index.x(position)
		let screenX = contentX - scrollX + viewport.minX
		let half = metrics.leadCardWidth / 2
		if screenX - half >= viewport.minX, screenX + half <= right {
			return nil
		}
		let centre = (viewport.minX + right) / 2
		let target = clampScrollX(
			contentX - (centre - viewport.minX), index: index,
			viewport: viewport, trailingInset: trailingInset)
		return target == scrollX ? nil : target
	}

	/// Sequence position of a mission, or `nil` when it is not in the index.
	/// Linear: the index is a value type with no id map of its own, and the
	/// call sites are one selection change each.
	private static func position(
		of id: MissionId, in index: SpineIndex
	) -> Int? {
		for i in 0 ..< index.count where index.mission(i)?.id == id {
			return i
		}
		return nil
	}

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
				// The lead has its own card in the column. A mission record also
				// names that lead among its agents, so remove only that one from
				// the subordinate stack before placing rows.
				let stackAgents: [Agent]
				switch mission.lead {
				case .leader:
					stackAgents = agents[mission.id] ?? []
				case .agent(let leadId):
					stackAgents = (agents[mission.id] ?? []).filter { $0.id != leadId }
				}
				stack = AgentStack.build(
					agents: stackAgents,
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
			y: spineY - metrics.leaderCardHeight / 2,
			width: metrics.leaderCardWidth,
			height: metrics.leaderCardHeight)
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
		let height = metrics.cardHeight(attention: mission.attention != nil)
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
