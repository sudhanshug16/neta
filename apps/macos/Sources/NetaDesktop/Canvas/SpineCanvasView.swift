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

	/// Resolves the frame for one layout pass: applies a staged jump,
	/// recomputes the window and checkpoints on a key miss, and refreshes
	/// `NowState` against the rendered (scroll-shifted) leader rect.
	public func frame(
		store: Store, viewportState: SpineViewportState, nowState: NowState,
		viewport: CGRect, date: Date
	) -> SpineCanvasFrame {
		let missions = store.missions
		let events = store.events
		let index = index(
			for: missions, events: events,
			pxPerHour: viewportState.pxPerHour,
			maxPitch: viewportState.maxPitch)
		if let jumped = nowState.consumeJump() {
			viewportState.jump(to: jumped)
		}
		let scrollX = viewportState.scrollX
		let expanded = viewportState.expanded
		let agentsByMission = Dictionary(
			grouping: store.agentsById.values, by: \.missionId)
		let key = WindowKey(
			missions: missions, events: events, agents: agentsByMission,
			pxPerHour: viewportState.pxPerHour,
			maxPitch: viewportState.maxPitch,
			scrollX: scrollX, viewport: viewport, expanded: expanded)
		if let cachedKey, let cachedFrame,
			cachedKey == key
		{
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
			now: date)
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

	/// The shell insets the trackpad capture must honour so the chat and the
	/// mission bar keep their own scrolling: the mission-bar strip along the
	/// bottom and the chat band along the trailing edge, in points.
	public static func interactionInsets(
		size: CGSize, shell: ShellState
	) -> EdgeInsets {
		let layout = ShellLayout.compute(
			size: size, chatVisible: shell.chatVisible,
			navigatorVisible: shell.navigatorVisible)
		let bottom = max(0, size.height - layout.missionBar.minY)
		let trailing = layout.chat.map { max(0, size.width - $0.minX) } ?? 0
		return EdgeInsets(top: 0, leading: 0, bottom: bottom, trailing: trailing)
	}
}

