import CoreGraphics
import Foundation
import SwiftUI
import XCTest

@testable import NetaDesktop

/// T10.9 contract: the assembled spine canvas against `FixtureNodeClient`.
///
/// The recorded fixture holds thirteen missions (the plan text says fourteen;
/// the test asserts one column per recorded mission, whatever the count). A
/// leader card stays pinned at the live edge while missions collapse to ticks
/// when zoomed far out; selecting a mission then an agent updates
/// `shell.selection` and `Escape` returns it to `.leader`.
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

	/// A lens whose focus window covers every recorded mission, so the
	/// virtualiser materialises the whole mission set as columns.
	private func coveringLens(_ store: Store) -> TimeLens {
		let times = store.missions.map {
			$0.createdAt.timeIntervalSince1970 * 1000
		}
		let nowMs = store.window.upperBound.timeIntervalSince1970 * 1000
		return TimeLens(TimeLensOptions(
			now: nowMs, focusStart: (times.min() ?? nowMs) - 3_600_000,
			focusEnd: nowMs, width: Double(size.width), minPxPerHour: 8))
	}

	private func makeView(_ store: Store, lens: TimeLens) -> (
		view: SpineCanvasView, shell: ShellState,
		viewport: SpineViewportState, now: NowState, router: CheckpointRouter
	) {
		let shell = ShellState()
		let viewport = SpineViewportState(lens: lens)
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

	// MARK: - Assembly

	/// The fixture yields a leader card plus one column per recorded
	/// mission, and the Now state lights at the live edge.
	func testFixtureYieldsLeaderCardAndOneColumnPerMission() async throws {
		let store = try await makeStore()
		XCTAssertGreaterThan(store.missions.count, 0)
		let date = store.window.upperBound
		let nowMs = date.timeIntervalSince1970 * 1000
		let (view, _, viewport, now, _) = makeView(
			store, lens: coveringLens(store))
		let frame = view.resolve(size: size, date: date)
		XCTAssertEqual(
			frame.window.columns.count, store.missions.count,
			"every recorded mission materialises exactly one column")
		XCTAssertEqual(
			Set(frame.window.columns.map(\.id)),
			Set(store.missions.map(\.id)))
		XCTAssertEqual(
			frame.window.leader.width, SpineMetrics.standard.leadCardWidth,
			accuracy: 1e-9)
		XCTAssertEqual(
			frame.window.leader.midX, CGFloat(viewport.lens.x(nowMs)),
			accuracy: 1e-9, "leader card pinned at Now")
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
		let (view, shell, _, _, _) = makeView(
			store, lens: coveringLens(store))
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
	/// stays pinned at the live edge. The thirteen-mission fixture cannot
	/// engage the sixty-column cap, so a synthetic 200-mission day proves
	/// the overflow half of the rule.
	func testZoomedFarOutKeepsLeaderCardWhileMissionsBecomeTicks() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let nowMs = date.timeIntervalSince1970 * 1000
		let (view, _, viewport, _, _) = makeView(
			store, lens: coveringLens(store))
		viewport.zoom(factor: 0.001, atCursorX: 800)
		let frame = view.resolve(size: size, date: date)
		XCTAssertGreaterThan(frame.window.ticks.count, 0)
		XCTAssertLessThanOrEqual(frame.window.ticks.count, Int(size.width))
		XCTAssertEqual(
			frame.window.leader.midX, CGFloat(viewport.lens.x(nowMs)),
			accuracy: 1e-9, "leader card stays at the live edge")
		XCTAssertEqual(frame.window.leader.midY, frame.window.spineY)

		var missions: [Mission] = []
		missions.reserveCapacity(200)
		for i in 0 ..< 200 {
			missions.append(makeMission(
				id: "m\(i)", number: i + 1, state: .running,
				createdAt: date.addingTimeInterval(-Double(i) * 432)))
		}
		let wide = TimeLens(TimeLensOptions(
			now: nowMs, focusStart: nowMs - 24 * 3_600_000, focusEnd: nowMs,
			width: Double(size.width), minPxPerHour: 8))
		let over = SpineVirtualiser.window(
			index: SpineIndex(missions: missions), agents: [:], lens: wide,
			viewport: viewportRect)
		XCTAssertEqual(
			over.columns.count, SpineMetrics.standard.maxLiveColumns)
		XCTAssertGreaterThan(over.ticks.count, 0)
		XCTAssertEqual(
			over.leader.midX, CGFloat(wide.x(nowMs)), accuracy: 1e-9)
	}

	// MARK: - Caching rules

	/// The index rebuilds only when the mission set changes by value.
	func testIndexRebuildsOnlyOnMissionSetChange() async throws {
		let store = try await makeStore()
		let pipeline = SpineCanvasPipeline()
		_ = pipeline.index(for: store.missions)
		XCTAssertEqual(pipeline.indexBuilds, 1)
		_ = pipeline.index(for: store.missions)
		XCTAssertEqual(pipeline.indexBuilds, 1)
		var grown = store.missions
		grown.append(makeMission(
			id: "new", number: 999, state: .running,
			createdAt: store.window.upperBound))
		_ = pipeline.index(for: grown)
		XCTAssertEqual(pipeline.indexBuilds, 2)
		_ = pipeline.index(for: grown)
		XCTAssertEqual(pipeline.indexBuilds, 2)
	}

	/// The window recomputes on lens, viewport or store-revision change —
	/// including the expansion set — and reuses the cached frame otherwise.
	func testWindowRecomputesOnLensViewportOrRevisionChange() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let pipeline = SpineCanvasPipeline()
		let viewport = SpineViewportState(lens: coveringLens(store))
		let now = NowState()
		_ = pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: viewportRect, date: date)
		XCTAssertEqual(pipeline.windowComputes, 1)
		_ = pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: viewportRect, date: date)
		XCTAssertEqual(pipeline.windowComputes, 1, "identical inputs reuse")
		viewport.zoom(factor: 1.25, atCursorX: 800)
		_ = pipeline.frame(
			store: store, viewportState: viewport, nowState: now,
			viewport: viewportRect, date: date)
		XCTAssertEqual(pipeline.windowComputes, 2, "lens change recomputes")
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

	/// A staged jump applies through the next resolution: the lens
	/// re-anchors, the request clears, and Now lights again.
	func testJumpToNowAppliesThroughResolve() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let nowMs = date.timeIntervalSince1970 * 1000
		let (view, _, viewport, now, _) = makeView(
			store, lens: coveringLens(store))
		viewport.pan(
			by: CGSize(width: 800, height: 0), viewport: viewportRect,
			contentHeight: size.height)
		_ = view.resolve(size: size, date: date)
		XCTAssertFalse(now.isLive)
		now.jumpToNow(lens: viewport.lens, viewport: viewportRect, now: date)
		_ = view.resolve(size: size, date: date)
		XCTAssertNil(now.consumeJump())
		XCTAssertEqual(
			viewport.lens.x(nowMs), Double(viewportRect.maxX), accuracy: 1e-9)
		XCTAssertTrue(now.isLive)
		XCTAssertEqual(now.label, "Now")
	}

	// MARK: - Shell insets and content height

	/// The trackpad capture carves out the mission-bar strip and the chat
	/// band, and the content height always covers the viewport.
	func testContentHeightAndInteractionInsets() async throws {
		let store = try await makeStore()
		let date = store.window.upperBound
		let (view, shell, _, _, _) = makeView(
			store, lens: coveringLens(store))
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
