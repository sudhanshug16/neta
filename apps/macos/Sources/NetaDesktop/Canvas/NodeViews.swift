import SwiftUI

/// Spine node views (T10.6): the workspace leader card, the mission lead
/// card, the agent row and the `+N completed` chip.
///
/// Nodes never scale: there is no `scaleEffect` anywhere here; zoom changes
/// the lens only, so text keeps its point size. Every text colour routes
/// through `CanvasStyle.text`, which never drops below the contrast floor.
/// Every view is at least `SpineMetrics.standard.minHitHeight` tall. Status
/// is never colour alone: every state colour ships with its text label.
///
/// No colour or font literal lives here: fonts come from `Theme.text` and
/// `Theme.mono`, colours from `Theme` (the leader card's violet rim is
/// `Theme.Glass.leaderBorder`, PAPER-SPINE item 11's "violet border 60%").
public struct LeaderCardView: View {
	private let name: String
	private let mode: LeaderMode
	private let selected: Bool

	public init(name: String, mode: LeaderMode, selected: Bool) {
		self.name = name
		self.mode = mode
		self.selected = selected
	}

	public var body: some View {
		HStack(spacing: 12) {
			ZStack {
				Circle()
					.fill(Theme.violet)
					.frame(width: 44, height: 44)
				Image(systemName: "crown.fill")
					.font(Theme.text(20, .semibold))
					.foregroundStyle(Theme.textPrimary)
			}
			.accessibilityHidden(true)
			// PAPER-SPINE item 11 draws the name and `Workspace leader` as
			// one line each. `leaderCardWidth` reserves 91 pt for this
			// column, one point more than the subtitle's 89; the line limits
			// keep a long pool name from stealing the second line back.
			VStack(alignment: .leading, spacing: 2) {
				Text(name)
					.font(Theme.text(15, .semibold))
					.foregroundStyle(CanvasStyle.text(
						Theme.textPrimary, emphasis: 1, over: Theme.nodeFill))
					.lineLimit(1)
				Text("Workspace leader")
					.font(Theme.text(10, .medium))
					.foregroundStyle(CanvasStyle.text(
						Theme.textSecondary, emphasis: 1, over: Theme.nodeFill))
					.lineLimit(1)
			}
			Text(mode == .leadPlus ? "LEAD++" : "LEAD")
				.font(Theme.text(10, .semibold))
				.foregroundStyle(mode == .leadPlus ? Theme.violet : Theme.textSecondary)
				.padding(.horizontal, 8)
				.padding(.vertical, 4)
				.background(Capsule().fill(Theme.subtleSurface))
		}
		.padding(12)
		// The card is placed by `SpinePlacement.leaderRect`: `.position`
		// centres a view on its rect, so an intrinsically wider card (a long
		// pool name) would overhang the rect and slide under the chat glass.
		// Both dimensions are pinned to the rect the placement reserves.
		.frame(
			width: SpineMetrics.standard.leaderCardWidth,
			height: SpineMetrics.standard.leaderCardHeight)
		.background(
			RoundedRectangle(cornerRadius: radius, style: .continuous)
				.fill(Theme.nodeFill)
				.overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
					.fill(Theme.Glass.leaderTint)))
		.netaSpecular(.rounded(radius))
		// Revision 3 item 6 gives the leader card "the glass rim and
		// specular sheen with a violet tint"; item 11 gives it the violet
		// 60% border. Both, not one standing in for the other: the white
		// 14% rim sits just inside the border, exactly where the glass
		// surfaces carry it, and the border is the outer edge.
		.overlay(RoundedRectangle(cornerRadius: radius - Theme.Glass.rimWidth, style: .continuous)
			.strokeBorder(Theme.Glass.rim, lineWidth: Theme.Glass.rimWidth)
			.padding(Theme.Glass.rimWidth)
			.allowsHitTesting(false))
		.overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
			.stroke(
				selected ? Theme.mint : Theme.Glass.leaderBorder,
				lineWidth: selected ? 2 : 1))
		.accessibilityElement(children: .combine)
		.accessibilityLabel(
			"Workspace leader \(name), \(mode == .leadPlus ? "Lead++" : "Lead")")
	}

	/// The card is content, not glass: it borrows the Revision 3 rim and
	/// sheen from `netaSpecular` so the focal node reads as lifted, and
	/// keeps its violet border.
	private var radius: CGFloat { Theme.Metric.leaderCardRadius }
}

