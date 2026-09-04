import CoreGraphics
import Foundation
import SwiftUI

/// One recomputation of the spine canvas: the materialised window, the axis
/// checkpoints and the per-mission emphasis the card views fade through.
public struct SpineCanvasFrame: Sendable, Equatable {
	public var window: VisibleWindow
	public var points: [Checkpoint]
	public var emphasis: [MissionId: Double]

	public init(
		window: VisibleWindow, points: [Checkpoint],
		emphasis: [MissionId: Double]
	) {
		self.window = window
		self.points = points
		self.emphasis = emphasis
	}
}

/// The caching assembler behind `SpineCanvasView` (10-desktop-spine T10.10).
///
/// `SpineIndex` is rebuilt only when the mission set, the checkpoint set or
/// the spacing inputs change. `SpineVirtualiser.window` is recomputed only
/// when `scrollX`, the viewport, the store revision (missions, agents,
/// events) or the expansion set changes. Every recomputation applies a
/// staged `NowState` jump first, then calls `NowState.update`.
@MainActor @Observable
public final class SpineCanvasPipeline {
	private struct WindowKey: Equatable {
		var missions: [Mission]
		var events: [Event]
		var agents: [MissionId: [Agent]]
		var pxPerHour: Double
		var maxPitch: CGFloat
		var scrollX: CGFloat
		var viewport: CGRect
		var expanded: Set<MissionId>
	}

	private var cachedMissions: [Mission]?
	private var cachedEvents: [Event]?
	private var cachedPxPerHour: Double?
	private var cachedMaxPitch: CGFloat?
	private var cachedIndex = SpineIndex(
		missions: [], pxPerHour: SpineViewportState.defaultPxPerHour,
		maxPitch: SpineViewportState.defaultMaxPitch)
	/// How many times the index was rebuilt; tests assert the caching rule.
	public private(set) var indexBuilds = 0
	private var cachedKey: WindowKey?
	private var cachedFrame: SpineCanvasFrame?
	/// How many times the window was recomputed; tests assert the rule.
	public private(set) var windowComputes = 0
	/// The usable width of the last laid-out viewport. `nil` until the
	/// canvas first has a size, which is what makes the first layout jump
	/// to Now.
	private var lastUsableWidth: CGFloat?
	/// The content width of the last laid-out index. A live view re-anchors
	/// when this changes, so a mission arriving does not slide the leader
	/// out from under Now.
	private var lastContentWidth: CGFloat?
	/// The `ShellState.timeZoom` the canvas has already applied.
	///
	/// `⌘=` / `⌘-` and the toolbar's zoom buttons only move `timeZoom`; the
	/// canvas turns each move into the matching change of spacing.
	/// `ShellState.fit()` moves `timeZoom` to 1.0 *and* bumps
	/// `fitRequested`, so both observers fire for one Fit and whichever
	/// lands second wins: fit-first makes the zoom handler a no-op (the
	/// stamp already matches), and zoom-first lets one stray step through
	/// which the fit then overwrites, spacing and scroll alike. Fit is
	/// authoritative either way, so the order the two land in does not
	/// change the end state.
	@ObservationIgnored public var appliedZoom = 1.0

	public init() {}

	/// The time-ordered index, rebuilt only when its inputs differ.
	public func index(
		for missions: [Mission], events: [Event],
		pxPerHour: Double, maxPitch: CGFloat
	) -> SpineIndex {
		if let cachedMissions, let cachedEvents,
			let cachedPxPerHour, let cachedMaxPitch,
			cachedMissions == missions, cachedEvents == events,
			cachedPxPerHour == pxPerHour, cachedMaxPitch == maxPitch
		{
			return cachedIndex
		}
		let next = SpineIndex(
			missions: missions, events: events,
			pxPerHour: pxPerHour, maxPitch: maxPitch)
		cachedMissions = missions
		cachedEvents = events
		cachedPxPerHour = pxPerHour
		cachedMaxPitch = maxPitch
		cachedIndex = next
		indexBuilds += 1
		return next
	}

