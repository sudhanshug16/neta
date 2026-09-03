import SwiftUI

struct AgentAvatar: View {
	let agent: NetaAgent
	var size: CGFloat = 42

	var body: some View {
		ZStack {
			Circle()
				.fill(NetaTheme.agentColor(agent).gradient)
			Image(systemName: agent.kind == .leader ? "crown.fill" : symbol)
				.font(.system(size: size * 0.37, weight: .semibold))
				.foregroundStyle(.white.opacity(0.94))
		}
		.frame(width: size, height: size)
		.overlay(alignment: .bottomTrailing) {
			Circle()
				.fill(NetaTheme.stateColor(agent.state))
				.frame(width: size * 0.23, height: size * 0.23)
				.overlay(Circle().stroke(NetaTheme.canvas, lineWidth: 2))
		}
		.accessibilityLabel("\(agent.name), \(agent.state.label)")
	}

	private var symbol: String {
		let symbols = ["sparkles", "scope", "hammer.fill", "checkmark.seal.fill"]
		return symbols[NetaTheme.paletteIndex(agent.id, count: symbols.count)]
	}
}
