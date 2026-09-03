import SwiftUI

enum NetaTheme {
	static let canvas = Color(red: 0.055, green: 0.061, blue: 0.075)
	static let panel = Color(red: 0.095, green: 0.104, blue: 0.125).opacity(0.92)
	static let panelBorder = Color.white.opacity(0.10)
	static let primaryText = Color.white.opacity(0.94)
	static let secondaryText = Color.white.opacity(0.56)
	static let accent = Color(red: 0.45, green: 0.82, blue: 0.72)
	static let violet = Color(red: 0.60, green: 0.52, blue: 0.96)

	static func stateColor(_ state: AgentState) -> Color {
		switch state {
		case .running: accent
		case .thinking: Color(red: 0.54, green: 0.70, blue: 1.0)
		case .waiting: Color(red: 0.96, green: 0.68, blue: 0.28)
		case .paused: secondaryText
		case .done: Color(red: 0.49, green: 0.85, blue: 0.55)
		case .failed: Color(red: 1.0, green: 0.38, blue: 0.38)
		}
	}

	static func agentColor(_ agent: NetaAgent) -> Color {
		if agent.kind == .leader { return violet }
		let colors = [
			Color(red: 0.32, green: 0.70, blue: 0.95),
			Color(red: 0.95, green: 0.53, blue: 0.46),
			Color(red: 0.78, green: 0.64, blue: 0.31),
			Color(red: 0.44, green: 0.80, blue: 0.60),
		]
		return colors[paletteIndex(agent.id, count: colors.count)]
	}

	static func paletteIndex(_ id: String, count: Int) -> Int {
		id.utf8.reduce(0) { partial, byte in
			(partial + Int(byte)) % count
		}
	}
}

struct FloatingPanelModifier: ViewModifier {
	func body(content: Content) -> some View {
		content
			.background(.ultraThinMaterial)
			.background(NetaTheme.panel)
			.clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
			.overlay {
				RoundedRectangle(cornerRadius: 18, style: .continuous)
					.stroke(NetaTheme.panelBorder, lineWidth: 1)
			}
			.shadow(color: .black.opacity(0.28), radius: 28, y: 12)
	}
}

extension View {
	func floatingPanel() -> some View {
		modifier(FloatingPanelModifier())
	}
}