public struct LeadCardView: View {
	private let model: LeadCardModel
	private let emphasis: Double
	private let selected: Bool
	private let collapsed: Bool

	/// - Parameter collapsed: A closed mission. PAPER-SPINE Revision 4:
	///   "Closed missions: lead node only, ... 55% opacity" — the number,
	///   the name and the closing line in the `closedNodeWidth x
	///   closedNodeHeight` rect `SpinePlacement` reserves for it, never the
	///   full card in a rect a third its height.
	public init(
		model: LeadCardModel, emphasis: Double, selected: Bool,
		collapsed: Bool = false
	) {
		self.model = model
		self.emphasis = emphasis
		self.selected = selected
		self.collapsed = collapsed
	}

	public var body: some View {
		if collapsed {
			collapsedBody
		} else {
			fullBody
		}
	}

	/// The closed mission's node: the number and name on one line, the
	/// closing line under it — `#296 Slack digest bot` over
	/// `Merged · closed 10d` (PAPER-SPINE artboard 1 item 3, kept by
	/// Revision 2). Nothing here says `Closed`: the word the node carries is
	/// `Merged` or `Abandoned`.
	///
	/// Two lines, not the single line the artboard draws, because Revision 4
	/// later fixed the closed node near 180 pt and the two cannot both hold.
	/// One line spends 157 pt of that on the number, the closing line and
	/// the padding, leaving 23 pt for a name that needs 87 pt
	/// (`Slack digest bot`) — the node read `#296 Slac… Merged · closed 10d`
	/// and a closed mission was unidentifiable. Fitting one line instead
	/// would take a 320 pt node, wider than the 210 pt lead card of a live
	/// mission, which inverts the emphasis Revision 4's faded remnant is
	/// for. BRIEF.md MUST — nodes "show their FULL task name" — is the rule
	/// that breaks the tie: the name stays whole and the line wraps.
	/// `SpineMetrics.closedNodeWidth` carries the 20 pt the design's longest
	/// closed name needs on top of that; both are measured in
	/// `NodeFramingTests.testTheClosedNodeHoldsTheDesignsNamesWhole`.
	private var collapsedBody: some View {
		VStack(alignment: .leading, spacing: 1) {
			HStack(spacing: 5) {
				Text(model.numberText)
					.font(Theme.mono(11, .semibold))
					.foregroundStyle(CanvasStyle.text(
						Theme.textPrimary, emphasis: emphasis, over: Theme.nodeFill))
				Text(model.name)
					.font(Theme.text(11, .medium))
					.foregroundStyle(CanvasStyle.text(
						Theme.textPrimary, emphasis: emphasis, over: Theme.nodeFill))
					.lineLimit(1)
					.truncationMode(.tail)
				Spacer(minLength: 0)
			}
			Text(model.closedText ?? model.stateLabel)
				.font(Theme.text(10, .medium))
				.foregroundStyle(CanvasStyle.text(
					Theme.textSecondary, emphasis: emphasis, over: Theme.nodeFill))
				.lineLimit(1)
				.truncationMode(.tail)
		}
		.padding(.horizontal, 8)
		.frame(
			width: SpineMetrics.standard.closedNodeWidth,
			height: SpineMetrics.standard.closedNodeHeight,
			alignment: .leading)
		.background(RoundedRectangle(cornerRadius: Theme.Metric.leadCardRadius)
			.fill(Theme.nodeFill))
		.overlay(RoundedRectangle(cornerRadius: Theme.Metric.leadCardRadius)
			.stroke(
				selected ? Theme.mint : Theme.nodeBorder,
				lineWidth: selected ? 2 : 1))
		.accessibilityElement(children: .combine)
		.accessibilityLabel(
			"\(model.numberText) \(model.name), \(model.closedText ?? model.stateLabel)")
	}

