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

	private func makeMission(
		id: String, number: Int, state: MissionState, createdAt: Date
	) -> Mission {
		Mission(
			id: id, number: number,
			workspaceId: "w1", machineId: "m1",
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
		viewport.jump(to: max(0, index.contentWidth - wide.width))
		let frame = view.resolve(size: wide.size, date: date)
		XCTAssertEqual(
			frame.window.columns.count, store.missions.count,
			"every recorded mission materialises exactly one column")
		XCTAssertEqual(
			Set(frame.window.columns.map(\.id)),
			Set(store.missions.map(\.id)))
		XCTAssertEqual(
			frame.window.leader.width, SpineMetrics.standard.leadCardWidth,
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
			frame.window.leader.width, SpineMetrics.standard.leadCardWidth,
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

	/// A staged jump applies through the next resolution: the scroll moves,
	/// the request clears, and Now lights again.
	func testJumpToNowAppliesThroughResolve() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, _, viewport, now, _) = makeView(store)
		let index = makeIndex(
			missions: store.missions, events: store.events,
			viewport: viewport)
		viewport.pan(
			by: CGSize(width: 1_000_000, height: 0), index: index,
			viewport: viewportRect, contentHeight: size.height)
		_ = view.resolve(size: size, date: date)
		now.jumpToNow(index: index, viewport: viewportRect)
		_ = view.resolve(size: size, date: date)
		XCTAssertNil(now.consumeJump())
		XCTAssertEqual(
			viewport.scrollX,
			max(0, index.contentWidth - viewportRect.width), accuracy: 1e-9)
		XCTAssertTrue(now.isLive)
		XCTAssertEqual(now.label, "Now")
	}

	// MARK: - Shell insets and content height

	/// The trackpad capture carves out the mission-bar strip and the chat
	/// band, and the content height always covers the viewport.
	func testContentHeightAndInteractionInsets() async throws {
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
		let insets = SpineCanvasPipeline.interactionInsets(
			size: size, shell: shell)
		XCTAssertEqual(insets.top, 0)
		XCTAssertEqual(insets.leading, 0)
		XCTAssertEqual(
			insets.bottom, size.height - layout.missionBar.minY)
		XCTAssertGreaterThan(insets.trailing, 0)
		shell.chatVisible = false
		XCTAssertEqual(
			SpineCanvasPipeline.interactionInsets(size: size, shell: shell)
				.trailing,
			0)
	}
}
