import SwiftUI

/// The window content (09-desktop-shell T9.7, assembled T9.8–T9.10).
///
/// A `GeometryReader` over a `ZStack`: the spine canvas fills the window, and
/// the toolbar capsule (top centre, 12 down), navigator, chat and mission bar
/// float above it, each positioned from
/// `ShellLayout.compute(size:chatVisible:navigatorVisible:)`. The canvas keeps
/// the full window and is told which rects are covered (`ShellLayout.covered`)
/// so floating surfaces never steal its trackpad panning.
///
/// The viewport, Now state and checkpoint router live here (not inside the
/// canvas) so the mission bar's Now pill reads the same live-edge state the
/// canvas maintains. Escape runs `handleEscape` via `.onExitCommand` (the
/// T9.6 wiring); the six `⌘` shortcuts live in `NetaCommands`.
public struct RootView: View {
	private let store: Store
	private let shell: ShellState
	private let client: any NodeClient
	@State private var viewport = SpineViewportState(
		pxPerHour: SpineViewportState.defaultPxPerHour)
	@State private var now = NowState()
	@State private var router = CheckpointRouter()
	/// The chat panel's state, built once and owned here.
	///
	/// The body reads `store.missions` and `store.leader`, so every `state`
	/// notification re-evaluates it. A panel model built inside `body` was
	/// therefore replaced on the first live update, taking the transcript,
	/// the typed draft and the open inspector with it, and leaving the new
	/// transcript untailed. `@State` keeps the first one for the life of the
	/// window; the panel re-selects from the shell and the store instead of
	/// being rebuilt (`ChatPanelModel.sync`).
	@State private var chatModel: ChatPanelModel

	/// - Parameters:
	///   - store: The app's picture of the Node; views own nothing.
	///   - shell: The person's view: selection, overlays, focus, zoom.
	///   - client: The Node transport. The shell itself only reads; the chat
	///     (11) and canvas (10) prompt through it.
	@MainActor
	public init(store: Store, shell: ShellState, client: any NodeClient) {
		self.store = store
		self.shell = shell
		self.client = client
		_chatModel = State(initialValue: ChatPanelModel(
			client: client, store: store, shell: shell))
	}

	/// Escape, wherever focus sits: close the top overlay, else return the
	/// selection to the leader (10-desktop-spine T10.9 step 8).
	///
	/// `.onExitCommand` resolves along the focused responder chain, so with
	/// focus in the composer or the navigator — or nowhere — the canvas's own
	/// handler never runs. Both handlers are this same pair, so Escape means
	/// one thing whatever is focused.
	@MainActor
	public func handleEscape() {
		if !shell.dismissOverlay() {
			shell.select(.leader)
		}
	}

	public var body: some View {
		GeometryReader { proxy in
			let layout = ShellLayout.compute(
				size: proxy.size,
				chatVisible: shell.chatVisible,
				navigatorVisible: shell.navigatorVisible)
			ZStack {
				SpineCanvasView(store: store, shell: shell, viewport: viewport, now: now, router: router)
					.frame(width: layout.canvas.width, height: layout.canvas.height)
				VStack(spacing: 0) {
					ToolbarCapsule(
						model: ToolbarModel.make(store: store, shell: shell),
						shell: shell,
						onSelectWorkspace: {
							NavigatorOverlay.selectWorkspace($0, store: store, shell: shell)
						})
					Spacer(minLength: 0)
				}
				.padding(.top, Theme.Metric.barGap)
				.frame(width: layout.canvas.width, height: layout.canvas.height)
				HStack(spacing: 0) {
					NavigatorEdgeTrigger(shell: shell)
						.frame(height: layout.canvas.height)
					Spacer(minLength: 0)
				}
				.frame(width: layout.canvas.width, height: layout.canvas.height)
				if let navigator = layout.navigator {
					NavigatorOverlay(
						model: NavigatorModel.make(store: store, query: ""),
						shell: shell,
						onSelect: { shell.select($0) },
						onSelectWorkspace: {
							NavigatorOverlay.selectWorkspace($0, store: store, shell: shell)
						}
					)
					.frame(width: navigator.width, height: navigator.height)
					.position(x: navigator.midX, y: navigator.midY)
				}
				if let chat = layout.chat {
					ChatPanel(model: chatModel, router: router, windowWidth: proxy.size.width)
						.netaGlass(.panel, tint: Theme.Glass.chatFill)
						.frame(width: chat.width, height: chat.height)
						.position(x: chat.midX, y: chat.midY)
				}
				MissionBarView(
					// The current workspace's missions only: the Node lists
					// every open workspace in one snapshot, and two of them
					// interleaved in the bar draw two `#1`s.
					items: MissionBarModel.items(
						missions: store.currentMissions, leader: store.leader,
						nowLabel: now.label, nowLit: now.isLive),
					selection: shell.selection,
					onSelect: { shell.select($0) },
					// The ask goes through the shell, so the canvas is the
					// one place that knows how to reach the live edge and
					// anything outside it (the bar, the debug driver) can
					// ask for Now.
					onNow: { shell.jumpToNow() }
				)
				.frame(width: layout.missionBar.width, height: layout.missionBar.height)
				.position(x: layout.missionBar.midX, y: layout.missionBar.midY)
			}
			.frame(width: proxy.size.width, height: proxy.size.height)
			.background(ground(size: proxy.size))
			.onExitCommand { handleEscape() }
		}
	}

	// MARK: - Ground

	/// PAPER-SPINE Revision 3 item 7: the ground stays `#0E0F13` with one
	/// soft radial violet tint behind the leader and the chat, so the glass
	/// has something to refract. Nothing else is on the ground.
	///
	/// The board's `radial-gradient(600px 400px at 78% 52%,
	/// rgba(153,133,245,0.07), transparent 70%)` reaches clear at 70% of the
	/// 600 x 400 ending-shape radii, i.e. 420 x 280. SwiftUI's radius
	/// fractions are of the frame, where the default 0.5 already touches the
	/// frame edge, so a 1200 x 800 frame wants 0.35 — 0.5 would put clear at
	/// 600 x 400 and 0.7 at 840 x 560, twice the design, still tinted where
	/// the frame is clipped and so leaving a straight seam across the ground.
	private func ground(size: CGSize) -> some View {
		Theme.ground.overlay(alignment: .topLeading) {
			EllipticalGradient(
				colors: [
					Theme.violet.opacity(0.07),
					Theme.violet.opacity(0),
				],
				center: .center,
				startRadiusFraction: 0,
				endRadiusFraction: 0.35)
				.frame(width: 1200, height: 800)
				.offset(x: size.width * 0.78 - 600, y: size.height * 0.52 - 400)
				.allowsHitTesting(false)
		}
		.clipped()
	}
}
