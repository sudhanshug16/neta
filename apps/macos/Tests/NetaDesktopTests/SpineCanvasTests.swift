import AppKit
import CoreGraphics
import Foundation
import SwiftUI
import XCTest

@testable import NetaDesktop

/// T10.10 contract: the assembled spine canvas against `FixtureNodeClient`.
@MainActor
final class SpineCanvasTests: XCTestCase {
	private let size = CGSize(width: 1600, height: 1000)
	private var viewportRect: CGRect { CGRect(origin: .zero, size: size) }

	private func makeStore() async throws -> Store {
		let snapshot = try await FixtureNodeClient().snapshot()
		let store = Store()
		store.replace(snapshot: snapshot)
		return store
	}

	private func makeView(_ store: Store) -> (
		view: SpineCanvasView, shell: ShellState,
		viewport: SpineViewportState, now: NowState, router: CheckpointRouter
	) {
		let shell = ShellState()
		let viewport = SpineViewportState(
			pxPerHour: SpineViewportState.defaultPxPerHour)
		let now = NowState()
		let router = CheckpointRouter()
		let view = SpineCanvasView(
			store: store, shell: shell, viewport: viewport, now: now,
			router: router)
		return (view, shell, viewport, now, router)
	}

	/// The fixture snapshot's one workspace. A mission made for a store test
	/// has to belong to it: the canvas draws `Store.currentMissions`, so a
	/// mission in another workspace is correctly invisible.
	private static let fixtureWorkspaceId = "git:github.com/acme/widget"

	private func makeMission(
		id: String, number: Int, state: MissionState, createdAt: Date,
		workspaceId: String = SpineCanvasTests.fixtureWorkspaceId
	) -> Mission {
		Mission(
			id: id, number: number,
			workspaceId: workspaceId, machineId: "m1",
			name: "mission \(number)", objective: "Objective.", changes: [],
			lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
			state: state, attention: nil,
			createdAt: createdAt,
			closedAt: nil, disposition: nil, closeReason: nil,
			integration: nil, continuesMissionId: nil)
	}

	private func makeIndex(
		missions: [Mission], events: [Event] = [],
		viewport: SpineViewportState
	) -> SpineIndex {
		SpineIndex(
			missions: missions, events: events,
			pxPerHour: viewport.pxPerHour, maxPitch: viewport.maxPitch)
	}

	// MARK: - Assembly

	/// The fixture yields a leader card plus one column per recorded
	/// mission, and the Now state lights at the live edge. The clamped
	/// sequence is wider than the default window, so the test opens a
	/// viewport wide enough to hold the whole content: windowing is the
	/// virtualiser's contract, not this test's.
	func testFixtureYieldsLeaderCardAndOneColumnPerMission() async throws {
		let store = try await makeStore()
		XCTAssertGreaterThan(store.missions.count, 0)
		let date = store.window.upperBound
		let (view, _, viewport, now, _) = makeView(store)
		let index = makeIndex(
			missions: store.missions, events: store.events,
			viewport: viewport)
		let wide = CGRect(
			x: 0, y: 0, width: index.contentWidth + 500,
			height: size.height)
		let frame = view.resolve(size: wide.size, date: date)
		XCTAssertEqual(
			frame.window.columns.count, store.missions.count,
			"every recorded mission materialises exactly one column")
		XCTAssertEqual(
			Set(frame.window.columns.map(\.id)),
			Set(store.missions.map(\.id)))
		XCTAssertEqual(
			frame.window.leader.width, SpineMetrics.standard.leaderCardWidth,
			accuracy: 1e-9)
		XCTAssertEqual(frame.window.leader.midY, frame.window.spineY)
		XCTAssertEqual(frame.emphasis.count, store.missions.count)
		XCTAssertTrue(now.isLive)
		XCTAssertEqual(now.label, "Now")
	}

