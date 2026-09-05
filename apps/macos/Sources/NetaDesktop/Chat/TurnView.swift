import AgentChatKit
import SwiftUI

/// A single lazily materialised transcript block. Keeping the row at block
/// granularity matters because ACP commonly stores a complete prompt and a
/// long agent response as one turn.
public struct TranscriptRow: Identifiable, Equatable, Sendable {
	public let id: String
	public let turnId: TurnId
	public let block: Block
	public let isFirstInTurn: Bool
	public let isLastInTurn: Bool
	public let timestamp: Date
	public var scrollId: String { isFirstInTurn ? turnId : id }

	static func rows(for turns: [ChatTurn]) -> [TranscriptRow] {
		turns.flatMap { turn in
			let blocks = AgentChatAdapter.displayBlocks(turn.blocks)
			return blocks.enumerated().map { index, block in
				TranscriptRow(
					id: "\(turn.id):\(block.seq)", turnId: turn.id, block: block,
					isFirstInTurn: index == 0, isLastInTurn: index == blocks.count - 1,
					timestamp: turn.startedAt)
			}
		}
	}
}

/// One block row used by the panel's top-level LazyVStack. Expansion state
/// stays in the panel so recycling a row does not forget a disclosure.
public struct TranscriptRowView: View {
	let row: TranscriptRow
	let flashing: Bool
	@Binding var expanded: Bool
	var onAppear: (() -> Void)?

	public var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			rowBody
			if row.isLastInTurn {
				Text(Self.timeFormatter.string(from: row.timestamp))
					.font(Theme.mono(10, .regular)).foregroundStyle(Theme.textSecondary)
					.frame(maxWidth: .infinity, alignment: row.block.role == .user ? .trailing : .leading)
			}
		}
		.overlay { if flashing { RoundedRectangle(cornerRadius: TurnView.bubbleRadius).fill(Theme.violet.opacity(0.18)) } }
		.onAppear { onAppear?() }
	}

	@ViewBuilder private var rowBody: some View {
		switch TurnView.presentation(for: row.block.role) {
		case .userBubble:
			HStack(spacing: 0) {
				Spacer(minLength: 48)
				blockView.netaGlass(.rounded(TurnView.bubbleRadius), tint: Theme.Glass.userBubble)
			}
		case .agentBubble:
			HStack(spacing: 0) {
				blockView.background(
					Theme.Glass.agentBubble,
					in: RoundedRectangle(cornerRadius: TurnView.bubbleRadius, style: .continuous))
				Spacer(minLength: 48)
			}
		case .systemLine:
			blockView.frame(maxWidth: .infinity, alignment: .center)
		}
	}

	private var blockView: some View {
		AgentMessageBlockView(block: AgentChatAdapter.block(row.block), expanded: $expanded)
			.padding(10)
	}

	private static let timeFormatter: DateFormatter = {
		let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.dateFormat = "HH:mm"; return formatter
	}()
}

/// One transcript turn (11-desktop-chat T11.4).
///
/// The person's blocks sit in a violet glass bubble (`Theme.Glass.userBubble`,
/// the 0.35 of Revision 3 surface 2, with the glass rim) pushed to the
/// trailing edge; agent blocks sit on `Theme.Glass.agentBubble` at 0.06 on
/// the leading edge. System blocks are unbubbled, centred status lines. The
/// timestamp renders beneath in 10 px mono.
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

	/// The visual treatment is determined by each block run's role, because
	/// a turn can contain both a person's prompt and an agent reply.
	enum BlockRunPresentation: Equatable {
		case userBubble
		case agentBubble
		case systemLine
	}

	static func presentation(for role: Role) -> BlockRunPresentation {
		switch role {
		case .user: .userBubble
		case .agent: .agentBubble
		case .system: .systemLine
		}
	}

	static func timestampAlignment(for role: Role?) -> Alignment {
		switch role {
		case .user: .trailing
		case .system: .center
		case .agent, nil: .leading
		}
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
					alignment: Self.timestampAlignment(for: runs.last?.role))
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

	/// One block run: people and agents get their respective bubbles; system
	/// events remain a centred, unbubbled status line.
	@ViewBuilder
	private func runBody(_ run: BlockRun) -> some View {
		switch Self.presentation(for: run.role) {
		case .userBubble:
			HStack(spacing: 0) {
				Spacer(minLength: 48)
				blocksStack(run.blocks)
					.netaGlass(.rounded(Self.bubbleRadius), tint: Theme.Glass.userBubble)
					.overlay { flash }
			}
		case .agentBubble:
			HStack(spacing: 0) {
				blocksStack(run.blocks)
					.background(
						Theme.Glass.agentBubble,
						in: RoundedRectangle(
							cornerRadius: Self.bubbleRadius, style: .continuous))
					.overlay { flash }
				Spacer(minLength: 48)
			}
		case .systemLine:
			blocksStack(run.blocks)
				.frame(maxWidth: .infinity)
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
			ForEach(AgentChatAdapter.displayBlocks(blocks), id: \.seq) { block in
				AgentMessageBlockView(block: AgentChatAdapter.block(block), expanded: Binding(
					get: { expandedSeqs.contains(block.seq) },
					set: { value in
						if value { expandedSeqs.insert(block.seq) }
						else { expandedSeqs.remove(block.seq) }
					}))
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
