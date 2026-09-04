import SwiftUI

/// The mission inbox bar (09-desktop-shell T9.9): the workspace leader, the
/// Now control, waiting missions with marks, running ones compact.
///
/// Order is leader, Now, divider, waiting missions grouped blocked, failed,
/// readyToClose, mergedNotClosed (number ascending within each group), then
/// running missions by number ascending. Closed missions never appear. Every
/// state-carrying item shows a text state label plus a mark; state is never
/// carried by color alone. Selecting a mission calls `onSelect(.mission(id))`;
/// the shell opens that lead's conversation and the spine (10) pans to it.
///
/// One glass capsule of glass chips, scrolling horizontally on overflow: no
/// counts, no cards, no status tiles, and never the Lead/Lead++ control (the
/// bar shows the mode as static text only).
public enum MissionBarItem: Equatable, Identifiable, Sendable {
	case leader(name: String, mode: LeaderMode)
	case now(lit: Bool)
	case divider
	/// Number, name, state label and attention mark.
	case waiting(Mission)
	/// Number and a mint dot only.
	case running(Mission)

	public var id: String {
		switch self {
		case .leader:
			return "leader"
		case .now:
			return "now"
		case .divider:
			return "divider"
		case .waiting(let mission):
			return "mission-\(mission.id)"
		case .running(let mission):
			return "mission-\(mission.id)"
		}
	}

	/// Text state label for every state-carrying item, so state never rides
	/// on color alone. Nil only for the divider, which carries no state.
	public var stateLabel: String? {
		switch self {
		case .leader(_, let mode):
			return mode == .leadPlus ? "Lead++" : "Lead"
		case .now:
			return "Now"
		case .divider:
			return nil
		case .waiting(let mission):
			return Self.label(for: mission.state)
		case .running:
			return "Running"
		}
	}

	/// Product-language labels (MANIFESTO.md "Product language").
	public static func label(for state: MissionState) -> String {
		switch state {
		case .blocked:
			return "Blocked"
		case .failed:
			return "Failed"
		case .readyToClose:
			return "Ready to close"
		case .mergedNotClosed:
			return "Merged, not closed"
		case .running:
			return "Running"
		case .closed:
			return "Archived"
		}
	}
}

public enum MissionBarModel {
	/// Builds the bar left to right: leader (when known), Now, divider,
	/// waiting missions grouped by attention order, then running missions.
	/// Closed missions never appear.
	public static func items(
		missions: [Mission],
		leader: Leader?,
		nowLit: Bool
	) -> [MissionBarItem] {
		var items: [MissionBarItem] = []
		if let leader {
			items.append(.leader(name: leaderDisplayName(leader), mode: leader.mode))
		}
		items.append(.now(lit: nowLit))
		items.append(.divider)
		let waiting = missions.filter(\.needsPerson)
		for state in [MissionState.blocked, .failed, .readyToClose, .mergedNotClosed] {
			items += waiting
				.filter { $0.state == state }
				.sorted { $0.number < $1.number }
				.map(MissionBarItem.waiting)
		}
		items += missions
			.filter { $0.state == .running }
			.sorted { $0.number < $1.number }
			.map(MissionBarItem.running)
		return items
	}

	/// The one place the app decides what to call the leader: the personal
	/// name on the record (01-domain `Leader.name`), never the workspace.
	/// Only a missing leader falls back to the generic word.
	public static func leaderDisplayName(_ leader: Leader?) -> String {
		guard let leader, !leader.name.isEmpty else { return "Leader" }
		return leader.name
	}
}

/// One scrolling glass capsule of glass chips. Mission chips call
/// `onSelect(.mission(id))`; the leader chip calls `onSelect(.leader)`. The
/// Now pill is rendered, not wired: tap-to-live-edge is owned by the spine
/// canvas (10), which also supplies the lit flag. The current `selection` is
/// shown as a mint outline on the matching chip.
public struct MissionBarView: View {
	private let items: [MissionBarItem]
	private let selection: Selection
	private let onSelect: (Selection) -> Void

	public init(
		items: [MissionBarItem],
		selection: Selection,
		onSelect: @escaping (Selection) -> Void
	) {
		self.items = items
		self.selection = selection
		self.onSelect = onSelect
	}

	public var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 6) {
				ForEach(items) { item in
					MissionBarChip(item: item, selected: isSelected(item), onSelect: onSelect)
				}
			}
			.padding(.horizontal, 10)
			.frame(height: Theme.Metric.missionBarHeight)
		}
		.frame(height: Theme.Metric.missionBarHeight)
		.netaGlass(.capsule)
	}

	private func isSelected(_ item: MissionBarItem) -> Bool {
		switch (item, selection) {
		case (.leader, .leader):
			return true
		case (.waiting(let mission), .mission(let id)):
			return mission.id == id
		case (.running(let mission), .mission(let id)):
			return mission.id == id
		default:
			return false
		}
	}
}