/// The one view composing the spine (10-desktop-spine T10.10), handed to the
/// 09 shell in place of `CanvasPlaceholder`.
///
/// A `GeometryReader` over a `ZStack`, PAPER-SPINE artboard 1 bottom to top:
/// `SpineBackdrop`, the materialised `MissionColumn` views placed with
/// `.position`, `CheckpointLayer`, the leader card, then
/// `OffScreenLeaderMarker`. Vertical pan renders as an offset over layout
/// coordinates, so connectors stay attached to their cards. Clicks call
/// `shell.select(_:)`; `Escape` dismisses the top overlay, else returns
/// selection to `.leader`. `⌘=` / `⌘-` zoom about the viewport centre, `⌘0`
/// fits every open mission; the menu-bar twins in `NetaCommands` land through
/// `shell.fitRequested`, which the canvas observes, so Fit is single-shot
/// either way.
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

	/// Resolves the frame for `size` at `date` through the caching pipeline.
	/// The body calls this every layout pass; tests call it directly.
	@MainActor
	public func resolve(size: CGSize, date: Date) -> SpineCanvasFrame {
		pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: CGRect(origin: .zero, size: size), date: date)
	}

	/// Escape: closes the top overlay, else returns selection to `.leader`.
	@MainActor
	public func handleEscape() {
		if !shell.dismissOverlay() {
			shell.select(.leader)
		}
	}

	public var body: some View {
		GeometryReader { proxy in
			let size = proxy.size
			let visible = CGRect(origin: .zero, size: size)
			let date = Date()
			let canvas = resolve(size: size, date: date)
			let insets = SpineCanvasPipeline.interactionInsets(
				size: size, shell: shell)
			let agentsByMission = Dictionary(
				grouping: store.agentsById.values, by: \.missionId)
			ZStack {
				ZStack {
					SpineBackdrop(
						window: canvas.window,
						emphasisFor: { canvas.emphasis[$0] ?? 1 })
						.frame(width: size.width, height: size.height)
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
					state: now, trailingInset: insets.trailing,
					action: {
						now.jumpToNow(
							index: pipeline.index(
								for: store.missions, events: store.events,
								pxPerHour: viewport.pxPerHour,
								maxPitch: viewport.maxPitch),
							viewport: visible)
					})
				if store.missions.isEmpty {
					emptyState
						.frame(width: size.width, height: size.height)
						.allowsHitTesting(false)
				}
			}
			.frame(width: size.width, height: size.height)
			.background(
				TrackpadPanCapture(
					isEnabled: true, interactionInsets: insets,
					onScroll: { delta in
						viewport.pan(
							by: delta,
							index: pipeline.index(
								for: store.missions, events: store.events,
								pxPerHour: viewport.pxPerHour,
								maxPitch: viewport.maxPitch),
							viewport: visible,
							contentHeight: SpineCanvasPipeline.contentHeight(
								window: canvas.window, viewport: visible))
					}))
			.onContinuousHover { phase in
				switch phase {
				case .active(let location): hoverX = location.x
				case .ended: hoverX = nil
				}
			}
			.gesture(MagnifyGesture().onChanged { value in
				viewport.zoom(
					factor: max(0.1, 1 + value.magnification),
					atCursorX: hoverX ?? size.width / 2,
					index: pipeline.index(
						for: store.missions, events: store.events,
						pxPerHour: viewport.pxPerHour,
						maxPitch: viewport.maxPitch))
			})
			.onKeyPress(keys: ["="]) { press in
				guard press.modifiers == .command else { return .ignored }
				viewport.zoom(
					.zoomIn,
					index: pipeline.index(
						for: store.missions, events: store.events,
						pxPerHour: viewport.pxPerHour,
						maxPitch: viewport.maxPitch),
					viewport: visible)
				return .handled
			}
			.onKeyPress(keys: ["-"]) { press in
				guard press.modifiers == .command else { return .ignored }
				viewport.zoom(
					.zoomOut,
					index: pipeline.index(
						for: store.missions, events: store.events,
						pxPerHour: viewport.pxPerHour,
						maxPitch: viewport.maxPitch),
					viewport: visible)
				return .handled
			}
			.onKeyPress(keys: ["0"]) { press in
				guard press.modifiers == .command else { return .ignored }
				viewport.fit(
					index: pipeline.index(
						for: store.missions, events: store.events,
						pxPerHour: viewport.pxPerHour,
						maxPitch: viewport.maxPitch),
					viewport: visible)
				return .handled
			}
			.onExitCommand { handleEscape() }
			.onChange(of: shell.fitRequested) { _, _ in
				viewport.fit(
					index: pipeline.index(
						for: store.missions, events: store.events,
						pxPerHour: viewport.pxPerHour,
						maxPitch: viewport.maxPitch),
					viewport: visible)
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
						selected: shell.selection == .mission(column.id))
				}
				.buttonStyle(.plain)
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
				.position(x: rect.midX, y: rect.midY)
			}
		case .moreCompleted(let count):
			CompletedChip(
				count: count,
				expanded: viewport.expanded.contains(column.id),
				action: { viewport.toggleExpanded(column.id) })
				.position(x: rect.midX, y: rect.midY)
		}
	}

	/// Centred hint when the workspace holds no missions yet: the axis
	/// and leader card alone read as a broken canvas, so the empty state
	/// says so. Hit testing stays off so trackpad panning still works.
	private var emptyState: some View {
		VStack(spacing: 6) {
			Text("No missions yet")
				.font(Theme.text(13, .semibold))
				.foregroundStyle(Theme.textPrimary)
			Text("Missions appear here as the leader starts them.")
				.font(Theme.text(12, .regular))
				.foregroundStyle(Theme.textSecondary)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
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
			.position(
				x: canvas.window.leader.midX, y: canvas.window.leader.midY)
		}
	}
}