	/// Resolves the frame for one layout pass: jumps to Now on the first
	/// layout, recomputes the window and checkpoints on a key miss, and
	/// refreshes `NowState` against the rendered (scroll-shifted) leader
	/// rect. An explicit ask for Now does not pass through here — it is
	/// `ShellState.jumpToNow()` and `applyShellNow`, the one path.
	///
	/// The first layout — and any later change to the usable width or the
	/// content width while the view is live, such as hiding the chat or a
	/// new mission arriving — right-aligns the live edge, so the leader card
	/// stays at Now just left of the chat instead of drifting behind it or
	/// sitting at content x 0 behind the navigator.
	public func frame(
		store: Store, viewportState: SpineViewportState, nowState: NowState,
		viewport: CGRect, date: Date, trailingInset: CGFloat = 0
	) -> SpineCanvasFrame {
		// The current workspace's work only. The Node lists every open
		// workspace in one snapshot, and two of them interleaved on the
		// spine draw two sequences through each other.
		let missions = store.currentMissions
		let events = store.currentEvents
		let index = index(
			for: missions, events: events,
			pxPerHour: viewportState.pxPerHour,
			maxPitch: viewportState.maxPitch)
		if viewport.width > 0 {
			let usable = max(0, viewport.width - trailingInset)
			let content = index.contentWidth
			let moved = lastUsableWidth != usable
				|| lastContentWidth != content
			if lastUsableWidth == nil || (moved && nowState.isLive) {
				viewportState.jump(to: SpinePlacement.liveScrollX(
					index: index, viewport: viewport,
					trailingInset: trailingInset))
			} else if moved {
				// Scrolled back in time and the band moved under it —
				// widening the window or hiding the chat lowers the live
				// edge below the current `scrollX`. Nothing else re-clamps
				// outside `pan` and `zoom`, so the leader would be drawn
				// left of the usable right edge with dead space beside it
				// until the next gesture.
				viewportState.jump(to: SpinePlacement.clampScrollX(
					viewportState.scrollX, index: index, viewport: viewport,
					trailingInset: trailingInset))
			}
			lastUsableWidth = usable
			lastContentWidth = content
		}
		let scrollX = viewportState.scrollX
		let expanded = viewportState.expanded
		let agentsByMission = store.currentAgentsByMission
		let key = WindowKey(
			missions: missions, events: events, agents: agentsByMission,
			pxPerHour: viewportState.pxPerHour,
			maxPitch: viewportState.maxPitch,
			scrollX: scrollX, viewport: viewport, expanded: expanded)
		if let cachedKey, let cachedFrame,
			cachedKey == key
		{
			// The key carries no date, so a view sitting still behind the
			// live edge would keep the age it had when the pan stopped.
			// Now is cheap to recompute; the window is not.
			nowState.update(
				index: index, scrollX: scrollX, viewport: viewport,
				leader: cachedFrame.window.leader.offsetBy(
					dx: 0, dy: -viewportState.scrollY),
				now: date, trailingInset: trailingInset)
			return cachedFrame
		}
		let window = SpineVirtualiser.window(
			index: index, agents: agentsByMission, scrollX: scrollX,
			viewport: viewport,
			now: date.timeIntervalSince1970 * 1000,
			expanded: expanded)
		let placed = Checkpoints.place(
			index: index, events: events, range: window.range,
			scrollX: scrollX, viewport: viewport, now: date)
		var emphasis: [MissionId: Double] = [:]
		emphasis.reserveCapacity(missions.count)
		for mission in missions {
			emphasis[mission.id] = CanvasStyle.emphasis(
				mission: mission, agents: agentsByMission[mission.id] ?? [])
		}
		nowState.update(
			index: index, scrollX: scrollX, viewport: viewport,
			leader: window.leader.offsetBy(
				dx: 0, dy: -viewportState.scrollY),
			now: date, trailingInset: trailingInset)
		let frame = SpineCanvasFrame(
			window: window, points: placed, emphasis: emphasis)
		cachedKey = key
		cachedFrame = frame
		windowComputes += 1
		return frame
	}