	private var fullBody: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack {
				Text(model.numberText)
					.font(Theme.mono(12, .semibold))
					.foregroundStyle(CanvasStyle.text(
						Theme.textPrimary, emphasis: emphasis, over: Theme.nodeFill))
				Spacer(minLength: 8)
				Text(model.ageText)
					.font(Theme.mono(11, .regular))
					.foregroundStyle(CanvasStyle.text(
						Theme.textSecondary, emphasis: emphasis, over: Theme.nodeFill))
			}
			Text(model.name)
				.font(Theme.text(13, .semibold))
				.foregroundStyle(CanvasStyle.text(
					Theme.textPrimary, emphasis: emphasis, over: Theme.nodeFill))
				.lineLimit(2)
				.fixedSize(horizontal: false, vertical: true)
			HStack(spacing: 5) {
				Circle()
					.fill(model.stateColor)
					.frame(width: 6, height: 6)
				Text(model.stateLabel)
					.font(Theme.text(11, .medium))
					.foregroundStyle(CanvasStyle.text(
						model.stateColor, emphasis: emphasis, over: Theme.nodeFill))
			}
			if model.crown {
				HStack(spacing: 4) {
					Image(systemName: "crown.fill")
						.font(Theme.text(12, .semibold))
						.foregroundStyle(Theme.violet)
					if let ledBy = model.ledBy {
						Text(ledBy)
							.font(Theme.text(11, .regular))
							.foregroundStyle(CanvasStyle.text(
								Theme.textSecondary, emphasis: emphasis, over: Theme.nodeFill))
							.lineLimit(1)
					}
				}
				.accessibilityLabel(model.ledBy ?? "Led by the workspace leader")
			} else if let ledBy = model.ledBy {
				Text(ledBy)
					.font(Theme.text(11, .regular))
					.foregroundStyle(CanvasStyle.text(
						Theme.textSecondary, emphasis: emphasis, over: Theme.nodeFill))
					.lineLimit(1)
			}
			if let attention = model.attention {
				Text(attention)
					.font(Theme.text(12, .regular))
					.foregroundStyle(CanvasStyle.text(
						model.stateColor, emphasis: emphasis, over: Theme.nodeFill))
					.lineLimit(2)
					.fixedSize(horizontal: false, vertical: true)
			}
			Spacer(minLength: 0)
		}
		.padding(10)
		// Exactly the rect `SpinePlacement.cardRect` reserved for the card,
		// from the one height rule both read.
		.frame(
			width: SpineMetrics.standard.leadCardWidth,
			height: SpineMetrics.standard.cardHeight(attention: model.attention != nil),
			alignment: .topLeading)
		.background(RoundedRectangle(cornerRadius: Theme.Metric.leadCardRadius)
			.fill(Theme.nodeFill))
		.overlay(RoundedRectangle(cornerRadius: Theme.Metric.leadCardRadius)
			.stroke(
				selected ? Theme.mint : Theme.nodeBorder,
				lineWidth: selected ? 2 : 1))
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(model.numberText) \(model.name), \(model.stateLabel)")
	}
}

public struct AgentRowView: View {
	private let model: AgentRowModel
	private let emphasis: Double
	private let selected: Bool

