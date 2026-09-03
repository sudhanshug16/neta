import SwiftUI

/// The assembled chat surface (11-desktop-chat T11.8).
///
/// A header (`ChatHeaderView`), the Lead++ strip when visible, the
/// transcript, and the composer (`ComposerView`). The transcript is a
/// `LazyVStack` of `TurnView`s: it pins to `autoScrollTarget` while at the
/// bottom and drains one-shot reveals via `consumeScroll` (flashing the
/// target). The Details button flips `isDetailsOpen`; the inspector then
/// sits `beside` the transcript on wide windows
/// (`DetailsPlacement.forWidth`) or `replaces` it on narrow ones, with a
/// back control to the transcript.
public struct ChatPanel: View {
	@Bindable private var model: ChatPanelModel
	private let windowWidth: CGFloat?
	@State private var flashingTurnId: TurnId?
	@State private var scrollPosition: TurnId?

	public init(model: ChatPanelModel, windowWidth: CGFloat? = nil) {
		self.model = model
		self.windowWidth = windowWidth
	}

	public init(
		client: any NodeClient, store: Store, shell: ShellState,
		windowWidth: CGFloat? = nil
	) {
		self.init(
			model: ChatPanelModel(client: client, store: store, shell: shell),
			windowWidth: windowWidth)
	}

	public var body: some View {
		GeometryReader { proxy in
			let placement = DetailsPlacement.forWidth(windowWidth ?? proxy.size.width)
			VStack(alignment: .leading, spacing: 0) {
				ChatHeaderView(
					selection: model.selection, store: model.store,
					onDetails: { model.isDetailsOpen.toggle() },
					onSelect: { model.select($0) })
					.padding(.horizontal, 12)
					.padding(.top, 10)
					.padding(.bottom, 8)
				if LeadPlusStripModel.isVisible(model.store.leader, model.selection) {
					LeadPlusStrip(minutes: activeMinutes, mission: activeMission)
						.padding(.horizontal, 12)
						.padding(.bottom, 8)
				}
				content(placement: placement)
					.frame(maxWidth: .infinity, maxHeight: .infinity)
				Divider()
				ComposerView(model: model.composer)
					.padding(.horizontal, 12)
					.padding(.vertical, 10)
			}
			.frame(width: proxy.size.width, height: proxy.size.height)
		}
		.task {
			await model.start()
		}
		.onChange(of: model.selection) { _, _ in
			flashingTurnId = nil
			Task { await model.start() }
		}
		.onChange(of: model.transcript.openTurnId) { _, _ in
			model.syncComposer()
		}
	}

	// MARK: - Content

	@ViewBuilder
	private func content(placement: DetailsPlacement) -> some View {
		if model.isDetailsOpen, placement == .replacing {
			DetailsView(
				selection: model.selection, store: model.store,
				decision: model.decision, placement: placement,
				onBack: { model.isDetailsOpen = false })
				.padding(.horizontal, 12)
				.padding(.vertical, 8)
		} else if model.isDetailsOpen {
			HStack(alignment: .top, spacing: 0) {
				transcript
					.frame(maxWidth: .infinity, maxHeight: .infinity)
				Divider()
				DetailsView(
					selection: model.selection, store: model.store,
					decision: model.decision, placement: placement,
					onBack: { model.isDetailsOpen = false })
					.frame(width: 180)
					.padding(.horizontal, 12)
					.padding(.vertical, 8)
			}
		} else {
			transcript
		}
	}

	/// The transcript: every loaded turn in a `LazyVStack`, pinned to the
	/// live end while `atBottom`, with one-shot scroll-to-turn reveals
	/// drained from `pendingScroll` via `consumeScroll`.
	private var transcript: some View {
		ScrollViewReader { scroll in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 12) {
					ForEach(model.transcript.turns) { turn in
						TurnView(turn: turn, flashing: flashingTurnId == turn.id)
							.id(turn.id)
					}
				}
				.scrollTargetLayout()
				.padding(.horizontal, 12)
				.padding(.vertical, 8)
			}
			.scrollPosition(id: $scrollPosition)
			.defaultScrollAnchor(.bottom)
			.onAppear {
				model.transcript.atBottom = true
				drainScroll(scroll)
				if let target = model.transcript.autoScrollTarget {
					scroll.scrollTo(target, anchor: .bottom)
				}
			}
			.onChange(of: model.transcript.autoScrollTarget) { _, target in
				guard let target, model.transcript.atBottom else { return }
				scroll.scrollTo(target, anchor: .bottom)
			}
			.onChange(of: model.transcript.pendingScroll) { _, _ in
				drainScroll(scroll)
			}
			.onChange(of: scrollPosition) { _, position in
				if let last = model.transcript.turns.last?.id {
					model.transcript.atBottom = (position == last)
				} else {
					model.transcript.atBottom = true
				}
			}
		}
	}

	/// Drains one pending reveal: flashes the target and scrolls it into
	/// view. Nil when nothing was requested.
	private func drainScroll(_ scroll: ScrollViewProxy) {
		guard let request = model.transcript.consumeScroll() else { return }
		flashingTurnId = request.flash ? request.turnId : nil
		scroll.scrollTo(request.turnId, anchor: .center)
	}

	// MARK: - Lead++ strip

	/// Whole active minutes: integer division floors.
	private var activeMinutes: Int {
		(model.store.leader?.modeActiveMs ?? 0) / 60_000
	}

	/// The leader's active mission, when it names one the store knows.
	private var activeMission: Mission? {
		model.store.leader?.activeMissionId.flatMap { model.store.missionsById[$0] }
	}
}