	/// The vertical extent the trackpad pan clamps against: the union of the
	/// viewport, the leader card, every lead card and every agent row, at
	/// least the viewport height. `SpineViewportState.pan` clamps `scrollY`
	/// to `0...max(0, contentHeight - viewport.height)`.
	public static func contentHeight(
		window: VisibleWindow, viewport: CGRect
	) -> CGFloat {
		var rect = viewport.union(window.leader)
		for column in window.columns {
			rect = rect.union(column.card)
			for row in column.rows {
				rect = rect.union(row)
			}
		}
		return max(viewport.height, rect.height)
	}

	/// The canvas's usable right edge, as an inset from `size.width`: the
	/// chat's leading edge less `SpinePlacement.chatGap` while the chat is
	/// visible, else the window inset. The leader card at Now sits with its
	/// far edge exactly here (PAPER-SPINE artboard 1 item 8).
	public static func trailingInset(
		size: CGSize, shell: ShellState
	) -> CGFloat {
		let layout = ShellLayout.compute(
			size: size, chatVisible: shell.chatVisible,
			navigatorVisible: shell.navigatorVisible)
		guard let chat = layout.chat else { return Theme.Metric.edgeInset }
		return max(0, size.width - chat.minX) + SpinePlacement.chatGap
	}

	/// The rects the trackpad capture must leave alone so the chat, the
	/// navigator and the mission bar keep their own scrolling:
	/// `ShellLayout.covered`, in window coordinates.
	///
	/// Rects, not edge insets. The navigator only occupies the band between
	/// the surface top and the mission bar, so carving its full-height
	/// leading column out of the capture stopped the canvas above and below
	/// it panning too, and MANIFESTO.md "Canvas interaction and visual
	/// grammar" gives two-finger movement to the canvas. The panel itself
	/// still keeps its own scrolling, because the capture monitor swallows
	/// the event before it reaches the view under the cursor and the
	/// navigator is a scrolling jump list over every mission.
	public static func interactionRects(
		size: CGSize, shell: ShellState
	) -> [CGRect] {
		ShellLayout.compute(
			size: size, chatVisible: shell.chatVisible,
			navigatorVisible: shell.navigatorVisible)
			.covered
	}
}

/// The one view composing the spine (10-desktop-spine T10.10), handed to the
/// 09 shell in place of `CanvasPlaceholder`.
///
/// A `GeometryReader` over a `ZStack`, PAPER-SPINE artboard 1 bottom to top:
/// `SpineBackdrop`, the materialised `MissionColumn` views placed with
/// `.position`, `CheckpointLayer`, the leader card, then
/// `OffScreenLeaderMarker`. There is no empty state of its own: with no
/// missions the spine is the leader card at Now, just left of the chat.
/// Vertical pan renders as an offset over layout
/// coordinates, so connectors stay attached to their cards. Clicks call
/// `shell.select(_:)`; a click on the backdrop calls `shell.canvasClicked()`,
/// which dismisses the navigator; `Escape` dismisses the top overlay, else
/// returns selection to `.leader`. The backdrop's dismiss target is a plain
/// `Button` under every node, not a tap gesture: a tap gesture on the
/// backdrop never received the click (see `body`).
///
/// The canvas observes `shell.selection` and pans to it, so the mission bar
/// and the navigator both "pan the spine to that mission" (MANIFESTO.md "The
/// mission inbox") by moving the selection alone.
///
/// Zoom and Fit have one path each. `⌘=` / `⌘-` / `⌘0` reaching the canvas
/// call `shell.zoomIn()` / `zoomOut()` / `fit()`, exactly what the menu-bar
/// twins in `NetaCommands` and the toolbar's `−  100%  +` call; the canvas
/// then observes `shell.timeZoom` and `shell.fitRequested` and drives
/// `SpineViewportState`. So the menu consuming the key equivalent changes
/// nothing, and the toolbar readout cannot disagree with the spacing.
public struct SpineCanvasView: View {
	private let store: Store
	private let shell: ShellState
	@State private var viewport: SpineViewportState
	@State private var now: NowState
	@State private var router: CheckpointRouter
	@State private var pipeline = SpineCanvasPipeline()
	/// Last known cursor x for cursor-anchored pinch zoom (T10.9); the
	/// viewport centre while the cursor is outside the canvas.
	@State private var hoverX: CGFloat?
	/// The magnification already applied in the pinch now under way.
	/// `MagnifyGesture` reports magnification cumulatively from the gesture's
	/// start (1.0 = unchanged), so each callback must contribute only the
	/// ratio since the last one; multiplying the current zoom by the whole
	/// cumulative value compounded one pinch into many.
	@State private var pinchMagnification: CGFloat = 1

