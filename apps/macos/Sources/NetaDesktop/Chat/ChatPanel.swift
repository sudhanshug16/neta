import AgentChatKit
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
	private let rowDidAppear: ((String) -> Void)?
	@State private var flashingTurnId: TurnId?
	@State private var expandedGlance: Set<String> = []
	@State private var expandedBlocks: Set<String> = []
	@State private var userIsScrolling = false
	@State private var geometryAtBottom = true
	@State private var followingLatest = true
	@State private var layoutRevision = 0
	@State private var liveScrollTarget: String?
	@State private var followTask: Task<Void, Never>?
	@State private var followRunId = 0

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
		windowWidth: CGFloat? = nil, rowDidAppear: ((String) -> Void)? = nil
	) {
		self.model = model
		self.router = router
		self.windowWidth = windowWidth
		self.rowDidAppear = rowDidAppear
	}

	public var body: some View {
		GeometryReader { proxy in
			let placement = DetailsPlacement.forWidth(windowWidth ?? proxy.size.width)
			VStack(alignment: .leading, spacing: 0) {
				ChatHeaderView(
					selection: model.selection, store: model.store,
					isResponding: model.transcript.openTurnId != nil,
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
		.sheet(item: Binding(get: { model.glance.openedSource }, set: { if $0 == nil { model.glance.closeSource() } })) { item in
			VStack(alignment: .leading, spacing: 12) {
				Text("Original message").font(.headline)
				Text("\(item.card.agentLabel ?? (item.card.actorKind == "leader" ? "Leader" : "Agent")) · \(item.card.at.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
				if item.source.sourceTruncated { Text("This saved source is truncated.").font(.caption).foregroundStyle(.orange) }
				ScrollView { Text(item.source.source).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
				HStack { Spacer(); Button("Done") { model.glance.closeSource() }.keyboardShortcut(.defaultAction).accessibilityIdentifier("glance-source-done") }
			}.padding(20).frame(minWidth: 520, minHeight: 420)
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
		// A queued agent already has its eventual session id. When writer
		// access releases it into starting, retry that same transcript: the
		// session-id watcher above deliberately cannot see this transition.
		.onChange(of: model.isQueuedSelection) { wasQueued, isQueued in
			Task { await model.queueReleased(wasQueued: wasQueued) }
		}
		// The restart watches the transcript itself, not the session id.
		// `select`/`sync` can install a fresh, untailed `ChatViewModel`
		// while the id stands still (every leader-led mission resolves to
		// the leader's session), and a session-id watch left that
		// transcript unstarted: it never tailed and never streamed, so the
		// conversation blanked and a prompt streamed into nothing.
		.onChange(of: model.transcriptId) { _, _ in
			cancelFollowTask()
			flashingTurnId = nil
			liveScrollTarget = nil
			// The old scrollPosition binding is intentionally gone; the new
			// transcript starts with no retained anchor (`scrollPosition = nil`).
			// `scrollPosition` belongs to this view, rather than the transcript,
			// so it survives a session change. Clear the old turn id before the
			// new tail installs different ids; otherwise ScrollView can remain
			// parked at an anchor that no longer exists and draw a blank panel.
			// A fresh transcript defaults to the live end. State it here too:
			// the position binding updates after this handler, and the first
			// tail must be allowed to repin immediately.
			model.transcript.atBottom = true
			followingLatest = true
			Task { await model.start() }
		}
		.onDisappear { cancelFollowTask() }
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
				selection: model.selection, store: model.store, client: model.client,
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
					selection: model.selection, store: model.store, client: model.client,
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
						if model.transcript.hasOlder {
							Button("Load earlier") { loadEarlier(scroll) }
								.buttonStyle(.bordered).frame(maxWidth: .infinity)
								.accessibilityIdentifier("chat-load-earlier")
						}
						ForEach(model.transcript.transcriptRows) { row in
							TranscriptRowView(
								row: row, flashing: flashingTurnId == row.turnId,
								expanded: Binding(
									get: { expandedBlocks.contains(row.id) },
									set: { value in
										if value { expandedBlocks.insert(row.id) } else { expandedBlocks.remove(row.id) }
										followAfterLayout(scroll)
									}),
								onAppear: {
									rowDidAppear?(row.id)
									if row.isLastInTurn { followAfterLayout(scroll) }
								})
								.id(row.scrollId)
						}
						if model.selection == .leader,
							!model.glance.unread.isEmpty || model.glance.hasMore || model.glance.error != nil
						{ glanceSection(scroll) }
						Color.clear.frame(height: 1).id("live-end")
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
				.scrollPosition(id: $liveScrollTarget, anchor: .bottom)
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
				.onChange(of: model.transcript.contentRevision) { _, _ in
					model.transcript.enforceCacheAroundLatest()
					followAfterLayout(scroll)
				}
				// Replaces the former `.onChange(of: model.transcript.autoScrollTarget)`:
				// a turn id does not change while its streamed blocks grow.
				.onChange(of: model.glance.unread) { old, new in
					guard new != old else { return }
					followAfterLayout(scroll)
				}
				.onChange(of: model.transcript.pendingScroll) { _, _ in
					drainScroll(scroll)
				}
				.onScrollGeometryChange(for: Bool.self) { geometry in
					geometry.contentOffset.y + geometry.containerSize.height
						>= geometry.contentSize.height - 24
				} action: { _, pinned in
					geometryAtBottom = pinned
					if userIsScrolling {
						model.transcript.atBottom = pinned
						followingLatest = pinned
					}
				}
				.onScrollPhaseChange { _, phase in
					if phase != .idle && phase != .animating {
						userIsScrolling = true
						cancelFollowTask()
					} else if phase == .idle, userIsScrolling {
						userIsScrolling = false
						model.transcript.atBottom = geometryAtBottom
						followingLatest = geometryAtBottom
						if geometryAtBottom { followAfterLayout(scroll) }
					}
				}
				.overlay(alignment: .bottomTrailing) {
					if !followingLatest || model.transcript.hasNewer {
						Button("Jump to latest") { jumpToLatest(scroll) }
							.buttonStyle(.borderedProminent).padding(12)
							.accessibilityIdentifier("chat-jump-latest")
					}
				}
			}
		}
	}

	private func glanceSection(_ scroll: ScrollViewProxy) -> some View {
		VStack(alignment:.leading,spacing:12) {
			HStack { Text("Glance").font(.title3.weight(.semibold)); Text("\(model.glance.unread.count) new").font(.caption).foregroundStyle(.secondary) }
			.accessibilityIdentifier("glance-section")
			LazyVStack(alignment: .leading, spacing: 12) {
				ForEach(model.glance.unread) { card in
					AgentGlanceCardView(card:model.glance.rendered(card), expanded:Binding(get:{expandedGlance.contains(card.id)},set:{if $0{expandedGlance.insert(card.id)}else{expandedGlance.remove(card.id)}; followAfterLayout(scroll)}), onOpenSource:{Task{await model.glance.openSource(card)}}, onMarkReviewed:{Task{await model.glance.mark(through:card.glanceSeq)}})
				}
			}
			Button("Mark caught up") { Task { await model.glance.markCaughtUp() } }.buttonStyle(.bordered).accessibilityIdentifier("glance-mark-caught-up")
			if model.glance.hasMore { Button("Load more") { Task { await model.glance.loadMore() } }.buttonStyle(.bordered).accessibilityIdentifier("glance-load-more") }
			if let error=model.glance.error {
				Text(error).font(.caption).foregroundStyle(.red)
				Button("Retry") { Task { await model.glance.reload() } }
					.buttonStyle(.bordered).accessibilityIdentifier("glance-retry")
			}
		}.padding(.top,20)
	}

	private func followAfterLayout(_ scroll: ScrollViewProxy) {
		guard followingLatest else { return }
		let _ = scroll
		layoutRevision &+= 1
		guard followTask == nil else { return }
		followRunId &+= 1
		let runId = followRunId
		followTask = Task { @MainActor in
			var observedRevision = -1
			var stableFrames = 0
			while !Task.isCancelled, followingLatest, stableFrames < 2 {
				do { try await Task.sleep(for: .milliseconds(16)) }
				catch { break }
				guard !Task.isCancelled, followingLatest else { break }
				let revision = layoutRevision
				liveScrollTarget = nil
				await Task.yield()
				guard !Task.isCancelled, followingLatest else { break }
				liveScrollTarget = "live-end"
				if revision == observedRevision { stableFrames += 1 }
				else { observedRevision = revision; stableFrames = 0 }
			}
			if followRunId == runId { followTask = nil }
		}
	}

	private func cancelFollowTask() {
		followRunId &+= 1
		followTask?.cancel()
		followTask = nil
	}

	private func jumpToLatest(_ scroll: ScrollViewProxy) {
		Task { @MainActor in
			if model.transcript.hasNewer { await model.transcript.jumpToLatest() }
			model.transcript.atBottom = true
			followingLatest = true
			followAfterLayout(scroll)
		}
	}

	private func loadEarlier(_ scroll: ScrollViewProxy) {
		let anchor = model.transcript.transcriptRows.first?.scrollId
		Task { @MainActor in
			guard await model.transcript.loadOlder() else { return }
			await Task.yield()
			if let anchor { scroll.scrollTo(anchor, anchor: .top) }
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
