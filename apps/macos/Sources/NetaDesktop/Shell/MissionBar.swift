import SwiftUI

/// The mission inbox bar (09-desktop-shell T9.9): the workspace leader, the
/// Now control, waiting missions with marks, running ones compact.
///
/// Order is leader, Now, divider, waiting missions grouped blocked, failed,
/// readyToClose, mergedNotClosed (number ascending within each group), then
/// running missions by number ascending. Closed missions never appear. Selecting a mission calls `onSelect(.mission(id))`;
/// the shell opens that lead's conversation and the spine (10) pans to it.
///
/// Every waiting chip carries its state as text beside its mark. The running
/// chip is the design's compact form — sigil, number, mint dot (PAPER-SPINE
/// item 5, plan T9.9) — so its state label is not painted on the chip: it is
/// reachable on hover (`.help`) and through the accessibility label, which is
/// what keeps "status is never carried by colour alone" true for it. The
/// number and the sigil identify the mission without colour; the dot alone
/// would carry the state, so the text state is one hover away rather than
/// absent.
///
/// One glass capsule of glass chips, scrolling horizontally on overflow: no
/// counts, no cards, no status tiles, and never the Lead/Lead++ control (the
/// bar shows the mode as static text only).
public enum MissionBarItem: Equatable, Identifiable, Sendable {
	case leader(name: String, mode: LeaderMode)
	/// The Now control: 10 owns both the label ("Now", "Now · 3h back") and
	/// the lit flag; the bar only renders them.
	case now(label: String, lit: Bool)
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
		case .now(let label, _):
			return label
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
	///
	/// The divider only separates something from something: a workspace with
	/// no waiting and no running mission is the leader and Now alone, never a
	/// hairline with nothing after it. The empty state is the leader at Now.
	public static func items(
		missions: [Mission],
		leader: Leader?,
		nowLabel: String = "Now",
		nowLit: Bool
	) -> [MissionBarItem] {
		var items: [MissionBarItem] = []
		if let leader {
			items.append(.leader(name: leaderDisplayName(leader), mode: leader.mode))
		}
		items.append(.now(label: nowLabel, lit: nowLit))
		var chips: [MissionBarItem] = []
		let waiting = missions.filter(\.needsPerson)
		for state in [MissionState.blocked, .failed, .readyToClose, .mergedNotClosed] {
			chips += waiting
				.filter { $0.state == state }
				.sorted { $0.number < $1.number }
				.map(MissionBarItem.waiting)
		}
		chips += missions
			.filter { $0.state == .running }
			.sorted { $0.number < $1.number }
			.map(MissionBarItem.running)
		guard !chips.isEmpty else { return items }
		items.append(.divider)
		return items + chips
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
/// `onSelect(.mission(id))`; the leader chip calls `onSelect(.leader)`; the
/// Now pill calls `onNow`, which jumps the spine to the live edge. The label
/// and lit flag come from 10's `NowState`. The current `selection` is shown
/// as a mint outline on the matching chip.
public struct MissionBarView: View {
	private let items: [MissionBarItem]
	private let selection: Selection
	private let onSelect: (Selection) -> Void
	private let onNow: () -> Void

	public init(
		items: [MissionBarItem],
		selection: Selection,
		onSelect: @escaping (Selection) -> Void,
		onNow: @escaping () -> Void = {}
	) {
		self.items = items
		self.selection = selection
		self.onSelect = onSelect
		self.onNow = onNow
	}

	public var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 6) {
				ForEach(items) { item in
					MissionBarChip(
						item: item, selected: isSelected(item),
						onSelect: onSelect, onNow: onNow)
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
	let onNow: () -> Void

	var body: some View {
		switch item {
		case .leader(let name, let mode):
			Button { onSelect(.leader) } label: {
				HStack(spacing: 8) {
					ZStack {
						Circle()
							.fill(Theme.violet)
							.frame(width: 28, height: 28)
						// One definition of the leader mark: the same `Theme`
						// font and colour the canvas leader card uses, never a
						// colour or font literal.
						Image(systemName: "crown.fill")
							.font(Theme.text(13, .semibold))
							.foregroundStyle(Theme.textPrimary)
					}
					.accessibilityHidden(true)
					Text(name)
						.font(Theme.text(12, .medium))
						.foregroundStyle(Theme.textPrimary)
					Text(mode == .leadPlus ? "LEAD++" : "LEAD")
						.font(Theme.text(10, .semibold))
						.foregroundStyle(mode == .leadPlus ? Theme.violet : Theme.textSecondary)
						.padding(.horizontal, 7)
						.padding(.vertical, 3)
						.background(Capsule().fill(Theme.subtleSurface))
				}
				.padding(.leading, 6)
				.padding(.trailing, 10)
				.padding(.vertical, 4)
				.frame(minHeight: 26)
			}
			.buttonStyle(.plain)
			.netaGlass(.rounded(chipRadius))
			.overlay {
				if selected {
					Capsule().stroke(Theme.mint, lineWidth: 1.5)
				}
			}
			.accessibilityLabel("Workspace leader \(name), \(mode == .leadPlus ? "Lead++" : "Lead")")
		case .now(let label, let lit):
			// Lit: a mint dot and the word Now. Behind the live edge: no
			// dot and how far back the view is, so the state never rides on
			// colour alone. Tapping jumps the spine back to Now.
			Button(action: onNow) {
				HStack(spacing: 6) {
					if lit {
						Circle()
							.fill(Theme.mint)
							.frame(width: 7, height: 7)
					}
					Text(label)
						.font(Theme.digits(Theme.text(12, .medium)))
						.foregroundStyle(lit ? Theme.textPrimary : Theme.textSecondary)
				}
				.padding(.horizontal, 10)
				.padding(.vertical, 5)
				.frame(minHeight: 26)
			}
			.buttonStyle(.plain)
			.netaGlass(.rounded(chipRadius))
			.accessibilityLabel(
				lit ? "Now, at the live edge" : "\(label), jump to Now")
		case .divider:
			// A Theme hairline, not a system Divider: the bar's own rule.
			Rectangle()
				.fill(Theme.divider)
				.frame(width: 1, height: 20)
				.padding(.horizontal, 4)
				.accessibilityHidden(true)
		case .waiting(let mission):
			Button { onSelect(.mission(mission.id)) } label: {
				HStack(spacing: 6) {
					SigilView(name: mission.name, size: 12)
						.accessibilityHidden(true)
					Text("#\(mission.number)")
						.font(Theme.mono(12, .medium))
						.foregroundStyle(Theme.textPrimary)
					Text(mission.name)
						.font(Theme.text(12, .regular))
						.foregroundStyle(Theme.textPrimary)
						.lineLimit(1)
						.truncationMode(.tail)
						.frame(maxWidth: 150, alignment: .leading)
					// The attention mark and its label, both in the state
					// colour: never the colour alone.
					Image(systemName: "exclamationmark")
						.font(Theme.text(10, .bold))
						.foregroundStyle(stateColor(for: mission.state))
					Text(MissionBarItem.label(for: mission.state))
						.font(Theme.text(12, .regular))
						.foregroundStyle(stateColor(for: mission.state))
				}
				.padding(.horizontal, 10)
				.padding(.vertical, 5)
				.frame(minHeight: 26)
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
				HStack(spacing: 6) {
					SigilView(name: mission.name, size: 12)
						.accessibilityHidden(true)
					Text("#\(mission.number)")
						.font(Theme.mono(12, .medium))
						.foregroundStyle(Theme.textPrimary)
					Circle()
						.fill(Theme.mint)
						.frame(width: 6, height: 6)
				}
				.padding(.horizontal, 10)
				.padding(.vertical, 5)
				.frame(minHeight: 26)
			}
			.buttonStyle(.plain)
			.netaGlass(.rounded(chipRadius))
			.overlay {
				if selected {
					Capsule().stroke(Theme.mint, lineWidth: 1.5)
				}
			}
			// The compact chip's text state: on hover for the pointer, on
			// the accessibility label for VoiceOver. The mint dot is never
			// the only thing that says Running.
			.help("#\(mission.number) \(mission.name) · Running")
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
