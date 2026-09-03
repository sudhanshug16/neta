import CoreGraphics
import SwiftUI

/// Backdrop paint tokens (T10.4).
///
/// One edge colour for every edge — solid, never dashed or coloured — so
/// blocked reads through the amber anchor and the card label, never through
/// edge style (PAPER-SPINE Revision 2).
public struct BackdropStyle: Sendable, Equatable {
	public static let standard = BackdropStyle()

	public var edgeColor: Color = Theme.violet.opacity(0.32)
	public var edgeWidth: CGFloat = 1.4
	public var axisColor: Color = .white.opacity(0.14)
	public var axisUnderlay: Color = Theme.violet.opacity(0.06)
	public var anchorDiameter: CGFloat = 8
	public var anchorRing: CGFloat = 2
	public var tickWidth: CGFloat = 1

	public init(
		edgeColor: Color = Theme.violet.opacity(0.32),
		edgeWidth: CGFloat = 1.4,
		axisColor: Color = .white.opacity(0.14),
		axisUnderlay: Color = Theme.violet.opacity(0.06),
		anchorDiameter: CGFloat = 8,
		anchorRing: CGFloat = 2,
		tickWidth: CGFloat = 1
	) {
		self.edgeColor = edgeColor
		self.edgeWidth = edgeWidth
		self.axisColor = axisColor
		self.axisUnderlay = axisUnderlay
		self.anchorDiameter = anchorDiameter
		self.anchorRing = anchorRing
		self.tickWidth = tickWidth
	}
}

/// Recording stand-in for SwiftUI's `GraphicsContext`, for tests.
///
/// `GraphicsContext` can only be obtained inside a `Canvas` draw closure, so
/// `SpinePainter` exposes a `draw` overload writing into this recorder. Both
/// overloads consume the same `BackdropPlan`, so what the test records —
/// including the absence of leader edges — is what the `Canvas` paints.
public struct RecordingGraphicsContext: Sendable {
	public enum EdgeKind: Sendable, Equatable {
		case connector
		case trunk
		case stub
		case leader
	}

	public struct Stroke: Sendable, Equatable {
		public var kind: EdgeKind
		public var points: [CGPoint]
	}

	public struct AnchorMark: Sendable, Equatable {
		public var id: MissionId
		public var point: CGPoint
		public var state: MissionState
	}

	public private(set) var strokes: [Stroke] = []
	public private(set) var anchors: [AnchorMark] = []
	public private(set) var tickCount: Int = 0
	public private(set) var labelCount: Int = 0
	public private(set) var drawnStyles: [BackdropStyle] = []

	public init() {}

	mutating func recordStroke(kind: EdgeKind, points: [CGPoint]) {
		strokes.append(Stroke(kind: kind, points: points))
	}

	mutating func recordAnchor(id: MissionId, point: CGPoint, state: MissionState) {
		anchors.append(AnchorMark(id: id, point: point, state: state))
	}

	mutating func recordTick() {
		tickCount += 1
	}

	mutating func recordLabel() {
		labelCount += 1
	}

	mutating func recordStyle(_ style: BackdropStyle) {
		drawnStyles.append(style)
	}
}

/// The value-type draw plan both `draw` sinks consume.
///
/// `leaderEdges` is always empty: Revision 2 removed the leader edge (and the
/// amber dashed blocked variant), so no mission — including a `.leader`-led
/// one — draws an edge to the leader. A leader-led mission is marked by the
/// 12 pt crown on its card header instead, which the card view (T10.6) owns.
struct BackdropPlan: Sendable, Equatable {
	struct ConnectorMark: Sendable, Equatable {
		var id: MissionId
		var points: [CGPoint]
	}

	struct TrunkMark: Sendable, Equatable {
		var points: [CGPoint]
		var stubs: [[CGPoint]]
	}

	struct AnchorMark: Sendable, Equatable {
		var id: MissionId
		var point: CGPoint
		var state: MissionState
		var emphasis: Double
	}

	struct TickMark: Sendable, Equatable {
		var x: CGFloat
		var state: MissionState
	}