// MARK: - Private

/// One chip in the bar. Chips are glass; the mode indicator on the leader
/// chip is static text, never the Lead/Lead++ control.
private struct MissionBarChip: View {
	let item: MissionBarItem
	let selected: Bool
	let onSelect: (Selection) -> Void

	var body: some View {
		switch item {
		case .leader(let name, let mode):
			Button { onSelect(.leader) } label: {
				HStack(spacing: 6) {
					Circle()
						.fill(Theme.violet)
						.frame(width: 14, height: 14)
					Text(name)
						.font(Theme.text(12, .medium))
						.foregroundStyle(Theme.textPrimary)
					Text(mode == .leadPlus ? "Lead++" : "Lead")
						.font(Theme.text(10, .semibold))
						.foregroundStyle(mode == .leadPlus ? Theme.violet : Theme.textSecondary)
				}
				.padding(.horizontal, 10)
				.padding(.vertical, 5)
			}
			.buttonStyle(.plain)
			.netaGlass(.rounded(chipRadius))
			.overlay {
				if selected {
					Capsule().stroke(Theme.mint, lineWidth: 1.5)
				}
			}
			.accessibilityLabel("Workspace leader \(name), \(mode == .leadPlus ? "Lead++" : "Lead")")
		case .now(let lit):
			HStack(spacing: 6) {
				Circle()
					.fill(lit ? Theme.mint : Theme.textSecondary)
					.frame(width: 7, height: 7)
				Text("Now")
					.font(Theme.text(12, .medium))
					.foregroundStyle(lit ? Theme.textPrimary : Theme.textSecondary)
			}
			.padding(.horizontal, 10)
			.padding(.vertical, 5)
			.netaGlass(.rounded(chipRadius))
			.accessibilityLabel(lit ? "Now, at the live edge" : "Now, behind the live edge")
		case .divider:
			Divider()
				.frame(height: 20)
				.padding(.horizontal, 2)
		case .waiting(let mission):
			Button { onSelect(.mission(mission.id)) } label: {
				HStack(spacing: 5) {
					Text("#\(mission.number)")
						.font(Theme.mono(12, .medium))
						.foregroundStyle(Theme.textPrimary)
					Text(mission.name)
						.font(Theme.text(12, .regular))
						.foregroundStyle(Theme.textPrimary)
						.lineLimit(1)
					Text(MissionBarItem.label(for: mission.state))
						.font(Theme.text(12, .regular))
						.foregroundStyle(stateColor(for: mission.state))
					Circle()
						.fill(stateColor(for: mission.state))
						.frame(width: 6, height: 6)
				}
				.padding(.horizontal, 10)
				.padding(.vertical, 5)
			}
			.buttonStyle(.plain)
			.netaGlass(.rounded(chipRadius))
			.overlay {
				if selected {
					Capsule().stroke(Theme.mint, lineWidth: 1.5)
				}
			}
			.accessibilityLabel("#\(mission.number) \(mission.name), \(MissionBarItem.label(for: mission.state))")
		case .running(let mission):
			Button { onSelect(.mission(mission.id)) } label: {
				HStack(spacing: 5) {
					Text("#\(mission.number)")
						.font(Theme.mono(12, .medium))
						.foregroundStyle(Theme.textPrimary)
					Circle()
						.fill(Theme.mint)
						.frame(width: 6, height: 6)
				}
				.padding(.horizontal, 10)
				.padding(.vertical, 5)
			}
			.buttonStyle(.plain)
			.netaGlass(.rounded(chipRadius))
			.overlay {
				if selected {
					Capsule().stroke(Theme.mint, lineWidth: 1.5)
				}
			}
			.accessibilityLabel("#\(mission.number) \(mission.name), Running")
		}
	}
}

/// Nested-chip radius inside the bar capsule.
private var chipRadius: CGFloat {
	Theme.Metric.concentric(outer: Theme.Metric.barRadius, padding: 8)
}

/// Restrained semantic color to go with the text label, never alone.
private func stateColor(for state: MissionState) -> Color {
	switch state {
	case .blocked:
		return Theme.amber
	case .failed:
		return Theme.red
	case .readyToClose, .mergedNotClosed:
		return Theme.blue
	case .running:
		return Theme.mint
	case .closed:
		return Theme.textSecondary
	}
}