	public init(model: AgentRowModel, emphasis: Double, selected: Bool) {
		self.model = model
		self.emphasis = emphasis
		self.selected = selected
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 3) {
			HStack(spacing: 6) {
				SigilView(name: model.name, size: 12)
				Text(model.name)
					.font(Theme.text(12, .semibold))
					.foregroundStyle(primary)
					.lineLimit(1)
				Spacer(minLength: 4)
				// Dot and label together: the state is never the colour
				// alone.
				Circle()
					.fill(model.stateColor)
					.frame(width: 6, height: 6)
				Text(model.stateLabel)
					.font(Theme.text(11, .medium))
					.foregroundStyle(CanvasStyle.text(
						model.stateColor, emphasis: emphasis, over: Theme.nodeFill))
					.lineLimit(1)
				Image(systemName: model.accessGlyph)
					.font(Theme.text(11, .regular))
					.foregroundStyle(secondary)
					.accessibilityLabel(model.accessGlyph == "eye" ? "Read-only" : "Read-write")
			}
			Text(model.task)
				.font(Theme.text(12, .regular))
				.foregroundStyle(primary)
				.lineLimit(2)
				.fixedSize(horizontal: false, vertical: true)
			if let activity = model.activity {
				Text(activity)
					.font(Theme.mono(10, .regular))
					.foregroundStyle(primary)
					.lineLimit(1)
			}
			Spacer(minLength: 0)
		}
		.padding(8)
		// Exactly the rect `AgentStack` reserved for this row, from the one
		// height rule both read (`SpineMetrics.rowHeight(running:)`). A view
		// left to its intrinsic size overflowed its rect by 40-50 pt and
		// painted over its own lead card and its neighbours.
		.frame(
			width: SpineMetrics.standard.agentRowWidth,
			height: SpineMetrics.standard.rowHeight(running: model.isRunning),
			alignment: .topLeading)
		.background(RoundedRectangle(cornerRadius: Theme.Metric.agentRowRadius)
			.fill(Theme.nodeFill))
		.overlay(RoundedRectangle(cornerRadius: Theme.Metric.agentRowRadius)
			.stroke(
				selected ? Theme.mint : Theme.nodeBorder,
				lineWidth: selected ? 2 : 1))
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(model.name), \(model.stateLabel), \(model.task)")
	}

	private var primary: Color {
		CanvasStyle.text(Theme.textPrimary, emphasis: emphasis, over: Theme.nodeFill)
	}

	private var secondary: Color {
		CanvasStyle.text(Theme.textSecondary, emphasis: emphasis, over: Theme.nodeFill)
	}
}

/// The `+N completed` expander: a pill with a chevron that expands in place,
/// never a circle or a separate surface.
///
/// It takes `netaControlGlass`, not `netaGlass`: Revision 3 lists the
/// `+N completed` chip under "Controls on glass", which get "capsule glass
/// with the same rim" — the rim, not the `0 18 40` outer shadow. The
/// silhouette is a capsule, which would otherwise float (see the elevation
/// rule on `netaGlass`), so the control weight is named here rather than
/// inferred: a 40 pt shadow under a small pill between agent rows is an
/// addition the design does not state.
public struct CompletedChip: View {
	private let count: Int
	private let expanded: Bool
	private let action: () -> Void

	public init(count: Int, expanded: Bool, action: @escaping () -> Void) {
		self.count = count
		self.expanded = expanded
		self.action = action
	}

	public var body: some View {
		Button(action: action) {
			HStack(spacing: 4) {
				Text("+\(count) completed")
					.font(Theme.text(12, .medium))
					.foregroundStyle(Theme.textSecondary)
				Image(systemName: expanded ? "chevron.down" : "chevron.right")
					.font(Theme.text(11, .semibold))
					.foregroundStyle(Theme.textSecondary)
			}
			.padding(.horizontal, 10)
			.padding(.vertical, 5)
			.frame(minHeight: SpineMetrics.standard.minHitHeight)
			.netaControlGlass(.capsule)
		}
		.buttonStyle(.plain)
		.accessibilityLabel("+\(count) completed, \(expanded ? "expanded" : "collapsed")")
	}
}