	public init(
		store: Store, shell: ShellState, viewport: SpineViewportState,
		now: NowState, router: CheckpointRouter
	) {
		self.store = store
		self.shell = shell
		_viewport = State(initialValue: viewport)
		_now = State(initialValue: now)
		_router = State(initialValue: router)
	}

	/// The shell's one-line assembly: the default spacing at the default
	/// window size (1600 × 1000 per 09), owned here via `@State` so the
	/// first instance sticks across parent re-renders.
	public init(store: Store, shell: ShellState) {
		self.init(
			store: store, shell: shell,
			viewport: SpineViewportState(
				pxPerHour: SpineViewportState.defaultPxPerHour),
			now: NowState(),
			router: CheckpointRouter())
	}

	/// Resolves the frame for `size` at `date` through the caching pipeline,
	/// right-aligning the live edge on the shell's usable right edge. The
	/// body calls this every layout pass; tests call it directly.
	@MainActor
	public func resolve(size: CGSize, date: Date) -> SpineCanvasFrame {
		pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: CGRect(origin: .zero, size: size), date: date,
			trailingInset: SpineCanvasPipeline.trailingInset(
				size: size, shell: shell))
	}

	/// Escape: closes the top overlay, else returns selection to `.leader`.
	@MainActor
	public func handleEscape() {
		if !shell.dismissOverlay() {
			shell.select(.leader)
		}
	}

	/// A click on the canvas outside every node: dismisses the navigator
	/// (`ShellState.canvasClicked`). It hangs off the backdrop, below the
	/// node buttons, so a click on a card still selects the card and only
	/// empty canvas closes the overlay. MANIFESTO.md "Desktop information
	/// architecture": the navigator "closes when dismissed".
	@MainActor
	public func handleBackgroundTap() {
		shell.canvasClicked()
	}

	/// The shell's time zoom moved (`⌘=`, `⌘-`, the toolbar's `−`/`+`): the
	/// spacing follows by exactly the ratio the shell moved, about the
	/// viewport centre, holding the live edge when the view is live.
	/// `ShellState.zoomIn`/`zoomOut` only write `timeZoom`, so this is the
	/// whole canvas end of that wire.
	///
	/// The ratio, not a fixed `ZoomStep`: `timeZoom` clamps at
	/// `ShellState.minZoom...maxZoom`, so the move that saturates the clamp
	/// is a partial step, and a full step there would leave the toolbar
	/// readout claiming a spacing the canvas does not have.
	///
	/// Zoom is about the centre, so a live view would otherwise drift off
	/// Now — zooming out leaves the leader card short of the usable right
	/// edge, which unlights the control and moves the anchor the person was
	/// reading from. `SpinePlacement.clampScrollX` only catches the other
	/// direction, so the live case is re-anchored explicitly.
	@MainActor
	public func applyShellZoom(size: CGSize) {
		let target = shell.timeZoom
		let previous = pipeline.appliedZoom
		pipeline.appliedZoom = target
		guard target != previous, previous > 0 else { return }
		let visible = CGRect(origin: .zero, size: size)
		let trailing = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		let wasLive = now.isLive
		viewport.zoom(
			factor: target / previous,
			atCursorX: visible.midX - visible.minX,
			index: index(), viewport: visible, trailingInset: trailing)
		guard wasLive else { return }
		viewport.jump(to: SpinePlacement.liveScrollX(
			index: index(), viewport: visible, trailingInset: trailing))
	}

	/// A pinch on the trackpad: the spacing scales about the cursor, and the
	/// shell's `timeZoom` moves by exactly the same ratio so the toolbar's
	/// `−  100%  +` readout cannot disagree with the spacing it reports.
	///
	/// The applied stamp is written before `timeZoom`, so the `timeZoom`
	/// observer that fires from this write sees the zoom it already has and
	/// does nothing: the pinch is applied once, about the cursor, not twice.
	@MainActor
	public func applyPinch(factor: Double, atX x: CGFloat?, size: CGSize) {
		guard factor.isFinite, factor > 0 else { return }
		let visible = CGRect(origin: .zero, size: size)
		let trailing = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		let target = min(
			max(shell.timeZoom * factor, ShellState.minZoom), ShellState.maxZoom)
		let previous = pipeline.appliedZoom
		guard previous > 0, target != previous else { return }
		viewport.zoom(
			factor: target / previous, atCursorX: x ?? visible.midX,
			index: index(), viewport: visible, trailingInset: trailing)
		pipeline.appliedZoom = target
		shell.timeZoom = target
	}

	/// The mission bar's Now control, or the debug driver's `now`: the shell
	/// bumps `nowRequested` and this is what the bump does — jump the view
	/// back to the live edge, where the leader card sits at Now.
	@MainActor
	public func applyShellNow(size: CGSize) {
		let visible = CGRect(origin: .zero, size: size)
		viewport.jump(to: SpinePlacement.liveScrollX(
			index: index(), viewport: visible,
			trailingInset: SpineCanvasPipeline.trailingInset(
				size: size, shell: shell)))
	}

	/// `⌘0` / the toolbar's Fit: `ShellState.fit()` resets `timeZoom` and
	/// bumps `fitRequested`, and this is what the bump does. It stamps the
	/// zoom the shell just reset so `applyShellZoom` cannot also fire a step
	/// for the same Fit, whichever of the two observers lands first.
	@MainActor
	public func applyShellFit(size: CGSize) {
		pipeline.appliedZoom = shell.timeZoom
		viewport.fit(
			index: index(),
			viewport: CGRect(origin: .zero, size: size),
			trailingInset: SpineCanvasPipeline.trailingInset(
				size: size, shell: shell))
	}

	/// The selection moved: pan the spine to it. MANIFESTO.md "The mission
	/// inbox": "Clicking a mission in the bar pans the spine to that mission
	/// and opens its lead's conversation"; the navigator is the same wire
	/// (09-desktop-shell T9.9 step 3 — "the shell opens that lead's
	/// conversation and 10 pans the spine to it").
	///
	/// `.leader` is Now, so it returns to the live edge. A mission or one of
	/// its agents brings that mission's column into the usable band, and a
	/// column already in view moves nothing — a click on a card on the
	/// canvas must not shuffle the view under the hand that clicked it.
	@MainActor
	public func revealSelection(size: CGSize) {
		let visible = CGRect(origin: .zero, size: size)
		let trailing = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		let missionId: MissionId?
		switch shell.selection {
		case .leader:
			missionId = nil
		case .mission(let id):
			missionId = id
		case .agent(let id):
			missionId = store.agentsById[id]?.missionId
		}
		guard let missionId else {
			viewport.jump(to: SpinePlacement.liveScrollX(
				index: index(), viewport: visible, trailingInset: trailing))
			return
		}
		guard let target = SpinePlacement.revealScrollX(
			mission: missionId, index: index(), scrollX: viewport.scrollX,
			viewport: visible, trailingInset: trailing)
		else { return }
		viewport.jump(to: target)
	}

	/// The cached index at the current spacing, over the current
	/// workspace's missions and events alone.
	@MainActor
	private func index() -> SpineIndex {
		pipeline.index(
			for: store.currentMissions, events: store.currentEvents,
			pxPerHour: viewport.pxPerHour, maxPitch: viewport.maxPitch)
	}

	public var body: some View {
		GeometryReader { proxy in
			let size = proxy.size
			let visible = CGRect(origin: .zero, size: size)
			let date = Date()
			let canvas = resolve(size: size, date: date)
			let excluded = SpineCanvasPipeline.interactionRects(
				size: size, shell: shell)
			let trailing = SpineCanvasPipeline.trailingInset(
				size: size, shell: shell)
			let agentsByMission = store.currentAgentsByMission
			ZStack {
				// The dismiss target is the whole window and is not part of
				// the vertically panned group: the backdrop is framed at
				// exactly `size.height`, so after a pan a band `scrollY`
				// tall along the bottom would have no target under it. It
				// sits below every node, so a click on a card still selects
				// the card.
				//
				// A `Button`, not a tap gesture on `Color.clear`: the
				// gesture never fired. Measured on the running app with the
				// navigator open at 1600 x 984 — a click at (500, 534) on
				// empty canvas left `navigator=true`, while the same
				// synthesized click on the toolbar's Fit button bumped
				// `fitRequested`, so the click was being delivered and the
				// gesture was what did not answer it. With this button the
				// same click reports `navigator=false`.
				Button(action: handleBackgroundTap) {
					Color.clear
						.frame(width: size.width, height: size.height)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				// It is a click target and nothing else: never a stop on the
				// keyboard-access ring, never a control VoiceOver announces.
				.focusable(false)
				.accessibilityHidden(true)
				ZStack {
					SpineBackdrop(
						window: canvas.window,
						emphasisFor: { canvas.emphasis[$0] ?? 1 })
						.frame(width: size.width, height: size.height)
						.allowsHitTesting(false)
					ForEach(canvas.window.columns) { column in
						columnGroup(
							column, canvas: canvas, agentsByMission: agentsByMission,
							date: date)
					}
					CheckpointLayer(
						points: canvas.points,
						spineY: canvas.window.spineY, router: router)
						.frame(width: size.width, height: size.height)
					leaderCard(canvas: canvas)
				}
				.offset(y: -viewport.scrollY)
				OffScreenLeaderMarker(
					// The same usable right edge the live edge and the
					// leader card use, not the chat's leading edge: the
					// marker lands where the leader would be at Now.
					state: now, trailingInset: trailing,
					action: { shell.jumpToNow() })
			}
			.frame(width: size.width, height: size.height)
			.background(
				TrackpadPanCapture(
					isEnabled: true, excludedRects: excluded,
					onScroll: { delta in
						viewport.pan(
							by: delta,
							index: index(),
							viewport: visible,
							contentHeight: SpineCanvasPipeline.contentHeight(
								window: canvas.window, viewport: visible),
							trailingInset: trailing)
					}))
			.onContinuousHover { phase in
				switch phase {
				case .active(let location): hoverX = location.x
				case .ended: hoverX = nil
				}
			}
			.gesture(
				MagnifyGesture()
					.onChanged { value in
						let previous = pinchMagnification
						let current = max(0.01, value.magnification)
						pinchMagnification = current
						guard previous > 0 else { return }
						applyPinch(
							factor: Double(current / previous),
							atX: hoverX, size: size)
					}
					.onEnded { _ in pinchMagnification = 1 })
			.onKeyPress(keys: ["="]) { press in
				guard press.modifiers == .command else { return .ignored }
				shell.zoomIn()
				return .handled
			}
			.onKeyPress(keys: ["-"]) { press in
				guard press.modifiers == .command else { return .ignored }
				shell.zoomOut()
				return .handled
			}
			.onKeyPress(keys: ["0"]) { press in
				guard press.modifiers == .command else { return .ignored }
				shell.fit()
				return .handled
			}
			.onExitCommand { handleEscape() }
			.onChange(of: shell.selection) { _, _ in
				revealSelection(size: size)
			}
			.onChange(of: shell.timeZoom) { _, _ in
				applyShellZoom(size: size)
			}
			.onChange(of: shell.fitRequested) { _, _ in
				applyShellFit(size: size)
			}
			.onChange(of: shell.nowRequested) { _, _ in
				applyShellNow(size: size)
			}
		}
	}

	// MARK: - Columns

	private var leaderName: String {
		MissionBarModel.leaderDisplayName(store.leader)
	}

	/// One materialised column: the lead card at its card centre plus one
	/// view per stack entry at its row rect.
	@ViewBuilder @MainActor
	private func columnGroup(
		_ column: MissionColumn, canvas: SpineCanvasFrame,
		agentsByMission: [MissionId: [Agent]], date: Date
	) -> some View {
		Group {
			if let mission = store.missionsById[column.id] {
				let lead: Agent? = {
					if case .agent(let id) = mission.lead {
						return store.agentsById[id]
					}
					return nil
				}()
				Button {
					shell.select(.mission(column.id))
				} label: {
					LeadCardView(
						model: LeadCardModel(
							mission: mission, lead: lead,
							leaderName: leaderName, now: date),
						emphasis: canvas.emphasis[column.id] ?? 1,
						selected: shell.selection == .mission(column.id),
						collapsed: column.collapsed)
				}
				.buttonStyle(.plain)
				// Framed to the placement rect, then centred on it:
				// `.position` centres a view on a point, so a view left to
				// its intrinsic size paints outside the rect the layout
				// reserved for it and lands on its neighbours.
				.frame(width: column.card.width, height: column.card.height)
				.position(x: column.card.midX, y: column.card.midY)
				ForEach(column.stack.items.indices, id: \.self) { i in
					if i < column.rows.count {
						rowView(
							column.stack.items[i], at: column.rows[i],
							column: column, canvas: canvas)
					}
				}
			}
		}
	}

	@ViewBuilder @MainActor
	private func rowView(
		_ item: StackItem, at rect: CGRect, column: MissionColumn,
		canvas: SpineCanvasFrame
	) -> some View {
		switch item.content {
		case .agent(let id):
			if let agent = store.agentsById[id] {
				Button {
					shell.select(.agent(id))
				} label: {
					AgentRowView(
						model: AgentRowModel(agent: agent),
						emphasis: canvas.emphasis[column.id] ?? 1,
						selected: shell.selection == .agent(id))
				}
				.buttonStyle(.plain)
				.frame(width: rect.width, height: rect.height)
				.position(x: rect.midX, y: rect.midY)
			}
		case .moreCompleted(let count):
			CompletedChip(
				count: count,
				expanded: viewport.expanded.contains(column.id),
				action: { viewport.toggleExpanded(column.id) })
				.frame(width: rect.width, height: rect.height)
				.position(x: rect.midX, y: rect.midY)
		}
	}

	@ViewBuilder @MainActor
	private func leaderCard(canvas: SpineCanvasFrame) -> some View {
		if let leader = store.leader {
			Button {
				shell.select(.leader)
			} label: {
				LeaderCardView(
					name: leaderName, mode: leader.mode,
					selected: shell.selection == .leader)
			}
			.buttonStyle(.plain)
			// The leader card is placed by `SpinePlacement.leaderRect` and
			// its far edge is the live edge: unframed, a card wider than
			// `leadCardWidth` overhung the rect and slid under the chat
			// glass, and every "the leader sits just left of the chat" test
			// passed because it asserted the rect, not the view.
			.frame(
				width: canvas.window.leader.width,
				height: canvas.window.leader.height)
			.position(
				x: canvas.window.leader.midX, y: canvas.window.leader.midY)
		}
	}
}
