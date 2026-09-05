import Foundation
import Observation

/// What the person is looking at (09-desktop-shell T9.6).
///
/// `Selection` names a chat destination; `ShellState` holds the person's view
/// of it. The app never owns a session: `sessionId(in:)` resolves the
/// selection against the `Store` into the Node-owned ACP session the chat
/// surface must open. Views own nothing.
public enum Selection: Hashable, Sendable {
	case leader
	case mission(Ulid)
	case agent(Ulid)
}

/// The two surfaces that keep the navigator up under the pointer: the 6 pt
/// left-edge strip and the overlay panel itself.
///
/// They are tracked separately because AppKit does not order hover events
/// across sibling views: a fast move from the strip into the panel can deliver
/// the panel's enter before the strip's exit. With one flag the late exit
/// would schedule an unopposed hide and the panel would vanish under a
/// resting pointer; with a set, the strip's exit sees the panel still hovered
/// and schedules nothing.
public enum NavigatorHoverRegion: Hashable, Sendable {
	case edge
	case panel
}

/// The person's view: selection, overlays, focus and time zoom.
///
/// `Store` holds Node data; this holds the view. Selecting only changes
/// `selection` — the chat surface switches content via `sessionId(in:)` and
/// `chatVisible` moves only under the person's own toggle, never under
/// `select`.
///
/// Escape handling lives here (`dismissOverlay`) but is wired in the root
/// view, which lands in T9.7: `RootView` must add
/// `.onExitCommand { shell.dismissOverlay() }` (`dismissOverlay` is
/// `@discardableResult` so it fits the `() -> Void` slot with `_ =`).
@Observable @MainActor public final class ShellState {
	/// Time-zoom bounds and step: 0.25...4.0 in x1.25 steps.
	public static let minZoom = 0.25
	public static let maxZoom = 4.0
	public static let zoomStep = 1.25

	public var selection: Selection = .leader
	public var chatVisible = true
	public var navigatorVisible = false
	public var quickSwitcherVisible = false
	public var composerFocused = false
	/// Always within `minZoom...maxZoom`: `zoomIn`, `zoomOut` and `fit` are
	/// the only movers and each clamps. (No `didSet` clamp: assigning the
	/// property inside its own observer re-enters the `@Observable` setter
	/// and overflows the stack.)
	public var timeZoom: Double = 1.0
	/// Bumped by every `fit()`; the spine canvas (10) observes it.
	public private(set) var fitRequested = 0
	/// Bumped by every `jumpToNow()`; the spine canvas (10) observes it and
	/// jumps the view to the live edge.
	///
	/// The request lives here, not on the canvas's own `NowState`, because
	/// everything that asks for Now is outside the canvas: the mission bar's
	/// Now pill (09) and the debug driver. `NowState` still owns the two
	/// states the control renders; the shell owns the ask.
	public private(set) var nowRequested = 0
	/// How long the navigator stays up after the pointer leaves it. It
	/// covers the gap between the 6 pt edge strip and the panel, so crossing
	/// that gap does not close what the crossing just opened. One cancellable
	/// sleep per exit, never a polling timer.
	public var navigatorHideDelay: Duration = .milliseconds(320)
	@ObservationIgnored private var navigatorHide: Task<Void, Never>?
	/// Which of the navigator's hover surfaces the pointer is currently on.
	/// The hide only ever runs while this is empty.
	@ObservationIgnored private var navigatorHovered: Set<NavigatorHoverRegion> = []

	public init() {}

	/// Selects a destination. Never touches `chatVisible`: selecting opens
	/// that session's chat by content (via `sessionId(in:)`), and only the
	/// person's toggle hides the surface.
	///
	/// It does not touch the navigator either: the overlay closes itself
	/// when one of its own rows is used (`NavigatorOverlay.select`), and
	/// Escape still unstacks the overlay before the selection.
	public func select(_ selection: Selection) {
		self.selection = selection
	}

	/// Resolves the selection to the ACP session the chat must open:
	/// `.leader` to the leader's session, `.mission(id)` to that mission's
	/// lead session (the leader's session when the lead is the leader),
	/// `.agent(id)` to that agent's session. An unknown id returns nil and
	/// falls the selection back to `.leader`.
	public func sessionId(in store: Store) -> Ulid? {
		switch selection {
		case .leader:
			return store.leader?.sessionId
		case .mission(let id):
			guard let mission = store.missionsById[id] else {
				selection = .leader
				return nil
			}
			switch mission.lead {
			case .leader:
				return store.leader?.sessionId
			case .agent(let agentId):
				guard let agent = store.agentsById[agentId] else {
					selection = .leader
					return nil
				}
				return agent.sessionId
			}
		case .agent(let id):
			guard let agent = store.agentsById[id] else {
				selection = .leader
				return nil
			}
			return agent.sessionId
		}
	}

