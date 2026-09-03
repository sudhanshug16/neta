import SwiftUI

/// One transcript turn (11-desktop-chat T11.4).
///
/// User turns sit in a violet glass bubble; agent (and system) turns sit on
/// the subtle surface. The timestamp renders beneath in 10 px mono. When
/// `flashing` becomes true the turn flashes once — the scroll-to-turn
/// reveal from `ChatPaging` — then settles. Block expansion state lives
/// here; `BlockView` only reports its toggle.
public struct TurnView: View {
	private let turn: ChatTurn
	private let flashing: Bool
	@State private var expandedSeqs: Set<Int> = []
	@State private var flashActive = false

	public init(turn: ChatTurn, flashing: Bool) {
		self.turn = turn
		self.flashing = flashing
	}

	private static let timeFormatter: DateFormatter = {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.dateFormat = "HH:mm"
		return formatter
	}()

	public var body: some View {
		VStack(alignment: turn.role == .user ? .trailing : .leading, spacing: 4) {
			turnBody
			Text(Self.timeFormatter.string(from: turn.startedAt))
				.font(Theme.mono(10, .regular))
				.foregroundStyle(Theme.textSecondary)
		}
		.onAppear {
			if flashing {
				triggerFlash()
			}
		}
		.onChange(of: flashing) { _, newValue in
			if newValue {
				triggerFlash()
			}
		}
	}

	private var turnBody: some View {
		Group {
			if turn.role == .user {
				HStack(spacing: 0) {
					Spacer(minLength: 48)
					blocksStack
						.netaGlass(.rounded(16), tint: Theme.violet.opacity(0.25))
				}
			} else {
				blocksStack
					.background(Theme.subtleSurface, in: RoundedRectangle(cornerRadius: 12))
			}
		}
		.overlay {
			RoundedRectangle(cornerRadius: 12)
				.fill(Theme.violet.opacity(flashActive ? 0.28 : 0))
		}
	}

	private var blocksStack: some View {
		VStack(alignment: .leading, spacing: 8) {
			ForEach(turn.blocks, id: \.seq) { block in
				BlockView(block: block, expanded: expandedSeqs.contains(block.seq)) {
					if expandedSeqs.contains(block.seq) {
						expandedSeqs.remove(block.seq)
					} else {
						expandedSeqs.insert(block.seq)
					}
				}
			}
		}
		.padding(10)
	}

	private func triggerFlash() {
		flashActive = true
		withAnimation(.easeOut(duration: 0.9)) {
			flashActive = false
		}
	}
}