	struct AxisLabel: Sendable, Equatable {
		var point: CGPoint
		var text: String
	}

	/// 6 pt stubs joining the trunk to each agent row (Paper artboard 1 item 9).
	static let stubLength: CGFloat = 6
	/// Mission ticks straddle the axis by this half-height.
	static let tickHalfHeight: CGFloat = 3
	/// Violet bed beneath the 1 px axis (Paper artboard 1 item 8).
	static let axisUnderlayWidth: CGFloat = 3
	/// Tick-label baseline drop beneath the axis.
	static let labelDrop: CGFloat = 14

	var connectors: [ConnectorMark] = []
	var trunks: [TrunkMark] = []
	var anchors: [AnchorMark] = []
	var ticks: [TickMark] = []
	var labels: [AxisLabel] = []
	var leaderEdges: [[CGPoint]] = []

	init(
		window: VisibleWindow, lens: TimeLens,
		emphasisFor: (MissionId) -> Double
	) {
		let stubHalf = Self.stubLength / 2
		for column in window.columns {
			connectors.append(ConnectorMark(id: column.id, points: column.connector))
			anchors.append(AnchorMark(
				id: column.id, point: column.anchor, state: column.state,
				emphasis: min(1, max(0, emphasisFor(column.id)))))
			if let last = column.rows.last {
				let midX = column.card.midX
				let nearY =
					column.side == .above ? column.card.minY : column.card.maxY
				let farY =
					column.side == .above ? last.minY : last.maxY
				trunks.append(TrunkMark(
					points: [CGPoint(x: midX, y: nearY), CGPoint(x: midX, y: farY)],
					stubs: column.rows.map { row in
						[
							CGPoint(x: midX - stubHalf, y: row.midY),
							CGPoint(x: midX + stubHalf, y: row.midY),
						]
					}))
			}
		}
		for tick in window.ticks {
			ticks.append(TickMark(x: tick.x, state: tick.state))
		}
		for lensTick in lens.ticks() {
			labels.append(AxisLabel(
				point: CGPoint(
					x: CGFloat(lens.x(lensTick.t)), y: window.spineY + Self.labelDrop),
				text: lensTick.label))
		}
	}
}

/// One-`Canvas` backdrop painter (T10.4): no per-mission shape views.
///
/// Paint order: axis underlay, axis, `lens.ticks()` labels in 10 pt mono
/// `Theme.textSecondary` beneath the axis, mission ticks, connectors, agent
/// trunk edges with 6 pt stubs, then anchors. Every edge is `edgeColor` at
/// `edgeWidth`, solid, with round caps. Emphasis fades anchors only; edges
/// stay one colour.
public enum SpinePainter {
	public static func connectorPath(_ points: [CGPoint]) -> Path {
		var path = Path()
		guard let first = points.first else { return path }
		path.move(to: first)
		for point in points.dropFirst() { path.addLine(to: point) }
		return path
	}

	/// State colour for anchors and mission ticks. Missions have no
	/// completed/archived case; the remaining mapping is the table T10.5
	/// canonises in `CanvasStyle`.
	public static func anchorColor(for state: MissionState) -> Color {
		switch state {
		case .running: return Theme.mint
		case .blocked: return Theme.amber
		case .failed: return Theme.red
		case .readyToClose, .mergedNotClosed: return Theme.blue
		case .closed: return Theme.textSecondary
		}
	}