	/// `⌘L`.
	public func toggleNavigator() {
		if navigatorVisible {
			hideNavigator()
		} else {
			showNavigator()
		}
	}

	public func toggleQuickSwitcher() { quickSwitcherVisible.toggle() }
	public func showQuickSwitcher() { quickSwitcherVisible = true }

	/// Shows the overlay now and cancels any pending auto-hide. Both the
	/// left-edge hover strip and `⌘L` land here.
	public func showNavigator() {
		cancelNavigatorHide()
		navigatorVisible = true
	}

	/// Hides it now: Escape, a canvas click, or a row that was used.
	///
	/// It also forgets which surfaces the pointer was on. The panel leaves the
	/// view hierarchy under the pointer here, so its hover exit may never
	/// fire; a `.panel` left behind would keep the next hover-out from ever
	/// scheduling a hide.
	public func hideNavigator() {
		cancelNavigatorHide()
		navigatorHovered.removeAll()
		navigatorVisible = false
	}

	/// The pointer is over one of the navigator's hover surfaces: keep the
	/// overlay up and cancel any pending hide.
	public func navigatorPointerEntered(_ region: NavigatorHoverRegion) {
		navigatorHovered.insert(region)
		cancelNavigatorHide()
	}

	/// The pointer left one hover surface: hide the overlay after
	/// `navigatorHideDelay`, but only once it is on neither surface. Driven by
	/// hover exit, so nothing runs while the pointer sits still.
	///
	/// The task re-checks `navigatorHovered` before it clears the flag, so an
	/// enter that arrives out of order (see `NavigatorHoverRegion`) still wins
	/// even if it lands after this exit scheduled the hide.
	public func navigatorPointerExited(_ region: NavigatorHoverRegion) {
		navigatorHovered.remove(region)
		guard navigatorVisible, navigatorHovered.isEmpty else { return }
		navigatorHide?.cancel()
		navigatorHide = Task { [delay = navigatorHideDelay] in
			try? await Task.sleep(for: delay)
			guard !Task.isCancelled, navigatorHovered.isEmpty else { return }
			navigatorVisible = false
			navigatorHide = nil
		}
	}

	/// Dismisses the navigator for a click on empty canvas. Returns whether it
	/// consumed the click, leaving the canvas selection unchanged.
	@discardableResult
	public func canvasClicked() -> Bool {
		guard navigatorVisible else { return false }
		hideNavigator()
		return true
	}

	/// Escape: closes the navigator, else releases composer focus. Returns
	/// false when nothing was open.
	@discardableResult
	public func dismissOverlay() -> Bool {
		if navigatorVisible {
			hideNavigator()
			return true
		}
		if quickSwitcherVisible { quickSwitcherVisible = false; return true }
		if composerFocused {
			composerFocused = false
			return true
		}
		return false
	}

	/// Asks the canvas to jump the view back to the live edge. The mission
	/// bar's Now control and the debug driver's `now` both land here.
	public func jumpToNow() {
		nowRequested += 1
	}

	/// Resets zoom to 1.0 and tells the canvas to fit its time window.
	public func fit() {
		timeZoom = 1.0
		fitRequested += 1
	}

	public func zoomIn() {
		timeZoom = Self.clampZoom(timeZoom * Self.zoomStep)
	}

	public func zoomOut() {
		timeZoom = Self.clampZoom(timeZoom / Self.zoomStep)
	}

	/// Whole percent for the toolbar (`100` at 1.0), in mono tabular digits.
	public var zoomPercent: Int {
		Int((timeZoom * 100).rounded())
	}

	// MARK: - Internal

	/// Awaits a scheduled auto-hide, so the tests do not sleep on a wall
	/// clock. Returns at once when none is pending.
	func pendingNavigatorHide() async {
		await navigatorHide?.value
	}

	// MARK: - Private

	private func cancelNavigatorHide() {
		navigatorHide?.cancel()
		navigatorHide = nil
	}

	private static func clampZoom(_ value: Double) -> Double {
		min(max(value, minZoom), maxZoom)
	}
}
