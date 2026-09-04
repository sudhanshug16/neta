import SwiftUI

/// How the transcript hangs inside its scroll view (T11.8).
///
/// The design has the newest message directly above the composer: the
/// scrolled content is at least the height of the panel and sits at the
/// bottom of it, so a short transcript grows upward from the composer and a
/// long one is unchanged (its content is already taller than the panel).
/// Pure, so the rule is asserted rather than eyeballed.
public enum TranscriptAnchor {
	/// The padding above and below the turns, inside the scroll view. It is
	/// inside the min-height frame, so it is also the gap the newest turn
	/// keeps above the composer's rule.
	public static let verticalPadding: CGFloat = 8
	/// Where the turns sit in that frame.
	public static let alignment: Alignment = .bottom

	/// The minimum height of the scrolled content for a panel of `viewport`
	/// points. A viewport SwiftUI has not measured yet is 0, and a frame
	/// never takes a negative minimum.
	public static func contentMinHeight(viewport: CGFloat) -> CGFloat {
		max(0, viewport)
	}
}

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
	private let router: CheckpointRouter?
	private let windowWidth: CGFloat?
	@State private var flashingTurnId: TurnId?
	@State private var scrollPosition: TurnId?

	/// - Parameters:
	///   - model: The panel's state, owned by `RootView` in `@State`. There
	///     is deliberately no convenience initializer that builds one here:
	///     a model built inside `body` is rebuilt on every parent update,
	///     which threw the transcript, the draft and the open inspector away
	///     on the first live notification.
	///   - router: The canvas's checkpoint router (10). The panel drains it:
	///     a checkpoint on a turn scrolls the transcript there, anything
	///     else opens Details.
	public init(
		model: ChatPanelModel, router: CheckpointRouter? = nil,
		windowWidth: CGFloat? = nil
	) {
		self.model = model
		self.router = router
		self.windowWidth = windowWidth
	}

	public var body: some View {
		GeometryReader { proxy in
			let placement = DetailsPlacement.forWidth(windowWidth ?? proxy.size.width)
			VStack(alignment: .leading, spacing: 0) {
				ChatHeaderView(
					selection: model.selection, store: model.store,
					onDetails: { model.isDetailsOpen.toggle() },
					onSelect: { model.select($0) })
					.padding(.horizontal, Theme.Metric.chatPadding)
					.padding(.top, 10)
					.padding(.bottom, 8)
				if LeadPlusStripModel.isVisible(model.store.leader, model.selection) {
					LeadPlusStrip(minutes: activeMinutes, mission: activeMission)
						.padding(.horizontal, Theme.Metric.chatPadding)
						.padding(.bottom, 8)
				}
				content(placement: placement)
					.frame(maxWidth: .infinity, maxHeight: .infinity)
				hairline
				ComposerView(model: model.composer)
					.padding(.horizontal, Theme.Metric.chatPadding)
					.padding(.vertical, 10)
			}
			.frame(width: proxy.size.width, height: proxy.size.height)
		}
		.task {
			await model.start()
		}
		// The panel follows the shell, not only its own header: a click on
		// the canvas or a chip in the mission bar moves `shell.selection`
		// without going through `model.select`.
		.onChange(of: model.shell.selection) { _, _ in
			model.sync()
		}
		// And it follows the session the selection resolves to. The leader
		// (and with it the session id) arrives with the first snapshot,
		// after the panel is built, and changes again on a workspace switch
		// or a reconnect; the selection is `.leader` throughout.
		.onChange(of: model.currentSessionId) { _, _ in
			model.sync()
		}
		// The restart watches the transcript itself, not the session id.
		// `select`/`sync` can install a fresh, untailed `ChatViewModel`
		// while the id stands still (every leader-led mission resolves to
		// the leader's session), and a session-id watch left that
		// transcript unstarted: it never tailed and never streamed, so the
		// conversation blanked and a prompt streamed into nothing.
		.onChange(of: model.transcriptId) { _, _ in
			flashingTurnId = nil
			Task { await model.start() }
		}
		.onChange(of: model.transcript.openTurnId) { _, _ in
			model.syncComposer()
		}
		.onChange(of: router?.pending) { _, _ in
			guard let action = router?.consume() else { return }
			Task { await model.handle(action) }
		}
	}

	// MARK: - Rules

	/// The panel's rules are `Theme.divider` hairlines, never the system
	/// `Divider`, which paints its own separator colour. The thickness is
	/// `Theme.Metric.ruleWidth`, not the glass rim: a rule is not part of
	/// the material and must not follow it.
	private var hairline: some View {
		Rectangle()
			.fill(Theme.divider)
			.frame(height: Theme.Metric.ruleWidth)
	}

	private var verticalHairline: some View {
		Rectangle()
			.fill(Theme.divider)
			.frame(width: Theme.Metric.ruleWidth)
	}

	// MARK: - Content

	@ViewBuilder
	private func content(placement: DetailsPlacement) -> some View {
		if model.isDetailsOpen, placement == .replacing {
			DetailsView(
				selection: model.selection, store: model.store,
				decision: model.decision, placement: placement,
				onBack: { model.isDetailsOpen = false })
				.padding(.horizontal, Theme.Metric.chatPadding)
				.padding(.vertical, 8)
		} else if model.isDetailsOpen {
			HStack(alignment: .top, spacing: 0) {
				transcript
					.frame(maxWidth: .infinity, maxHeight: .infinity)
				verticalHairline
				DetailsView(
					selection: model.selection, store: model.store,
					decision: model.decision, placement: placement,
					onBack: { model.isDetailsOpen = false })
					.frame(width: 180)
					.padding(.horizontal, Theme.Metric.chatPadding)
					.padding(.vertical, 8)
			}
		} else {
			transcript
		}
	}

	/// The transcript: every loaded turn in a `LazyVStack`, bottom-anchored
	/// so the newest message sits directly above the composer, pinned to the
	/// live end while `atBottom` by an explicit `scrollTo`, with one-shot
	/// scroll-to-turn reveals drained from `pendingScroll` via
	/// `consumeScroll`. An empty transcript is simply empty: the design has
	/// no empty-state placeholder.
	private var transcript: some View {
		ScrollViewReader { scroll in
			GeometryReader { proxy in
				ScrollView {
					LazyVStack(alignment: .leading, spacing: 12) {
						ForEach(model.transcript.visibleTurns) { turn in
							TurnView(turn: turn, flashing: flashingTurnId == turn.id)
								.id(turn.id)
						}
					}
					.scrollTargetLayout()
					.padding(.horizontal, Theme.Metric.chatPadding)
					.padding(.vertical, TranscriptAnchor.verticalPadding)
					// The bottom anchor: the scrolled content is at least as
					// tall as the panel and sits at the bottom of it, so a
					// two-message conversation reads from just above the
					// composer instead of hanging from the header, and a long
					// one scrolls with its live end where it already was.
					.frame(
						minHeight: TranscriptAnchor.contentMinHeight(
							viewport: proxy.size.height),
						alignment: TranscriptAnchor.alignment)
				}
				.scrollPosition(id: $scrollPosition)
				// Bottom-anchored by that frame, not by a default scroll
				// anchor of `.bottom`: on this system that modifier
				// moved the whole stack out of the clip view and the transcript
				// drew nothing at all — a tailed, streaming conversation
				// rendered as an empty panel (seen with two turns and four
				// blocks loaded). The live end is pinned explicitly on top of
				// the anchor: `.onAppear` and the `autoScrollTarget` watch below
				// scroll to the newest drawn turn, which is what `atBottom`
				// gates anyway.
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
					if let last = model.transcript.visibleTurns.last?.id {
						model.transcript.atBottom = (position == last)
					} else {
						model.transcript.atBottom = true
					}
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