	public static func draw(
		into ctx: inout GraphicsContext, size: CGSize, window: VisibleWindow,
		lens: TimeLens, style: BackdropStyle,
		emphasisFor: (MissionId) -> Double
	) {
		let plan = BackdropPlan(window: window, lens: lens, emphasisFor: emphasisFor)
		let edgeStyle = StrokeStyle(
			lineWidth: style.edgeWidth, lineCap: .round, lineJoin: .round)
		let axis = [
			CGPoint(x: 0, y: window.spineY),
			CGPoint(x: size.width, y: window.spineY),
		]
		ctx.stroke(
			connectorPath(axis), with: .color(style.axisUnderlay),
			lineWidth: BackdropPlan.axisUnderlayWidth)
		ctx.stroke(
			connectorPath(axis), with: .color(style.axisColor), lineWidth: 1)
		for label in plan.labels
		where label.point.x >= 0 && label.point.x <= size.width {
			ctx.draw(
				Text(label.text).font(Theme.mono(10, .medium))
					.foregroundColor(Theme.textSecondary),
				at: label.point)
		}
		for tick in plan.ticks {
			ctx.stroke(
				connectorPath([
					CGPoint(x: tick.x, y: window.spineY - BackdropPlan.tickHalfHeight),
					CGPoint(x: tick.x, y: window.spineY + BackdropPlan.tickHalfHeight),
				]),
				with: .color(anchorColor(for: tick.state)),
				lineWidth: style.tickWidth)
		}
		for connector in plan.connectors {
			ctx.stroke(
				connectorPath(connector.points), with: .color(style.edgeColor),
				style: edgeStyle)
		}
		for trunk in plan.trunks {
			ctx.stroke(
				connectorPath(trunk.points), with: .color(style.edgeColor),
				style: edgeStyle)
			for stub in trunk.stubs {
				ctx.stroke(
					connectorPath(stub), with: .color(style.edgeColor),
					style: edgeStyle)
			}
		}
		for edge in plan.leaderEdges {
			ctx.stroke(
				connectorPath(edge), with: .color(style.edgeColor),
				style: edgeStyle)
		}
		for anchor in plan.anchors {
			let rect = CGRect(
				x: anchor.point.x - style.anchorDiameter / 2,
				y: anchor.point.y - style.anchorDiameter / 2,
				width: style.anchorDiameter, height: style.anchorDiameter)
			ctx.fill(
				Path(ellipseIn: rect),
				with: .color(anchorColor(for: anchor.state).opacity(anchor.emphasis)))
			ctx.stroke(
				Path(ellipseIn: rect), with: .color(Theme.ground),
				lineWidth: style.anchorRing)
		}
	}

	/// Test overload: records the same plan the `Canvas` paints.
	public static func draw(
		into recorder: inout RecordingGraphicsContext, size: CGSize,
		window: VisibleWindow, lens: TimeLens, style: BackdropStyle,
		emphasisFor: (MissionId) -> Double
	) {
		let plan = BackdropPlan(window: window, lens: lens, emphasisFor: emphasisFor)
		recorder.recordStyle(style)
		for label in plan.labels
		where label.point.x >= 0 && label.point.x <= size.width {
			recorder.recordLabel()
		}
		for _ in plan.ticks {
			recorder.recordTick()
		}
		for connector in plan.connectors {
			recorder.recordStroke(kind: .connector, points: connector.points)
		}
		for trunk in plan.trunks {
			recorder.recordStroke(kind: .trunk, points: trunk.points)
			for stub in trunk.stubs {
				recorder.recordStroke(kind: .stub, points: stub)
			}
		}
		for edge in plan.leaderEdges {
			recorder.recordStroke(kind: .leader, points: edge)
		}
		for anchor in plan.anchors {
			recorder.recordAnchor(id: anchor.id, point: anchor.point, state: anchor.state)
		}
	}
}

/// The backdrop view wrapping the painter (T10.4).
///
/// The `Canvas` must be sized to the viewport with a matching origin: window
/// coordinates are lens/viewport points. Column views, the leader card and
/// the checkpoint layer stack above this in T10.9.
public struct SpineBackdrop: View {
	private let window: VisibleWindow
	private let lens: TimeLens
	private let style: BackdropStyle
	private let emphasisFor: (MissionId) -> Double

	public init(
		window: VisibleWindow, lens: TimeLens,
		style: BackdropStyle = .standard,
		emphasisFor: @escaping (MissionId) -> Double
	) {
		self.window = window
		self.lens = lens
		self.style = style
		self.emphasisFor = emphasisFor
	}

	public var body: some View {
		Canvas { ctx, size in
			SpinePainter.draw(
				into: &ctx, size: size, window: window, lens: lens,
				style: style, emphasisFor: emphasisFor)
		}
	}
}
