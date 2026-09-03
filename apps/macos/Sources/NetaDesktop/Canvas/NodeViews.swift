import SwiftUI

/// Spine node views (T10.6): the workspace leader card, the mission lead
/// card, the agent row and the `+N completed` chip.
///
/// Nodes never scale: there is no `scaleEffect` anywhere here; zoom changes
/// the lens only, so text keeps its point size. Every text colour routes
/// through `CanvasStyle.text`, which never drops below the contrast floor.
/// Every view is at least `SpineMetrics.standard.minHitHeight` tall. Status
/// is never colour alone: every state colour ships with its text label.
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
					.font(.system(size: 20, weight: .semibold))
					.foregroundStyle(Color.white)
			}
			.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: 2) {
				Text(name)
					.font(Theme.text(15, .semibold))
					.foregroundStyle(CanvasStyle.text(
						Theme.textPrimary, emphasis: 1, over: Theme.nodeFill))
				Text("Workspace leader")
					.font(Theme.text(10, .medium))
					.foregroundStyle(CanvasStyle.text(
						Theme.textSecondary, emphasis: 1, over: Theme.nodeFill))
			}
			Text(mode == .leadPlus ? "LEAD++" : "LEAD")
				.font(Theme.text(10, .semibold))
				.foregroundStyle(mode == .leadPlus ? Theme.violet : Theme.textSecondary)
				.padding(.horizontal, 8)
				.padding(.vertical, 4)
				.background(Capsule().fill(Theme.subtleSurface))
		}
		.padding(12)
		.frame(minHeight: SpineMetrics.standard.minHitHeight)
		.background(
			RoundedRectangle(cornerRadius: 12)
				.fill(Theme.nodeFill)
				.overlay(RoundedRectangle(cornerRadius: 12)
					.fill(Theme.violet.opacity(0.16)))
				.overlay(RoundedRectangle(cornerRadius: 12).fill(sheen)))
		.overlay(RoundedRectangle(cornerRadius: 12)
			.stroke(
				selected ? Theme.mint : Theme.violet.opacity(0.6),
				lineWidth: selected ? 2 : 1))
		.accessibilityElement(children: .combine)
		.accessibilityLabel(
			"Workspace leader \(name), \(mode == .leadPlus ? "Lead++" : "Lead")")
	}

	/// Revision 3 specular sheen over the violet tint.
	private var sheen: LinearGradient {
		LinearGradient(
			colors: [Color.white.opacity(0.10), Color.white.opacity(0)],
			startPoint: .topLeading, endPoint: UnitPoint(x: 0.38, y: 0.38))
	}
}

public struct LeadCardView: View {
	private let model: LeadCardModel
	private let emphasis: Double
	private let selected: Bool

	public init(model: LeadCardModel, emphasis: Double, selected: Bool) {
		self.model = model
		self.emphasis = emphasis
		self.selected = selected
	}

	public var body: some View {
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
						.font(.system(size: 12, weight: .semibold))
						.foregroundStyle(Theme.violet)
					if let ledBy = model.ledBy {
						Text(ledBy)
							.font(Theme.text(11, .regular))
							.foregroundStyle(CanvasStyle.text(
								Theme.textSecondary, emphasis: emphasis, over: Theme.nodeFill))
					}
				}
				.accessibilityLabel(model.ledBy ?? "Led by the workspace leader")
			} else if let ledBy = model.ledBy {
				Text(ledBy)
					.font(Theme.text(11, .regular))
					.foregroundStyle(CanvasStyle.text(
						Theme.textSecondary, emphasis: emphasis, over: Theme.nodeFill))
			}
			if let attention = model.attention {
				Text(attention)
					.font(Theme.text(12, .regular))
					.foregroundStyle(CanvasStyle.text(
						model.stateColor, emphasis: emphasis, over: Theme.nodeFill))
			}
		}
		.padding(10)
		.frame(width: SpineMetrics.standard.leadCardWidth)
		.frame(minHeight: SpineMetrics.standard.minHitHeight)
		.background(RoundedRectangle(cornerRadius: 10).fill(Theme.nodeFill))
		.overlay(RoundedRectangle(cornerRadius: 10)
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
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 6) {
				SigilView(name: model.name, size: 12)
				Text(model.name)
					.font(Theme.text(12, .semibold))
					.foregroundStyle(primary)
				Spacer(minLength: 4)
				Text(providerMark)
					.font(Theme.text(11, .medium))
					.foregroundStyle(secondary)
				Image(systemName: model.accessGlyph)
					.font(.system(size: 11, weight: .regular))
					.foregroundStyle(secondary)
					.accessibilityLabel(model.accessGlyph == "eye" ? "Read-only" : "Read-write")
			}
			Text(model.task)
				.font(Theme.text(12, .regular))
				.foregroundStyle(primary)
			HStack(spacing: 5) {
				Circle()
					.fill(model.stateColor)
					.frame(width: 6, height: 6)
				Text(model.stateLabel)
					.font(Theme.text(11, .medium))
					.foregroundStyle(CanvasStyle.text(
						model.stateColor, emphasis: emphasis, over: Theme.nodeFill))
			}
			Text(model.model)
				.font(Theme.text(10, .medium))
				.foregroundStyle(secondary)
			if let activity = model.activity {
				Text(activity)
					.font(Theme.mono(10, .regular))
					.foregroundStyle(primary)
					.lineLimit(1)
			}
		}
		.padding(8)
		.frame(width: SpineMetrics.standard.agentRowWidth)
		.frame(minHeight: SpineMetrics.standard.minHitHeight)
		.background(RoundedRectangle(cornerRadius: 8).fill(Theme.nodeFill))
		.overlay(RoundedRectangle(cornerRadius: 8)
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

	/// Header provider mark (`C` for Claude, `X` for Codex). The model
	/// carries the model id only, so the two known families are recognised
	/// and anything else falls back to the model id's initial.
	private var providerMark: String {
		let lower = model.model.lowercased()
		if lower.contains("codex") { return "X" }
		if lower.contains("claude") { return "C" }
		return model.model.first.map { String($0).uppercased() } ?? "·"
	}
}

/// The `+N completed` expander: a pill with a chevron that expands in place,
/// never a circle or a separate surface.
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
					.font(.system(size: 11, weight: .semibold))
					.foregroundStyle(Theme.textSecondary)
			}
			.padding(.horizontal, 10)
			.padding(.vertical, 5)
			.frame(minHeight: SpineMetrics.standard.minHitHeight)
			.background(Capsule().fill(Theme.subtleSurface))
			.overlay(Capsule().stroke(Theme.nodeBorder))
		}
		.buttonStyle(.plain)
		.accessibilityLabel("+\(count) completed, \(expanded ? "expanded" : "collapsed")")
	}
}
