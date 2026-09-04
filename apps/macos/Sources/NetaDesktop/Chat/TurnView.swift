import SwiftUI

/// One transcript turn (11-desktop-chat T11.4).
///
/// The person's blocks sit in a violet glass bubble (`Theme.Glass.userBubble`,
/// the 0.35 of Revision 3 surface 2, with the glass rim) pushed to the
/// trailing edge; agent and system blocks sit on `Theme.Glass.agentBubble` at
/// 0.06 on the leading edge. The timestamp renders beneath in 10 px mono.
/// When `flashing` becomes true the turn flashes once — the scroll-to-turn
/// reveal from `ChatPaging` — then settles. Block expansion state lives here;
/// `BlockView` only reports its toggle.
///
/// The bubble follows each BLOCK's own role, not the turn's. The Node opens
/// one turn with role `user` and files the agent's reply into it as further
/// blocks (verified on the wire: seq 1 role user, seq 2 role agent, both in a
/// turn whose role is user), so styling the whole turn by `turn.role` drew
/// the leader's answer as the person's own violet message.
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

	/// One run of neighbouring blocks that share a role: one bubble each.
	/// Identified by the first block's `seq`, which is unique in a turn.
	struct BlockRun: Identifiable {
		let id: Int
		let role: Role
		let blocks: [Block]
	}

	/// The turn's blocks split into same-role runs, in `seq` order.
	static func runs(of blocks: [Block]) -> [BlockRun] {
		var runs: [BlockRun] = []
		for block in blocks {
			if let last = runs.last, last.role == block.role {
				runs[runs.count - 1] = BlockRun(
					id: last.id, role: last.role, blocks: last.blocks + [block])
			} else {
				runs.append(BlockRun(id: block.seq, role: block.role, blocks: [block]))
			}
		}
		return runs
	}

	public var body: some View {
		// A turn with no blocks draws nothing at all — not an empty bubble
		// with a timestamp under it. The Node opens the user turn before any
		// block exists, and `ChatViewModel.echoUserMessage` is what shows the
		// person's own text. The transcript filters these out too, so no
		// stack spacing is reserved for a turn that draws nothing.
		if turn.blocks.isEmpty {
			EmptyView()
		} else {
			turnContent
		}
	}

	private var turnContent: some View {
		let runs = Self.runs(of: turn.blocks)
		return VStack(alignment: .leading, spacing: 6) {
			ForEach(runs) { run in
				runBody(run)
			}
			Text(Self.timeFormatter.string(from: turn.startedAt))
				.font(Theme.mono(10, .regular))
				.foregroundStyle(Theme.textSecondary)
				.frame(
					maxWidth: .infinity,
					alignment: runs.last?.role == .user ? .trailing : .leading)
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

	/// One bubble: the person's blocks trailing on violet glass, everyone
	/// else's leading on the 0.06 agent tone.
	private func runBody(_ run: BlockRun) -> some View {
		HStack(spacing: 0) {
			if run.role == .user {
				Spacer(minLength: 48)
				blocksStack(run.blocks)
					.netaGlass(.rounded(Self.bubbleRadius), tint: Theme.Glass.userBubble)
					.overlay { flash }
			} else {
				blocksStack(run.blocks)
					.background(
						Theme.Glass.agentBubble,
						in: RoundedRectangle(
							cornerRadius: Self.bubbleRadius, style: .continuous))
					.overlay { flash }
				Spacer(minLength: 48)
			}
		}
	}

	private var flash: some View {
		RoundedRectangle(cornerRadius: Self.bubbleRadius, style: .continuous)
			.fill(Theme.violet.opacity(flashActive ? 0.28 : 0))
	}

	/// One radius for a bubble and the flash that covers it, and it is the
	/// concentric radius Revision 3 reserves for a control nested inside the
	/// chat panel (panel radius less the chat padding) — the same value the
	/// composer field takes, never a second unrelated literal.
	static var bubbleRadius: CGFloat {
		Theme.Metric.concentric(
			outer: Theme.Metric.panelRadius, padding: Theme.Metric.chatPadding)
	}

	private func blocksStack(_ blocks: [Block]) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			ForEach(blocks, id: \.seq) { block in
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