	/// Card and row taps route through `shell.select`, and `Escape` returns
	/// selection to `.leader` — unless an overlay is open, which it closes
	/// first while keeping the selection.
	func testSelectionThenEscapeReturnsToLeader() async throws {
		let store = try await makeStore()
		let (view, shell, _, _, _) = makeView(store)
		XCTAssertEqual(shell.selection, .leader)
		let missionId = try XCTUnwrap(store.missions.first).id
		shell.select(.mission(missionId))
		XCTAssertEqual(shell.selection, .mission(missionId))
		let agentId = try XCTUnwrap(store.agentsById.values.first).id
		shell.select(.agent(agentId))
		XCTAssertEqual(shell.selection, .agent(agentId))
		view.handleEscape()
		XCTAssertEqual(shell.selection, .leader)

		shell.toggleNavigator()
		shell.select(.mission(missionId))
		view.handleEscape()
		XCTAssertFalse(shell.navigatorVisible)
		XCTAssertEqual(shell.selection, .mission(missionId))
		view.handleEscape()
		XCTAssertEqual(shell.selection, .leader)
	}

	/// Zoomed far out the missions collapse to ticks, but the leader card
	/// stays. The recorded fixture cannot engage the sixty-column cap, so a
	/// synthetic 200-mission day proves the overflow half of the rule.
	func testZoomedFarOutKeepsLeaderCardWhileMissionsBecomeTicks() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, _, viewport, _, _) = makeView(store)
		viewport.zoom(
			factor: 0.001, atCursorX: 800,
			index: makeIndex(
				missions: store.missions, events: store.events,
				viewport: viewport))
		let frame = view.resolve(size: size, date: date)
		XCTAssertEqual(
			frame.window.leader.width, SpineMetrics.standard.leaderCardWidth,
			accuracy: 1e-9)
		XCTAssertEqual(frame.window.leader.midY, frame.window.spineY)

		var missions: [Mission] = []
		missions.reserveCapacity(200)
		for i in 0 ..< 200 {
			missions.append(makeMission(
				id: "m\(i)", number: i + 1, state: .running,
				createdAt: date.addingTimeInterval(-Double(i) * 432)))
		}
		let over = SpineVirtualiser.window(
			index: SpineIndex(
				missions: missions, pxPerHour: viewport.pxPerHour,
				maxPitch: viewport.maxPitch),
			agents: [:], scrollX: 0,
			// Wide enough to hold past `maxLiveColumns` floored columns:
			// at the 120 pt minimum a 1600 pt window can never engage
			// the cap, so it must be wider than 60 columns plus buffers.
			viewport: CGRect(
				x: 0, y: 0, width: 61 * 120 + 2 * 210, height: 1000),
			now: date.timeIntervalSince1970 * 1000)
		XCTAssertEqual(
			over.columns.count, SpineMetrics.standard.maxLiveColumns)
		XCTAssertGreaterThan(over.ticks.count, 0)
		XCTAssertEqual(over.leader.midY, over.spineY)
	}

	// MARK: - Caching rules

	/// The index rebuilds only when the mission set, the checkpoint set or
	/// the spacing inputs change.
	func testIndexRebuildsOnlyOnInputChange() async throws {
		let store = try await makeStore()
		let pipeline = SpineCanvasPipeline()
		let viewport = SpineViewportState(
			pxPerHour: SpineViewportState.defaultPxPerHour)
		_ = pipeline.index(
			for: store.missions, events: store.events,
			pxPerHour: viewport.pxPerHour, maxPitch: viewport.maxPitch)
		XCTAssertEqual(pipeline.indexBuilds, 1)
		_ = pipeline.index(
			for: store.missions, events: store.events,
			pxPerHour: viewport.pxPerHour, maxPitch: viewport.maxPitch)
		XCTAssertEqual(pipeline.indexBuilds, 1)
		var grown = store.missions
		grown.append(makeMission(
			id: "new", number: 999, state: .running,
			createdAt: store.window.upperBound))
		_ = pipeline.index(
			for: grown, events: store.events,
			pxPerHour: viewport.pxPerHour, maxPitch: viewport.maxPitch)
		XCTAssertEqual(pipeline.indexBuilds, 2)
		viewport.zoom(
			factor: 1.25, atCursorX: 800,
			index: pipeline.index(
				for: grown, events: store.events,
				pxPerHour: viewport.pxPerHour,
				maxPitch: viewport.maxPitch))
		_ = pipeline.index(
			for: grown, events: store.events,
			pxPerHour: viewport.pxPerHour, maxPitch: viewport.maxPitch)
		XCTAssertEqual(pipeline.indexBuilds, 3, "spacing change rebuilds")
	}

	/// The window recomputes on scroll, viewport or store-revision change —
	/// including the expansion set — and reuses the cached frame otherwise.
	func testWindowRecomputesOnScrollViewportOrRevisionChange() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let pipeline = SpineCanvasPipeline()
		let viewport = SpineViewportState(
			pxPerHour: SpineViewportState.defaultPxPerHour)
		let now = NowState()
		_ = pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: viewportRect, date: date)
		XCTAssertEqual(pipeline.windowComputes, 1)
		_ = pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: viewportRect, date: date)
		XCTAssertEqual(pipeline.windowComputes, 1, "identical inputs reuse")
		viewport.zoom(
			factor: 1.25, atCursorX: 800,
			index: pipeline.index(
				for: store.missions, events: store.events,
				pxPerHour: viewport.pxPerHour,
				maxPitch: viewport.maxPitch))
		_ = pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: viewportRect, date: date)
		XCTAssertEqual(pipeline.windowComputes, 2, "spacing change recomputes")
		_ = pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: viewportRect.offsetBy(dx: 10, dy: 0), date: date)
		XCTAssertEqual(pipeline.windowComputes, 3, "viewport change recomputes")
		viewport.toggleExpanded(store.missions[0].id)
		_ = pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: viewportRect, date: date)
		XCTAssertEqual(pipeline.windowComputes, 4, "expansion recomputes")
		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(makeMission(
				id: "extra", number: 1000, state: .blocked, createdAt: date)))))
		_ = pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: viewportRect, date: date)
		XCTAssertEqual(pipeline.windowComputes, 5, "store revision recomputes")
	}

	/// The first layout jumps to Now: the live edge — the leader card's far
	/// edge — lands on the canvas's usable right edge, the chat's leading
	/// edge less `SpinePlacement.chatGap`, never at content x 0 behind the
	/// navigator band.
	func testFirstLayoutPutsTheLiveEdgeAtTheUsableRightEdge() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, now, _) = makeView(store)
		XCTAssertEqual(viewport.scrollX, 0, "nothing has laid out yet")
		let index = makeIndex(
			missions: store.missions, events: store.events,
			viewport: viewport)
		let frame = view.resolve(size: size, date: date)
		let inset = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		XCTAssertEqual(
			viewport.scrollX,
			SpinePlacement.liveScrollX(
				index: index, viewport: viewportRect, trailingInset: inset),
			accuracy: 1e-9)
		let layout = ShellLayout.compute(
			size: size, chatVisible: true, navigatorVisible: true)
		let chat = try XCTUnwrap(layout.chat)
		let navigator = try XCTUnwrap(layout.navigator)
		XCTAssertEqual(
			frame.window.leader.maxX, chat.minX - SpinePlacement.chatGap,
			accuracy: 1e-6)
		XCTAssertGreaterThan(frame.window.leader.minX, navigator.maxX)
		XCTAssertTrue(now.isLive)
		XCTAssertEqual(now.label, "Now")
	}

	/// A live view stays pinned at Now as missions arrive. A new mission
	/// widens the content by at least a minimum column, so a fixed `scrollX`
	/// would slide the leader card right, behind the chat glass, and unlight
	/// Now until the person tapped it.
	func testContentGrowthWhileLiveStaysAtNow() async throws {
		let store = Store()
		let base = Date(timeIntervalSince1970: 1_787_712_000)
		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(makeMission(
				id: "a", number: 1, state: .running,
				createdAt: base.addingTimeInterval(-3600))))))
		let (view, shell, viewport, now, _) = makeView(store)
		let inset = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		let first = view.resolve(size: size, date: base)
		let edge = size.width - inset
		XCTAssertEqual(first.window.leader.maxX, edge, accuracy: 1e-6)
		XCTAssertTrue(now.isLive)
		let anchored = viewport.scrollX
		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(makeMission(
				id: "b", number: 2, state: .running,
				createdAt: base.addingTimeInterval(-60))))))
		let grown = view.resolve(size: size, date: base)
		XCTAssertGreaterThan(
			makeIndex(missions: store.missions, viewport: viewport)
				.contentWidth,
			SpineViewportState.minPitch,
			"the second mission widened the content")
		XCTAssertNotEqual(viewport.scrollX, anchored)
		XCTAssertEqual(grown.window.leader.maxX, edge, accuracy: 1e-6)
		XCTAssertTrue(now.isLive)
		XCTAssertEqual(now.label, "Now")
	}

	/// The mission bar owns the Now control independently of the canvas, and
	/// it reaches Now the one way anything outside the canvas does: the
	/// shell's `jumpToNow()`, which the canvas answers in `applyShellNow`
	/// with the index it holds. A tap before the first layout is harmless —
	/// the canvas computes the live edge when it answers, so nothing stages
	/// a jump to content x 0, the far-left placement this pass removed.
	func testTheBarReachesNowThroughTheShell() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, now, _) = makeView(store)
		shell.jumpToNow()
		view.applyShellNow(size: size)
		_ = view.resolve(size: size, date: date)
		let inset = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		let index = makeIndex(
			missions: store.missions, events: store.events,
			viewport: viewport)
		XCTAssertEqual(
			viewport.scrollX,
			SpinePlacement.liveScrollX(
				index: index, viewport: viewportRect, trailingInset: inset),
			accuracy: 1e-9)
		XCTAssertTrue(now.isLive)
		let names = Mirror(reflecting: now).children
			.compactMap(\.label)
			.map { $0.hasPrefix("_") ? String($0.dropFirst()) : $0 }
		XCTAssertFalse(
			names.contains("jumpRequest"),
			"the shell path is the only one; NowState stages nothing")
	}

	/// Fit lands on the same right alignment as a Now jump, so ⌘0 and the
	/// bar's Now control never disagree about where Now is.
	func testFitAndJumpToNowAgreeThroughResolve() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, now, _) = makeView(store)
		_ = view.resolve(size: size, date: date)
		let inset = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		let index = makeIndex(
			missions: store.missions, events: store.events,
			viewport: viewport)
		viewport.fit(
			index: index, viewport: viewportRect, trailingInset: inset)
		let fitted = index.respaced(
			pxPerHour: viewport.pxPerHour, maxPitch: viewport.maxPitch)
		let afterFit = viewport.scrollX
		XCTAssertEqual(
			afterFit,
			SpinePlacement.liveScrollX(
				index: fitted, viewport: viewportRect, trailingInset: inset),
			accuracy: 1e-9,
			"Fit lands where the shell's Now jump resolves to")
		shell.jumpToNow()
		view.applyShellNow(size: size)
		_ = view.resolve(size: size, date: date)
		XCTAssertEqual(viewport.scrollX, afterFit, accuracy: 1e-9)
		XCTAssertTrue(now.isLive)
	}

	/// A Now jump from a view scrolled back in time: the scroll moves to the
	/// live edge and Now lights again. The one path — `ShellState.jumpToNow`
	/// answered by `applyShellNow`.
	func testJumpToNowAppliesThroughResolve() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, now, _) = makeView(store)
		let index = makeIndex(
			missions: store.missions, events: store.events,
			viewport: viewport)
		let inset = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		_ = view.resolve(size: size, date: date)
		XCTAssertTrue(now.isLive)
		viewport.pan(
			by: CGSize(width: -1_000_000, height: 0), index: index,
			viewport: viewportRect, contentHeight: size.height,
			trailingInset: inset)
		_ = view.resolve(size: size, date: date)
		XCTAssertFalse(now.isLive)
		XCTAssertTrue(now.label.hasPrefix("Now · "))
		shell.jumpToNow()
		view.applyShellNow(size: size)
		_ = view.resolve(size: size, date: date)
		XCTAssertEqual(
			viewport.scrollX,
			SpinePlacement.liveScrollX(
				index: index, viewport: viewportRect, trailingInset: inset),
			accuracy: 1e-9)
		XCTAssertTrue(now.isLive)
		XCTAssertEqual(now.label, "Now")
	}

	// MARK: - Background click, zoom and Fit

	/// The dismiss target is a plain `Button` under every node, not a tap
	/// gesture on the backdrop.
	///
	/// Measured on the running app (navigator open, 1600 x 984): a
	/// synthesized click at (500, 534) on empty canvas left
	/// `navigator=true` with `Color.clear.onTapGesture`, while the same
	/// click on the toolbar's Fit button bumped `fitRequested` — the click
	/// was delivered, the gesture did not answer it. With the button, the
	/// same click reports `navigator=false`.
	func testTheBackgroundDismissTargetIsAButtonNotATapGesture() throws {
		let source = try spineCanvasSource()
		XCTAssertFalse(
			source.contains(".onTapGesture"),
			"a tap gesture on the backdrop never received the click")
		let start = try XCTUnwrap(
			source.range(of: "Button(action: handleBackgroundTap)"))
		let block = String(source[start.lowerBound...].prefix(400))
		XCTAssertTrue(block.contains("Color.clear"), "the target is invisible")
		XCTAssertTrue(
			block.contains("contentShape(Rectangle())"),
			"and hit-tests its whole rect")
		XCTAssertTrue(
			block.contains(".focusable(false)")
				&& block.contains(".accessibilityHidden(true)"),
			"a click target and nothing else")
		let nodes = try XCTUnwrap(
			source.range(
				of: "SpineBackdrop(",
				range: start.lowerBound ..< source.endIndex))
		XCTAssertLessThan(
			start.lowerBound, nodes.lowerBound,
			"the dismiss target sits below the nodes, not over them")
	}

	private func spineCanvasSource() throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/Canvas/SpineCanvasView.swift")
		return try String(contentsOf: url, encoding: .utf8)
	}

	/// A click on the canvas backdrop dismisses the navigator and leaves the
	/// selection alone; Escape still returns the selection to the leader.
	func testBackgroundTapDismissesTheNavigator() async throws {
		let store = try await makeStore()
		let (view, shell, _, _, _) = makeView(store)
		let missionId = try XCTUnwrap(store.missions.first).id
		shell.select(.mission(missionId))
		shell.toggleNavigator()
		XCTAssertTrue(shell.navigatorVisible)
		view.handleBackgroundTap()
		XCTAssertFalse(shell.navigatorVisible)
		XCTAssertEqual(
			shell.selection, .mission(missionId),
			"a background click closes the overlay, it does not reselect")
		view.handleBackgroundTap()
		XCTAssertFalse(shell.navigatorVisible)
		XCTAssertEqual(shell.selection, .mission(missionId))
		view.handleEscape()
		XCTAssertEqual(shell.selection, .leader)
	}

	/// `⌘=` / `⌘-` and the toolbar's zoom buttons only move
	/// `ShellState.timeZoom`; the canvas observes it and drives the spacing,
	/// holding the live edge while the view is live.
	func testShellTimeZoomDrivesTheSpacingAndHoldsNow() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, now, _) = makeView(store)
		_ = view.resolve(size: size, date: date)
		XCTAssertTrue(now.isLive)
		let inset = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		let before = viewport.pxPerHour

		shell.zoomIn()
		view.applyShellZoom(size: size)
		XCTAssertEqual(viewport.pxPerHour, before * 1.25, accuracy: 1e-9)
		let zoomed = makeIndex(
			missions: store.missions, events: store.events,
			viewport: viewport)
		XCTAssertEqual(
			viewport.scrollX,
			SpinePlacement.liveScrollX(
				index: zoomed, viewport: viewportRect, trailingInset: inset),
			accuracy: 1e-6,
			"a zoom about the centre still ends at Now while live")
		let frame = view.resolve(size: size, date: date)
		XCTAssertEqual(
			frame.window.leader.maxX, size.width - inset, accuracy: 1e-6)
		XCTAssertTrue(now.isLive)

		// No shell move, no canvas move.
		view.applyShellZoom(size: size)
		XCTAssertEqual(viewport.pxPerHour, before * 1.25, accuracy: 1e-9)

		shell.zoomOut()
		view.applyShellZoom(size: size)
		XCTAssertEqual(viewport.pxPerHour, before, accuracy: 1e-9)
	}

	/// `⌘0` reaches the canvas through `shell.fitRequested`. `ShellState.fit`
	/// also resets `timeZoom`, so both observers fire for one Fit: the zoom
	/// observer must be a no-op whichever order they land in.
	func testShellFitDrivesFitAndSwallowsItsOwnZoomReset() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let inset = SpineCanvasPipeline.trailingInset(
			size: size, shell: ShellState())

		func fitted(zoomObserverFirst: Bool) throws -> (Double, CGFloat) {
			let (view, shell, viewport, _, _) = makeView(store)
			_ = view.resolve(size: size, date: date)
			shell.zoomIn()
			view.applyShellZoom(size: size)
			XCTAssertNotEqual(
				viewport.pxPerHour,
				SpineViewportState.defaultPxPerHour)
			shell.fit()
			if zoomObserverFirst {
				view.applyShellZoom(size: size)
				view.applyShellFit(size: size)
			} else {
				view.applyShellFit(size: size)
				view.applyShellZoom(size: size)
			}
			return (viewport.pxPerHour, viewport.scrollX)
		}

		let (px, scrollX) = try fitted(zoomObserverFirst: false)
		let reference = SpineViewportState(
			pxPerHour: SpineViewportState.defaultPxPerHour)
		reference.fit(
			index: makeIndex(
				missions: store.missions, events: store.events,
				viewport: reference),
			viewport: viewportRect, trailingInset: inset)
		XCTAssertEqual(px, reference.pxPerHour, accuracy: 1e-9)
		XCTAssertEqual(scrollX, reference.scrollX, accuracy: 1e-6)
		let (otherPx, otherScrollX) = try fitted(zoomObserverFirst: true)
		XCTAssertEqual(otherPx, px, accuracy: 1e-9)
		XCTAssertEqual(otherScrollX, scrollX, accuracy: 1e-6)
	}

	/// The window cache key carries no date, so a view sitting still behind
	/// the live edge would keep the age it had when the pan stopped. Now is
	/// refreshed on the cached path too.
	func testNowLabelRefreshesOnACachedFrame() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, now, _) = makeView(store)
		let inset = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		let index = makeIndex(
			missions: store.missions, events: store.events,
			viewport: viewport)
		_ = view.resolve(size: size, date: date)
		viewport.pan(
			by: CGSize(width: -1_000_000, height: 0), index: index,
			viewport: viewportRect, contentHeight: size.height,
			trailingInset: inset)
		_ = view.resolve(size: size, date: date)
		XCTAssertFalse(now.isLive)
		let first = now.label
		XCTAssertTrue(first.hasPrefix("Now · "))
		// Same scroll, same store, same viewport: the window is cached and
		// only the wall clock moved.
		_ = view.resolve(
			size: size, date: date.addingTimeInterval(10 * 86400))
		XCTAssertFalse(now.isLive)
		XCTAssertNotEqual(now.label, first, "the age is not frozen")
	}

	/// Selecting a mission — from the bar or the navigator — pans the spine
	/// to it (MANIFESTO.md "The mission inbox"; 09-desktop-shell T9.9 step
	/// 3). A column already in view moves nothing, and `.leader` is Now.
	func testSelectingAMissionPansTheSpineToIt() throws {
		let store = Store()
		let base = Date(timeIntervalSince1970: 1_787_712_000)
		for i in 0 ..< 10 {
			store.apply(notification: .state(StateChange(
				kind: .mission,
				record: .mission(makeMission(
					id: "m\(i)", number: i + 1, state: .running,
					createdAt: base.addingTimeInterval(
						-Double(i) * 86400))))))
		}
		let (view, shell, viewport, _, _) = makeView(store)
		let live = view.resolve(size: size, date: base)
		let trailing = SpineCanvasPipeline.trailingInset(
			size: size, shell: shell)
		let liveScrollX = viewport.scrollX
		let index = makeIndex(missions: store.missions, viewport: viewport)
		let oldest = try XCTUnwrap(
			store.missions.min { $0.createdAt < $1.createdAt })
		let position = try XCTUnwrap(
			(0 ..< index.count).first { index.mission($0)?.id == oldest.id })
		XCTAssertLessThan(
			index.x(position) - liveScrollX, 0,
			"the oldest mission starts off the left edge")
		XCTAssertFalse(live.window.columns.contains { $0.id == oldest.id })

		shell.select(.mission(oldest.id))
		view.revealSelection(size: size)
		let panned = view.resolve(size: size, date: base)
		let column = try XCTUnwrap(
			panned.window.columns.first { $0.id == oldest.id })
		XCTAssertGreaterThanOrEqual(column.anchor.x, 0)
		XCTAssertLessThanOrEqual(column.anchor.x, size.width - trailing)

		// The oldest column clamped to `scrollX == 0`, so the second reveal
		// returns nil through `revealScrollX`'s fixpoint (the target it
		// would pan to is where the view already sits), not through the
		// already-in-view early return. `SpinePlacementTests` covers the
		// pure cases; what matters here is that nothing moves.
		let held = viewport.scrollX
		view.revealSelection(size: size)
		XCTAssertEqual(viewport.scrollX, held)
		let half = SpineMetrics.standard.leadCardWidth / 2
		let alsoVisible = try XCTUnwrap(
			panned.window.columns.first {
				$0.id != oldest.id && $0.anchor.x - half >= 0
					&& $0.anchor.x + half <= size.width - trailing
			})
		shell.select(.mission(alsoVisible.id))
		view.revealSelection(size: size)
		XCTAssertEqual(viewport.scrollX, held)

		// The leader is Now.
		shell.select(.leader)
		view.revealSelection(size: size)
		XCTAssertEqual(viewport.scrollX, liveScrollX, accuracy: 1e-9)
	}

	/// `ShellState.timeZoom` clamps at `maxZoom`, so the move that saturates
	/// the clamp is a partial step. The spacing follows the ratio the shell
	/// actually moved: a full step there would leave the toolbar readout
	/// claiming a spacing the canvas does not have.
	func testZoomAtTheShellClampFollowsTheRatioNotAFullStep() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, _, _) = makeView(store)
		_ = view.resolve(size: size, date: date)
		let before = viewport.pxPerHour
		for _ in 0 ..< 12 {
			shell.zoomIn()
			view.applyShellZoom(size: size)
		}
		XCTAssertEqual(shell.timeZoom, ShellState.maxZoom, accuracy: 1e-12)
		XCTAssertEqual(
			viewport.pxPerHour, before * ShellState.maxZoom, accuracy: 1e-6,
			"the spacing never runs past the shell's clamp")
	}

	// MARK: - One workspace, Now, and the pinch

	/// The canvas draws the current workspace only. The Node lists every
	/// open workspace in one snapshot, and two of them interleaved run two
	/// sequences through each other on one spine.
	func testTheCanvasDrawsOnlyTheCurrentWorkspace() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, _, _, _, _) = makeView(store)
		let mine = store.currentMissions.count
		XCTAssertGreaterThan(mine, 0)

		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(makeMission(
				id: "other-1", number: 1, state: .running, createdAt: date,
				workspaceId: "git:github.com/acme/other")))))
		XCTAssertEqual(store.missions.count, mine + 1, "the cache keeps it")
		XCTAssertEqual(store.currentMissions.count, mine)

		let frame = view.resolve(size: size, date: date)
		XCTAssertFalse(
			frame.window.columns.contains { $0.id == "other-1" },
			"another workspace's mission is not on this spine")
	}

	/// The mission bar's Now control and the debug driver both ask through
	/// `ShellState.jumpToNow`; the canvas is what knows where the live edge
	/// is, so this is the whole other end of that wire.
	func testTheShellsNowRequestJumpsToTheLiveEdge() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, now, _) = makeView(store)
		_ = view.resolve(size: size, date: date)
		let live = viewport.scrollX
		XCTAssertTrue(now.isLive)

		viewport.pan(
			by: CGSize(width: -400, height: 0),
			index: makeIndex(missions: store.currentMissions, viewport: viewport),
			viewport: viewportRect, contentHeight: size.height,
			trailingInset: SpineCanvasPipeline.trailingInset(
				size: size, shell: shell))
		_ = view.resolve(size: size, date: date)
		XCTAssertNotEqual(viewport.scrollX, live)
		XCTAssertFalse(now.isLive)

		shell.jumpToNow()
		view.applyShellNow(size: size)
		XCTAssertEqual(viewport.scrollX, live, accuracy: 1e-9)
		_ = view.resolve(size: size, date: date)
		XCTAssertTrue(now.isLive, "the control lights again")
	}

	/// A pinch moves the spacing and the shell's `timeZoom` together, so the
	/// toolbar's `−  100%  +` readout cannot report a zoom the canvas does
	/// not have. The applied stamp is written first, so the `timeZoom`
	/// observer the write fires does not apply the pinch a second time.
	func testPinchKeepsTheToolbarReadoutInStep() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, _, _) = makeView(store)
		_ = view.resolve(size: size, date: date)
		let spacing = viewport.pxPerHour

		view.applyPinch(factor: 1.5, atX: 800, size: size)
		XCTAssertEqual(shell.timeZoom, 1.5, accuracy: 1e-9)
		XCTAssertEqual(shell.zoomPercent, 150)
		XCTAssertEqual(viewport.pxPerHour, spacing * 1.5, accuracy: 1e-6)

		// The observer the shell write fires is a no-op: the stamp already
		// matches, so the spacing does not move again.
		view.applyShellZoom(size: size)
		XCTAssertEqual(viewport.pxPerHour, spacing * 1.5, accuracy: 1e-6)

		// And the clamp is the shell's own: a pinch cannot drive the readout
		// past 400%.
		view.applyPinch(factor: 100, atX: 800, size: size)
		XCTAssertEqual(shell.timeZoom, ShellState.maxZoom)
	}

	/// Scrolled back in time, widening the usable band (hiding the chat,
	/// resizing the window) lowers the live edge; a `scrollX` above the new
	/// edge used to stay there, because nothing outside `pan` and `zoom`
	/// re-clamps, and the leader was drawn left of the usable right edge
	/// with dead space beside it until the next gesture.
	func testWideningTheBandReclampsAViewScrolledBackInTime() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, viewport, now, _) = makeView(store)
		_ = view.resolve(size: size, date: date)
		let index = makeIndex(
			missions: store.currentMissions, events: store.currentEvents,
			viewport: viewport)
		viewport.pan(
			by: CGSize(width: -120, height: 0), index: index,
			viewport: viewportRect, contentHeight: size.height,
			trailingInset: SpineCanvasPipeline.trailingInset(
				size: size, shell: shell))
		_ = view.resolve(size: size, date: date)
		XCTAssertFalse(now.isLive)
		let back = viewport.scrollX

		shell.chatVisible = false
		let trailing = SpineCanvasPipeline.trailingInset(size: size, shell: shell)
		let live = SpinePlacement.liveScrollX(
			index: index, viewport: viewportRect, trailingInset: trailing)
		XCTAssertGreaterThan(
			back, live, "the wider band puts the live edge below the view")
		let widened = view.resolve(size: size, date: date)
		XCTAssertEqual(
			viewport.scrollX, live, accuracy: 1e-9,
			"the view is re-clamped onto the new live edge")
		XCTAssertEqual(
			widened.window.leader.maxX, size.width - trailing, accuracy: 0.5,
			"so the leader lands exactly on the usable right edge")
	}

	// MARK: - Shell insets and content height

	/// The trackpad capture leaves the rects the floating surfaces cover,
	/// and the content height always covers the viewport.
	func testContentHeightAndInteractionRects() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, _, _, _) = makeView(store)
		let frame = view.resolve(size: size, date: date)
		XCTAssertGreaterThanOrEqual(
			SpineCanvasPipeline.contentHeight(
				window: frame.window, viewport: viewportRect),
			size.height)
		let layout = ShellLayout.compute(
			size: size, chatVisible: true, navigatorVisible: false)
		let rects = SpineCanvasPipeline.interactionRects(
			size: size, shell: shell)
		XCTAssertEqual(rects, layout.covered)
		XCTAssertTrue(rects.contains(layout.missionBar))

		// The navigator is a scrolling jump list: leaving it inside the
		// capture region makes two-finger scroll over it pan the canvas.
		// Only its own rect, though — the canvas above and below the panel
		// keeps panning, which a full-height leading column stopped.
		shell.showNavigator()
		let open = ShellLayout.compute(
			size: size, chatVisible: shell.chatVisible,
			navigatorVisible: true)
		let navigator = try XCTUnwrap(open.navigator)
		let withNavigator = SpineCanvasPipeline.interactionRects(
			size: size, shell: shell)
		XCTAssertTrue(
			withNavigator.contains(navigator),
			"the open navigator panel is outside the trackpad capture")
		XCTAssertFalse(
			withNavigator.contains { $0.minY <= 0 && $0.maxX <= navigator.maxX },
			"nothing carves a full-height column out of the canvas")
		let capture = TrackpadPanCaptureView()
		capture.configure(
			isEnabled: true, excludedRects: withNavigator, onScroll: { _ in })
		let bounds = NSRect(origin: .zero, size: size)
		// A point in the navigator's own band, and the same x above it: the
		// panel keeps its scrolling and the canvas above it keeps panning.
		// The view is unflipped, so a SwiftUI y maps to `height - y`.
		XCTAssertFalse(capture.capturesPoint(
			NSPoint(x: navigator.midX, y: size.height - navigator.midY),
			in: bounds))
		XCTAssertTrue(capture.capturesPoint(
			NSPoint(x: navigator.midX, y: size.height - 20), in: bounds))

		shell.hideNavigator()
		XCTAssertFalse(
			SpineCanvasPipeline.interactionRects(size: size, shell: shell)
				.contains(navigator))

		shell.chatVisible = false
		XCTAssertNil(
			ShellLayout.compute(
				size: size, chatVisible: false,
				navigatorVisible: shell.navigatorVisible).chat)
	}
}
