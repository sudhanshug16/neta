import SwiftUI

/// The Lead++ banner beneath the chat header (11-desktop-chat T11.5).
///
/// Violet glass at 18% with a clock icon. Pass `leader.modeActiveMs / 60_000`
/// for `minutes`: integer division floors, so the count is whole active
/// minutes. The mission clause (`· #<number> <name>`) drops when there is no
/// mission. Visibility is `LeadPlusStripModel.isVisible`: the leader
/// selection while the leader is in `leadPlus`, hidden for agents and for
/// `lead`.
public enum LeadPlusStripModel {
	public static func isVisible(_ leader: Leader?, _ s: Selection) -> Bool {
		guard let leader, leader.mode == .leadPlus else { return false }
		return s == .leader
	}

	public static func text(minutes: Int, mission: Mission?) -> String {
		guard let mission else { return "Lead++ active \(minutes) min" }
		return "Lead++ active \(minutes) min · #\(mission.number) \(mission.name)"
	}
}

public struct LeadPlusStrip: View {
	private let minutes: Int
	private let mission: Mission?

	public init(minutes: Int, mission: Mission?) {
		self.minutes = minutes
		self.mission = mission
	}

	public var body: some View {
		HStack(spacing: 6) {
			Image(systemName: "clock")
				.font(Theme.text(11, .regular))
			Text(LeadPlusStripModel.text(minutes: minutes, mission: mission))
				.font(Theme.text(11, .medium))
				.lineLimit(1)
		}
		.foregroundStyle(Theme.textPrimary)
		.padding(.horizontal, 10)
		.padding(.vertical, 6)
		.frame(maxWidth: .infinity, alignment: .leading)
		.netaGlass(.rounded(12), tint: Theme.violet.opacity(0.18))
		.accessibilityLabel(LeadPlusStripModel.text(minutes: minutes, mission: mission))
	}
}
