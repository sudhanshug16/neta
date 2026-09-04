import Foundation
import SwiftUI
import XCTest

@testable import NetaDesktop

/// T9.10 contract: `open` is number descending, `archived` is closedAt
/// descending; a closed mission never appears in `open`; `#30` matches by
/// number prefix and `refund` case-insensitively by name; an empty query
/// returns every mission; one machine gives `machines == nil`; no leader
/// row, no group counts.
///
/// Known limit of the seam: SwiftUI offers no view introspection in this
/// package, so the drawn assertions sit on `NavigatorOverlay.sections(query:)`
/// and the `NavigatorSection`/`NavigatorRow` payloads it returns —
/// `NavigatorOverlay.body` renders exactly that list, header then rows. A
/// mutation to the payload or to the header/row statics fails here; a mutation
/// that keeps the payload and changes only the view builders (dropping a
/// `Text`, inlining a font instead of rendering `section.header`) does not.
/// A green suite is therefore proof of what the panel is told to draw, not of
/// the pixels. Closing that needs a snapshot or AX-tree check.
@MainActor
final class NavigatorTests: XCTestCase {
	func testOpenIsNumberDescending() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(model.open.map(\.number), [12, 11, 10, 9, 8, 7, 5, 4, 3, 2, 1])
	}

	func testArchivedIsClosedAtDescending() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(model.archived.map(\.number), [13, 6])
	}

	func testClosedMissionNeverAppearsInOpen() async throws {
		let store = try await fixtureStore()
		let closedIds = Set(store.missions.filter { $0.state == .closed }.map(\.id))
		XCTAssertEqual(closedIds.count, 2)
		XCTAssertEqual(NavigatorModel.make(store: store, query: "").archived.count, 2)
		for row in NavigatorModel.make(store: store, query: "").open {
			XCTAssertFalse(closedIds.contains(row.id))
		}
	}

	func testHashPrefixMatchesNumberPrefix() {
		let store = storeFor(missions: [
			missi(number: 3, name: "Checkout rollout", state: .running),
			missi(number: 30, name: "Refund flow edge cases", state: .blocked),
			missi(number: 31, name: "Search index rebuild", state: .running),
			missi(number: 300, name: "Terraform drift on staging", state: .running),
		])
		let numbers = NavigatorModel.make(store: store, query: "#30").open.map(\.number)
		XCTAssertEqual(numbers, [300, 30])
	}

	func testBareDigitsMatchNumberPrefix() {
		let store = storeFor(missions: [
			missi(number: 3, name: "Checkout rollout", state: .running),
			missi(number: 30, name: "Refund flow edge cases", state: .blocked),
			missi(number: 31, name: "Search index rebuild", state: .running),
		])
		let numbers = NavigatorModel.make(store: store, query: "30").open.map(\.number)
		XCTAssertEqual(numbers, [30])
	}

	func testNameSubstringIsCaseInsensitive() {
		let store = storeFor(missions: [
			missi(number: 30, name: "Refund flow edge cases", state: .blocked),
			missi(number: 31, name: "Search index rebuild", state: .running),
		])
		for query in ["refund", "REFUND", "ReFuNd"] {
			let rows = NavigatorModel.make(store: store, query: query).open
			XCTAssertEqual(rows.map(\.number), [30], "query \(query)")
		}
	}

	func testNumberQueryDoesNotMatchNameSubstring() {
		let store = storeFor(missions: [
			missi(number: 5, name: "Apartment 300 review", state: .running),
			missi(number: 30, name: "Checkout rollout", state: .running),
		])
		// "#30" is a number-prefix query: it must not match the "300" in
		// mission 5's name.
		XCTAssertEqual(NavigatorModel.make(store: store, query: "#30").open.map(\.number), [30])
	}

	func testEmptyQueryReturnsEveryMission() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(model.open.count + model.archived.count, store.missions.count)
		XCTAssertEqual(model.open.count, 11)
		XCTAssertEqual(model.archived.count, 2)
	}

	func testQueryFiltersBothGroups() {
		let store = storeFor(missions: [
			missi(number: 30, name: "Refund flow edge cases", state: .blocked),
			missi(number: 31, name: "Search index rebuild", state: .running),
			missi(
				number: 29, name: "Refund policy draft", state: .closed,
				closedAt: base.addingTimeInterval(-86400), disposition: .merged),
		])
		let model = NavigatorModel.make(store: store, query: "refund")
		XCTAssertEqual(model.open.map(\.number), [30])
		XCTAssertEqual(model.archived.map(\.number), [29])
	}

	func testNoMatchKeepsWorkspacesButEmptiesMissions() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "zzz-no-such-mission")
		XCTAssertTrue(model.open.isEmpty)
		XCTAssertTrue(model.archived.isEmpty)
		XCTAssertEqual(model.workspaces.count, store.workspaces.count)
	}

	func testSingleMachineGivesNilMachines() async throws {
		let store = try await fixtureStore()
		XCTAssertNil(NavigatorModel.make(store: store, query: "").machines)
	}

	func testTwoRootsOnTwoMachinesGiveTwoEntries() {
		let store = storeFor(
			missions: [],
			roots: [
				WorkspaceRoot(machineId: "m1", path: "/vol/a"),
				WorkspaceRoot(machineId: "m2", path: "/vol/b"),
			])
		let machines = NavigatorModel.make(store: store, query: "").machines
		XCTAssertEqual(machines?.map(\.id), ["m1", "m2"])
	}

	/// BRIEF: status is never carried by colour alone. The machine rows the
	/// overlay draws read the word beside the dot, and the dot only repeats
	/// it. Asserted on `NavigatorOverlay.sections`, which is what `body`
	/// renders: dropping the trailing word from the row would empty `status`
	/// here.
	func testMachineRowsCarryOnlineAndOfflineText() throws {
		let store = storeFor(
			missions: [],
			roots: [
				WorkspaceRoot(machineId: "m1", path: "/vol/a"),
				WorkspaceRoot(machineId: "m2", path: "/vol/b"),
			])
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(model.onlineMachineId, "m1", "the machine the app is connected to")
		let rows = try machineRows(overlay(model).sections(query: ""))
		// The connected machine carries its recorded name; a root on any other
		// machine surfaces under its id.
		XCTAssertEqual(rows.map(\.id), ["m1", "m2"])
		XCTAssertEqual(rows.map(\.name), ["machine", "m2"])
		XCTAssertEqual(rows.map(\.status), ["Online", "Offline"])
		XCTAssertEqual(rows.map(\.tint), [Theme.mint, Theme.textSecondary])
		for row in rows {
			XCTAssertFalse(row.status.isEmpty, "the dot never carries the state alone")
		}
	}

	/// An unreachable Node cannot answer for its own machine either.
	func testEveryMachineReadsOfflineWhenTheNodeIsUnreachable() throws {
		let store = storeFor(
			missions: [],
			roots: [
				WorkspaceRoot(machineId: "m1", path: "/vol/a"),
				WorkspaceRoot(machineId: "m2", path: "/vol/b"),
			])
		store.setNodeOffline(true)
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertNil(model.onlineMachineId)
		let rows = try machineRows(overlay(model).sections(query: ""))
		XCTAssertEqual(rows.map(\.status), ["Offline", "Offline"])
	}

	/// The headers the overlay draws, in draw order, in the type it draws
	/// them in: BRIEF's section header, 9/700 uppercase with 0.08 em
	/// letter-spacing. `NavigatorOverlay.body` renders `sections(query:)`
	/// header-then-rows and nothing else, so inlining a different font or
	/// dropping the tracking means changing `NavigatorSection.Header`, which
	/// fails here.
	func testSectionsCarryTheBriefHeaderType() async throws {
		let store = try await fixtureStore()
		let sections = overlay(NavigatorModel.make(store: store, query: "")).sections(query: "")
		XCTAssertEqual(
			sections.map(\.header.title), ["WORKSPACES", "MISSIONS", "OPEN", "ARCHIVED"],
			"one machine, so no MACHINE header")
		for section in sections {
			XCTAssertEqual(section.header.title, section.header.title.uppercased())
			// One header token at every level: BRIEF names exactly one, and
			// the board draws subgroup heads in the same `.sec` class.
			XCTAssertEqual(section.header.font, Theme.text(9, .bold))
		}
		XCTAssertEqual(NavigatorSection.Header.size, 9)
		XCTAssertEqual(NavigatorSection.Header.weight, .bold)
		XCTAssertEqual(NavigatorSection.Header.tracking, 0.72, accuracy: 1e-9)
		// Rows clear the shell's 26 pt hit floor.
		XCTAssertGreaterThanOrEqual(Theme.Metric.minHitHeight, 26)
	}

	/// PAPER-SPINE Revision 2 lists OPEN and ARCHIVED as groups *under*
	/// MISSIONS. Drawn flat — same indent, the same 12 pt gap — MISSIONS
	/// reads as a header floating above another header. The subgroup is
	/// subordinate on the two counts the drawn value carries and BRIEF
	/// allows: an indent and a tighter gap to the header above. The type is
	/// BRIEF's one section-header token at both levels.
	func testMissionGroupsAreDrawnUnderTheMissionsHeader() async throws {
		let store = try await fixtureStore()
		let sections = overlay(NavigatorModel.make(store: store, query: "")).sections(query: "")
		let byTitle = Dictionary(uniqueKeysWithValues: sections.map { ($0.header.title, $0) })
		let missions = try XCTUnwrap(byTitle["MISSIONS"])
		let open = try XCTUnwrap(byTitle["OPEN"])
		let archived = try XCTUnwrap(byTitle["ARCHIVED"])
		// MISSIONS keeps BRIEF's one section-header token.
		XCTAssertEqual(missions.header.level, .section)
		XCTAssertEqual(missions.header.font, Theme.text(9, .bold))
		XCTAssertEqual(missions.indent, 0)
		XCTAssertEqual(missions.topGap, NavigatorStyle.sectionGap)
		for group in [open, archived] {
			XCTAssertEqual(group.header.level, .group)
			XCTAssertEqual(group.header.font, missions.header.font, "one header token")
			XCTAssertGreaterThan(group.indent, missions.indent)
			XCTAssertLessThan(group.topGap, missions.topGap)
		}
		// The header type itself is unchanged: same size, same tracking.
		XCTAssertEqual(NavigatorSection.Header.size, 9)
		XCTAssertEqual(NavigatorSection.Header.tracking, 0.72, accuracy: 1e-9)
	}

	/// T9.10 step 2 and PAPER-SPINE Revision 2: WORKSPACES, MACHINE when the
	/// model carries one, then MISSIONS as the OPEN and ARCHIVED groups.
	func testMachineHeaderAppearsOnlyWithTwoMachines() {
		let store = storeFor(
			missions: [missi(number: 1, name: "Checkout rollout", state: .running)],
			roots: [
				WorkspaceRoot(machineId: "m1", path: "/vol/a"),
				WorkspaceRoot(machineId: "m2", path: "/vol/b"),
			])
		let sections = overlay(NavigatorModel.make(store: store, query: "")).sections(query: "")
		XCTAssertEqual(sections.map(\.header.title), ["WORKSPACES", "MACHINE", "MISSIONS", "OPEN"])
	}

	/// An empty group is not drawn, and MISSIONS goes with them: the design
	/// has no placeholder row.
	func testEmptyMissionGroupsDropTheirHeadersAndMissions() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(
			overlay(model).sections(query: "zzz-no-such-mission").map(\.header.title),
			["WORKSPACES"])
		// A query that only matches open missions drops ARCHIVED alone.
		let openOnly = overlay(NavigatorModel.make(store: store, query: ""))
			.sections(query: "#12")
		XCTAssertEqual(openOnly.map(\.header.title), ["WORKSPACES", "MISSIONS", "OPEN"])
	}

	/// The selected workspace row is the one the overlay marks. The semibold
	/// name and the `.isSelected` trait keep the state off colour alone.
	func testSelectedWorkspaceIsMarked() throws {
		let store = storeFor(missions: [])
		let workspace = try XCTUnwrap(store.workspaces.first)
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(model.selectedWorkspaceId, workspaceId)
		XCTAssertTrue(model.isSelected(workspace))
		let rows = try workspaceRows(overlay(model).sections(query: ""))
		XCTAssertEqual(rows.map(\.name), ["widget"])
		XCTAssertEqual(rows.map(\.monogram), ["W"])
		XCTAssertEqual(rows.map(\.isSelected), [true])
		store.setCurrentWorkspace(otherWorkspaceId)
		let after = NavigatorModel.make(store: store, query: "")
		XCTAssertFalse(after.isSelected(workspace))
		let afterRows = try workspaceRows(overlay(after).sections(query: ""))
		XCTAssertEqual(afterRows.map(\.isSelected), [false])
		XCTAssertEqual(afterRows.map(\.fill), [Color.clear])
	}

	/// The navigator board's values: the selected row is `--surface-sel`
	/// (white 7.5 %) and its monogram tile lifts to `.mono-sq.on` (white
	/// 10 %), so the tile stays readable against the row rather than sinking
	/// into it. Revision 3's white 14 % lozenge is the selected segment of a
	/// *control* on glass and does not apply to a list row. Asserted on the
	/// fills the drawn row carries.
	func testSelectedRowAndMonogramCarryTheBoardFills() throws {
		let store = storeFor(missions: [])
		let rows = try workspaceRows(
			overlay(NavigatorModel.make(store: store, query: "")).sections(query: ""))
		let selected = try XCTUnwrap(rows.first { $0.isSelected })
		XCTAssertEqual(selected.fill, Color(.sRGB, white: 1, opacity: 0.075))
		XCTAssertEqual(selected.fill, NavigatorStyle.selectedRowFill)
		XCTAssertNotEqual(selected.fill, Theme.Glass.selectedSegment, "not a control segment")
		XCTAssertEqual(selected.monogramFill, Color(.sRGB, white: 1, opacity: 0.10))
		XCTAssertNotEqual(
			selected.monogramFill, selected.fill, "the tile still reads against the row")
		XCTAssertNotEqual(selected.monogramFill, Theme.subtleSurface)
		store.setCurrentWorkspace(otherWorkspaceId)
		let unselected = try XCTUnwrap(
			workspaceRows(overlay(NavigatorModel.make(store: store, query: "")).sections(query: ""))
				.first)
		XCTAssertEqual(unselected.fill, Color.clear)
		XCTAssertEqual(unselected.monogramFill, Theme.subtleSurface)
	}

	func testNoLeaderRowAndNoGroupCounts() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		// The model carries workspaces with the selected one marked, the
		// conditional machines with the reachable one marked, and the two
		// mission groups only: no leader row, no counts.
		let labels = Mirror(reflecting: model).children.compactMap(\.label).sorted()
		XCTAssertEqual(
			labels,
			["archived", "machines", "onlineMachineId", "open", "selectedWorkspaceId", "workspaces"])
		let firstRow = try XCTUnwrap(model.open.first)
		XCTAssertEqual(
			Mirror(reflecting: firstRow).children.compactMap(\.label).sorted(),
			["id", "name", "number", "stateLabel", "tint"])
		let missionIds = Set(store.missions.map(\.id))
		for row in model.open + model.archived {
			XCTAssertTrue(missionIds.contains(row.id))
			XCTAssertFalse(row.stateLabel.isEmpty)
		}
	}

	func testOpenRowsCarryTextStateLabels() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		let byNumber = Dictionary(uniqueKeysWithValues: model.open.map { ($0.number, $0.stateLabel) })
		XCTAssertEqual(byNumber[2], "Blocked")
		XCTAssertEqual(byNumber[5], "Failed")
		XCTAssertEqual(byNumber[3], "Ready to close")
		XCTAssertEqual(byNumber[4], "Merged, not closed")
		XCTAssertEqual(byNumber[1], "Running")
	}

	func testArchivedRowsCarryDispositionLabels() {
		let store = storeFor(missions: [
			missi(
				number: 6, name: "Password reset rate limits", state: .closed,
				closedAt: base.addingTimeInterval(-3 * 86400), disposition: .merged),
			missi(
				number: 7, name: "Docs site build cache", state: .closed,
				closedAt: base.addingTimeInterval(-2 * 86400), disposition: .abandoned),
			missi(number: 8, name: "Slack digest bot", state: .closed),
		])
		let byNumber = Dictionary(uniqueKeysWithValues: NavigatorModel.make(store: store, query: "").archived.map {
			($0.number, $0.stateLabel)
		})
		XCTAssertEqual(byNumber[6], "Merged")
		XCTAssertEqual(byNumber[7], "Abandoned")
		XCTAssertEqual(byNumber[8], "Archived")
	}

	func testArchivedNilClosedAtSortsLast() {
		let store = storeFor(missions: [
			missi(number: 8, name: "Undated", state: .closed),
			missi(
				number: 6, name: "Older", state: .closed,
				closedAt: base.addingTimeInterval(-3 * 86400), disposition: .merged),
			missi(
				number: 7, name: "Newer", state: .closed,
				closedAt: base.addingTimeInterval(-86400), disposition: .merged),
		])
		XCTAssertEqual(NavigatorModel.make(store: store, query: "").archived.map(\.number), [7, 6, 8])
	}

	func testSelectCallsOnSelectAndClosesOverlay() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		shell.navigatorVisible = true
		var selected: Selection?
		let overlay = NavigatorOverlay(
			model: NavigatorModel.make(store: store, query: ""),
			shell: shell,
			onSelect: { selected = $0 })
		let row = try XCTUnwrap(NavigatorModel.make(store: store, query: "").open.first)
		overlay.select(row)
		XCTAssertEqual(selected, .mission(row.id))
		XCTAssertFalse(shell.navigatorVisible)
	}

	/// The mission rows the overlay draws carry the number, the name and the
	/// text state label; the tint only repeats the label.
	func testDrawnMissionRowsCarryNumberNameAndStateLabel() async throws {
		let store = try await fixtureStore()
		let model = NavigatorModel.make(store: store, query: "")
		let sections = overlay(model).sections(query: "")
		let open = try XCTUnwrap(sections.first { $0.header.title == "OPEN" })
		let rows: [NavigatorModel.Row] = open.rows.compactMap {
			if case .mission(let row) = $0 { return row }
			return nil
		}
		XCTAssertEqual(rows.map(\.number), model.open.map(\.number))
		for row in rows {
			XCTAssertFalse(row.name.isEmpty)
			XCTAssertFalse(row.stateLabel.isEmpty)
		}
	}

	/// The navigator "lists workspaces … as a jump list" (MANIFESTO.md
	/// "Desktop information architecture"), so a workspace row switches the
	/// workspace: the store takes the selection, the chat returns to that
	/// workspace's leader, and the overlay closes — the same shape as a
	/// mission row.
	func testWorkspaceRowSwitchesTheWorkspaceAndClosesTheOverlay() throws {
		let store = twoWorkspaceStore()
		let shell = ShellState()
		shell.showNavigator()
		shell.select(.mission("m-1"))
		let panel = NavigatorOverlay(
			model: NavigatorModel.make(store: store, query: ""),
			shell: shell,
			onSelect: { shell.select($0) },
			onSelectWorkspace: { NavigatorOverlay.selectWorkspace($0, store: store, shell: shell) })
		let rows = try workspaceRows(panel.sections(query: ""))
		XCTAssertEqual(rows.map(\.isSelected), [true, false])
		let other = try XCTUnwrap(rows.last)
		panel.select(other)
		XCTAssertEqual(store.currentWorkspaceId, other.id)
		// The mission that was selected belongs to the workspace being left.
		XCTAssertEqual(shell.selection, .leader)
		XCTAssertFalse(shell.navigatorVisible)
		// The panel redrawn from the store marks the row that was used.
		let after = try workspaceRows(
			overlay(NavigatorModel.make(store: store, query: "")).sections(query: ""))
		XCTAssertEqual(after.map(\.isSelected), [false, true])
	}

	/// The toolbar and the navigator name the same workspace, including when
	/// the selected one has no leader record — the case where deriving the
	/// toolbar's workspace from `store.leader` named the other one.
	func testToolbarAndNavigatorAgreeOnTheSelectedWorkspace() throws {
		let store = twoWorkspaceStore()
		let shell = ShellState()
		let panel = NavigatorOverlay(
			model: NavigatorModel.make(store: store, query: ""), shell: shell,
			onSelect: { _ in },
			onSelectWorkspace: { NavigatorOverlay.selectWorkspace($0, store: store, shell: shell) })
		let other = try XCTUnwrap(workspaceRows(panel.sections(query: "")).last)
		XCTAssertNil(store.leaders[other.id], "the second workspace has no leader record")
		panel.select(other)
		XCTAssertEqual(
			ToolbarModel.make(store: store, shell: shell).selectedWorkspaceId,
			NavigatorModel.make(store: store, query: "").selectedWorkspaceId)
		XCTAssertEqual(ToolbarModel.make(store: store, shell: shell).selectedWorkspaceId, other.id)
	}

	/// The Node answers `snapshot` with every open workspace's missions (the
	/// app asks with no `workspaceId`, and a second workspace opens the
	/// moment any `neta` command runs in another repo), and mission numbers
	/// are per workspace. Unfiltered, OPEN interleaves two workspaces and
	/// two rows read `#1`. The panel is the selected workspace's inbox:
	/// PAPER-SPINE Revision 2's navigator board, MANIFESTO.md "Desktop
	/// information architecture".
	func testMissionsAreTheSelectedWorkspacesOnly() throws {
		let store = twoWorkspaceStore(otherMissions: [
			missi(
				number: 1, name: "Ledger import", state: .running,
				workspaceId: otherWorkspaceId),
			missi(
				number: 2, name: "Ledger archive", state: .closed,
				closedAt: base.addingTimeInterval(-86400), disposition: .merged,
				workspaceId: otherWorkspaceId),
		])
		XCTAssertEqual(store.missions.count, 3, "the snapshot holds both workspaces")
		let model = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(model.open.map(\.name), ["Checkout rollout"])
		XCTAssertTrue(model.archived.isEmpty, "the other workspace's archive is not ours")
		for row in model.open + model.archived {
			XCTAssertEqual(store.missionsById[row.id]?.workspaceId, workspaceId)
		}
		// The panel draws what the model carries, so the rows agree.
		let sections = overlay(model).sections(query: "")
		XCTAssertEqual(sections.map(\.header.title), ["WORKSPACES", "MISSIONS", "OPEN"])
	}

	/// Switching the workspace changes the mission list, not only the
	/// MACHINE section: the rows are the new workspace's, with its own
	/// numbers.
	func testSwitchingWorkspaceChangesTheMissionList() throws {
		let store = twoWorkspaceStore(otherMissions: [
			missi(
				number: 1, name: "Ledger import", state: .running,
				workspaceId: otherWorkspaceId),
			missi(
				number: 2, name: "Ledger archive", state: .closed,
				closedAt: base.addingTimeInterval(-86400), disposition: .merged,
				workspaceId: otherWorkspaceId),
		])
		let shell = ShellState()
		let panel = NavigatorOverlay(
			model: NavigatorModel.make(store: store, query: ""), shell: shell,
			onSelect: { _ in },
			onSelectWorkspace: { NavigatorOverlay.selectWorkspace($0, store: store, shell: shell) })
		XCTAssertEqual(NavigatorModel.make(store: store, query: "").open.map(\.name), ["Checkout rollout"])
		let other = try XCTUnwrap(workspaceRows(panel.sections(query: "")).last)
		panel.select(other)
		let after = NavigatorModel.make(store: store, query: "")
		XCTAssertEqual(after.open.map(\.name), ["Ledger import"])
		XCTAssertEqual(after.archived.map(\.name), ["Ledger archive"])
		// Both workspaces number their missions from 1; only one #1 is drawn.
		XCTAssertEqual(after.open.map(\.number), [1])
		XCTAssertEqual(
			try workspaceRows(overlay(after).sections(query: "")).map(\.isSelected), [false, true])
	}

	/// `#refund` searches the stripped string, so it finds what `refund`
	/// finds. T9.10 defines `#`+digits only; a `#` in front of a word used to
	/// return an empty panel.
	func testHashBeforeAWordSearchesTheName() {
		let store = storeFor(missions: [
			missi(number: 30, name: "Refund flow edge cases", state: .blocked),
			missi(number: 31, name: "Search index rebuild", state: .running),
		])
		XCTAssertEqual(NavigatorModel.make(store: store, query: "#refund").open.map(\.number), [30])
		XCTAssertEqual(
			NavigatorModel.make(store: store, query: "#refund").open.map(\.number),
			NavigatorModel.make(store: store, query: "refund").open.map(\.number))
	}

	// MARK: - Helpers

	/// Two workspaces, only the first with a leader record: the shape that
	/// separates the selection from anything derived from the leader. The
	/// Node lists every open workspace's missions in one snapshot, so
	/// `otherMissions` is how a test puts the second workspace's work in the
	/// same picture.
	private func twoWorkspaceStore(otherMissions: [Mission] = []) -> Store {
		let store = storeFor(missions: [missi(number: 1, name: "Checkout rollout", state: .running)])
		let snapshot = Snapshot(
			machine: Machine(id: "m1", name: "machine", createdAt: base),
			workspaces: store.workspaces + [Workspace(
				id: otherWorkspaceId, kind: .git, name: "other",
				remote: "git@github.com:acme/other.git",
				roots: [WorkspaceRoot(machineId: "m1", path: "/vol/b")],
				createdAt: base)],
			leaders: store.leaders.values.sorted { $0.workspaceId < $1.workspaceId },
			missions: store.missions + otherMissions, hasOlder: false, agents: [],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base)
		store.replace(snapshot: snapshot)
		return store
	}

	/// The overlay under test. `sections(query:)` is what `body` renders, so
	/// the assertions above sit on the drawn structure, not on free-floating
	/// constants.
	///
	/// The limit of that seam, recorded so a green suite is not read as more
	/// than it is: these tests prove the *payload* the panel draws from —
	/// headers, levels, indents, row text, fills. SwiftUI offers no view
	/// introspection in this package, so a body that stopped rendering a value
	/// it is handed (dropping `Text(row.status)`, or inlining a font instead of
	/// rendering `section.header`) would still pass. Mutating the payload or
	/// the statics does fail here. Closing the rest needs a snapshot or
	/// accessibility-tree check, which this target cannot run.
	private func overlay(_ model: NavigatorModel) -> NavigatorOverlay {
		NavigatorOverlay(model: model, shell: ShellState(), onSelect: { _ in })
	}

	private func workspaceRows(_ sections: [NavigatorSection]) throws -> [WorkspaceRow] {
		let section = try XCTUnwrap(sections.first { $0.header.title == "WORKSPACES" })
		return section.rows.compactMap {
			if case .workspace(let row) = $0 { return row }
			return nil
		}
	}

	private func machineRows(_ sections: [NavigatorSection]) throws -> [MachineRow] {
		let section = try XCTUnwrap(sections.first { $0.header.title == "MACHINE" })
		return section.rows.compactMap {
			if case .machine(let row) = $0 { return row }
			return nil
		}
	}

	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	private let workspaceId = "git:github.com/acme/widget"
	private let otherWorkspaceId = "git:github.com/acme/other"

	/// The recorded fixture snapshot in a store: the only data tests use,
	/// except the synthetic mission/workspace sets below.
	private func fixtureStore() async throws -> Store {
		let client = FixtureNodeClient()
		let snapshot = try await client.snapshot()
		let store = Store()
		store.replace(snapshot: snapshot)
		return store
	}

	private func missi(
		number: Int,
		name: String,
		state: MissionState,
		closedAt: Date? = nil,
		disposition: Disposition? = nil,
		workspaceId: WorkspaceId? = nil
	) -> Mission {
		let workspaceId = workspaceId ?? self.workspaceId
		return Mission(
			id: "m-\(workspaceId)-\(number)", number: number, workspaceId: workspaceId, machineId: "m1",
			name: name, objective: "objective \(number)", changes: [], lead: .leader,
			agentIds: [], access: .readWrite, worktree: nil, state: state, attention: nil,
			createdAt: base.addingTimeInterval(Double(number) * 3600),
			closedAt: closedAt, disposition: disposition, closeReason: nil,
			integration: nil, continuesMissionId: nil)
	}

	/// A store with exactly `missions` and one workspace, for query and
	/// machine-menu rules the fixture cannot express.
	private func storeFor(
		missions: [Mission],
		roots: [WorkspaceRoot]? = nil,
		machineId: MachineId = "m1"
	) -> Store {
		let store = Store()
		store.replace(snapshot: Snapshot(
			machine: Machine(id: machineId, name: "machine", createdAt: base),
			workspaces: [Workspace(
				id: workspaceId, kind: .git, name: "widget",
				remote: "git@github.com:acme/widget.git",
				roots: roots ?? [WorkspaceRoot(machineId: machineId, path: "/vol/a")],
				createdAt: base)],
			leaders: [Leader(
				workspaceId: workspaceId, machineId: machineId,
				name: "Halden",
				sessionId: "s-leader", provider: "fake", model: "test-model",
				mode: .lead, modeSince: base, modeActiveMs: 0,
				activeMissionId: nil, state: .idle)],
			missions: missions, hasOlder: false, agents: [],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base))
		return store
	}
}
