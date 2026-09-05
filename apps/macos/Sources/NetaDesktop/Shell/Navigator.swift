import Foundation
import SwiftUI

/// The auto-hiding jump list (09-desktop-shell T9.10): workspaces, the
/// conditional machine level, and missions as OPEN / ARCHIVED rows.
///
/// `NavigatorModel` is a value snapshot of what the overlay shows: the
/// workspaces with the selected one marked, the machine menu only when it
/// matters, and the mission rows already filtered by the query and sorted.
/// Views own nothing: the overlay reads the model and calls back into the
/// shell, which owns overlay visibility.
public struct NavigatorModel: Equatable, Sendable {
	public struct Row: Equatable, Identifiable, Sendable {
		public let id: Ulid
		public let number: Int
		public let name: String
		public let stateLabel: String
		public let tint: Color
	}

	public let workspaces: [Workspace]
	/// The workspace the shell is showing, from `Store.currentWorkspaceId`.
	/// Its row draws the selected state; never derived from the leader,
	/// which follows the selection and would be circular.
	public let selectedWorkspaceId: WorkspaceId?
	/// Nil when the selected workspace has roots on one machine: the machine
	/// level stays hidden, per MANIFESTO.md "Desktop information
	/// architecture" (the same rule as `ToolbarModel`).
	public let machines: [Machine]?
	/// The one machine this app is talking to, when the Node is reachable.
	/// Every other machine in `machines` is a root the Node knows about but
	/// cannot answer for, so it reads `Offline`.
	public let onlineMachineId: MachineId?
	/// The connected machine record, when the Node is reachable. Workspace
	/// rows use it directly even when the selected workspace has one root
	/// (and therefore no legacy machine chooser).
	public let connectedMachine: Machine?
	/// Open missions, number descending.
	public let open: [Row]
	/// Closed missions, `closedAt` descending.
	public let archived: [Row]

	/// Snapshots the navigator from the store picture, filtered by `query`:
	/// a leading `#` or digits match the number prefix, anything else is a
	/// case-insensitive substring of the name; an empty query returns
	/// everything.
	///
	/// Both mission groups are the *selected workspace's* missions and no
	/// one else's. The Node answers `snapshot` with every open workspace's
	/// missions (the app asks with no `workspaceId`), and mission numbers are
	/// per workspace, so an unfiltered panel interleaves two workspaces and
	/// shows two rows reading `#1`. One workspace's inbox is what the design
	/// draws (PAPER-SPINE Revision 2's navigator board, BRIEF "All 14 open
	/// missions listed" for one workspace) and what MANIFESTO.md "Desktop
	/// information architecture" describes.
	@MainActor
	public static func make(store: Store, query: String) -> NavigatorModel {
		let selected = selectedWorkspaceId(in: store)
		let missions = store.missions.filter { $0.workspaceId == selected }
		return NavigatorModel(
			workspaces: store.workspaces,
			selectedWorkspaceId: selected,
			machines: machines(in: store, selected: selected),
			onlineMachineId: store.nodeOffline ? nil : store.machine?.id,
			connectedMachine: store.nodeOffline ? nil : store.machine,
			open: missions
				.filter { $0.state != .closed && matches(number: $0.number, name: $0.name, query: query) }
				.sorted { $0.number > $1.number }
				.map(row(for:)),
			archived: missions
				.filter { $0.state == .closed && matches(number: $0.number, name: $0.name, query: query) }
				.sorted { ($0.closedAt ?? .distantPast) > ($1.closedAt ?? .distantPast) }
				.map(row(for:)))
	}

	/// True for the workspace row that draws the selected state.
	public func isSelected(_ workspace: Workspace) -> Bool {
		workspace.id == selectedWorkspaceId
	}

	/// `Online` or `Offline` — the word, always beside the dot. Status is
	/// never carried by colour alone.
	public func machineLabel(for machine: Machine) -> String {
		machine.id == onlineMachineId ? "Online" : "Offline"
	}

	/// The dot's colour, which repeats what the label already says.
	public func machineTint(for machine: Machine) -> Color {
		machine.id == onlineMachineId ? Theme.mint : Theme.textSecondary
	}

	@MainActor public func onlineRoots(for workspace: Workspace) -> [MachineRow] {
		guard let machine = connectedMachine,
			workspace.roots.contains(where: { $0.machineId == machine.id })
		else { return [] }
		return [MachineRow(id: machine.id, name: machine.name, status: "Online", tint: Theme.mint)]
	}

	/// The jump predicate, shared with the overlay's local filtering: empty
	/// matches everything; a leading `#` is stripped and a remaining
	/// all-digit query matches the number prefix; anything else is a
	/// case-insensitive substring of the name.
	///
	/// The name search reads the *stripped* string, so `#refund` finds what
	/// `refund` finds. T9.10 only defines `#`+digits, but a `#` typed in
	/// front of a word is a plausible query and returning an empty panel for
	/// it is a worse answer than searching the word.
	public static func matches(number: Int, name: String, query: String) -> Bool {
		let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return true }
		var stripped = trimmed
		if stripped.hasPrefix("#") { stripped.removeFirst() }
		stripped = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !stripped.isEmpty else { return true }
		if stripped.allSatisfy(\.isNumber) {
			return String(number).hasPrefix(stripped)
		}
		return name.range(of: stripped, options: [.caseInsensitive, .diacriticInsensitive]) != nil
	}

	// MARK: - Private

	private static func row(for mission: Mission) -> Row {
		if mission.state == .closed {
			return Row(
				id: mission.id, number: mission.number, name: mission.name,
				stateLabel: CanvasStyle.label(for: mission.disposition),
				tint: Theme.textSecondary)
		}
		return Row(
			id: mission.id, number: mission.number, name: mission.name,
			stateLabel: MissionBarItem.label(for: mission.state),
			tint: stateColor(for: mission.state))
	}

	/// The shell's selected workspace: `Store.currentWorkspaceId`, falling
	/// back to the first listed workspace before the first snapshot lands.
	@MainActor
	private static func selectedWorkspaceId(in store: Store) -> WorkspaceId? {
		store.currentWorkspaceId ?? store.workspaces.first?.id
	}

	/// The selected workspace's machines, mirroring `ToolbarModel.make`:
	/// the store only knows the machine it is connected to, so a root on
	/// any other machine surfaces under its id with the selected
	/// workspace's creation date.
	@MainActor
	private static func machines(in store: Store, selected: WorkspaceId?) -> [Machine]? {
		let workspaces = store.workspaces
		let selectedWorkspace = workspaces.first(where: { $0.id == selected })
		var machineIds: [MachineId] = []
		for root in selectedWorkspace?.roots ?? [] where !machineIds.contains(root.machineId) {
			machineIds.append(root.machineId)
		}
		machineIds.sort()
		guard machineIds.count > 1 else { return nil }
		return machineIds.map { id in
			if let known = store.machine, known.id == id {
				return known
			}
			return Machine(
				id: id, name: id,
				createdAt: selectedWorkspace?.createdAt ?? Date(timeIntervalSince1970: 0))
		}
	}
}

/// Restrained semantic color to go with the text label, never alone.
/// Archived rows use secondary; this covers the open states.
private func stateColor(for state: MissionState) -> Color {
	switch state {
	case .blocked:
		return Theme.amber
	case .failed:
		return Theme.red
	case .readyToClose, .mergedNotClosed:
		return Theme.blue
	case .running:
		return Theme.mint
	case .closed:
		return Theme.textSecondary
	}
}

/// The overlay's view metrics. Everything the panel *draws* goes through
/// `NavigatorSection`, not through here.
public enum NavigatorStyle {
	/// The status dot beside a machine name.
	public static let dot: CGFloat = 6
	/// The workspace monogram square, 18 pt with 9/700 lettering — the
	/// navigator board's `.mono-sq`.
	public static let monogram: CGFloat = 18
	/// Row corner radius for the selected fill and the hit shape.
	public static let rowRadius: CGFloat = 7
	/// The selected list row's fill: BRIEF's selected subtle surface, white
	/// 7.5 % (the board's `--surface-sel`). Revision 3's white 14 % lozenge
	/// is for the selected *segment of a control* on glass (Lead|Lead++, the
	/// model picker); a list row is not one of those.
	public static let selectedRowFill = Color(.sRGB, white: 1, opacity: 0.075)
	/// The monogram tile on the selected row, lifted to white 10 % with
	/// brighter lettering (the board's `.mono-sq.on`), so the tile does not
	/// sink into the row fill that now sits behind it.
	public static let selectedMonogramFill = Color(.sRGB, white: 1, opacity: 0.10)
	/// The gap above a top-level section (WORKSPACES, MACHINE, MISSIONS).
	public static let sectionGap: CGFloat = 12
	/// The gap above a subgroup (OPEN, ARCHIVED). Tighter than
	/// `sectionGap` so the group reads as belonging to the header above it
	/// rather than floating beside it.
	public static let groupGap: CGFloat = 4
	/// How far a subgroup's header and rows sit inside their parent section.
	public static let groupIndent: CGFloat = 10
}

/// One drawn row of the panel, carrying the text the overlay puts on screen.
///
/// The overlay has exactly one row builder per case and reads the strings from
/// the payload, so a row's visible text cannot drift from what
/// `NavigatorOverlay.sections(query:)` reports without the payload changing
/// with it. That is the seam the tests use: SwiftUI offers no view
/// introspection here, so the assertions have to sit on the value the view
/// renders.
public enum NavigatorRow: Equatable, Identifiable, Sendable {
	case workspace(WorkspaceRow)
	case machine(MachineRow)
	case mission(NavigatorModel.Row)

	public var id: String {
		switch self {
		case .workspace(let row): return "w:\(row.id)"
		case .machine(let row): return "m:\(row.id)"
		case .mission(let row): return "x:\(row.id)"
		}
	}
}

/// A workspace row: monogram, name, and whether it draws the selected state.
public struct WorkspaceRow: Equatable, Identifiable, Sendable {
	public let id: WorkspaceId
	public let monogram: String
	public let name: String
	public let isSelected: Bool
	public let machines: [MachineRow]

	/// The row's fill: the navigator board's `--surface-sel`, white 7.5 %.
	/// The semibold name, the lifted monogram tile and the `.isSelected`
	/// trait carry the state alongside it, so nothing rests on the fill
	/// alone.
	public var fill: Color { isSelected ? NavigatorStyle.selectedRowFill : .clear }

	/// The monogram tile's fill: the board lifts it to white 10 % on the
	/// selected row rather than leaving it at the 4.5 % subtle surface, which
	/// against a 7.5 % row fill would read as a hole.
	public var monogramFill: Color {
		isSelected ? NavigatorStyle.selectedMonogramFill : Theme.subtleSurface
	}
}

/// A machine row: the name, the word `Online`/`Offline` beside the dot, and
/// the dot's tint, which only repeats what the word already says.
public struct MachineRow: Equatable, Identifiable, Sendable {
	public let id: MachineId
	public let name: String
	public let status: String
	public let tint: Color
}

/// One drawn group of the panel, in draw order: a header and its rows.
///
/// `NavigatorOverlay.body` renders exactly the list from
/// `sections(query:)` — header, then rows, nothing else — so building the
/// list in a test is the closest this package gets to reading the panel.
public struct NavigatorSection: Equatable, Identifiable, Sendable {
	/// A section header, which draws itself in BRIEF's section header type:
	/// 9/700 uppercase with 0.08 em letter-spacing, secondary. The overlay
	/// renders this value rather than restating the type, so the drawn header
	/// is defined on the value a test can build.
	///
	/// PAPER-SPINE Revision 2 lists OPEN and ARCHIVED as groups *under*
	/// MISSIONS, so a header carries its `Level`. Both levels draw in BRIEF's
	/// one section-header token — the board sets subgroup heads in the same
	/// `.sec` class as section heads — and the nesting is carried by the
	/// indent and the tighter gap above the group, not by a second weight.
	public struct Header: View, Equatable, Sendable {
		/// Where the header sits in the panel's one level of nesting.
		public enum Level: Equatable, Sendable {
			/// A top-level section: WORKSPACES, MACHINE, MISSIONS.
			case section
			/// A group under the section above it: OPEN, ARCHIVED.
			case group
		}

		public static let size: CGFloat = 9
		/// BRIEF's one section-header weight, drawn at every level.
		public static let weight: Font.Weight = .bold
		/// BRIEF's 0.08 em at `size`.
		public static let tracking: CGFloat = size * 0.08

		public static let workspaces = Header("WORKSPACES")
		public static let machine = Header("MACHINE")
		/// T9.10 step 2 and PAPER-SPINE Revision 2: the missions are listed
		/// under MISSIONS, as the OPEN and ARCHIVED groups.
		public static let missions = Header("MISSIONS")
		public static let open = Header("OPEN", level: .group)
		public static let archived = Header("ARCHIVED", level: .group)

		public let title: String
		public let level: Level

		public init(_ title: String, level: Level = .section) {
			self.title = title.uppercased()
			self.level = level
		}

		public var font: Font {
			Theme.text(Self.size, Self.weight)
		}

		public var body: some View {
			Text(title)
				.font(font)
				.tracking(Self.tracking)
				.foregroundStyle(Theme.textSecondary)
		}
	}

	public let header: Header
	/// The rows under the header. Empty only for MISSIONS, which labels the
	/// OPEN and ARCHIVED groups that follow it.
	public let rows: [NavigatorRow]

	public var id: String { header.title }

	/// The gap above this section, unless it is the first drawn: a group sits
	/// tight under the header it belongs to, a section stands clear of the one
	/// before it.
	public var topGap: CGFloat {
		header.level == .group ? NavigatorStyle.groupGap : NavigatorStyle.sectionGap
	}

	/// How far this section's header and rows sit inside the panel: a group is
	/// indented under its parent section, everything else is flush.
	public var indent: CGFloat {
		header.level == .group ? NavigatorStyle.groupIndent : 0
	}
}

/// The floating project navigator: project actions followed by searchable
/// workspace rows. A workspace nests the currently connected machine only
/// when that workspace has a root on it; unknown and offline machines are
/// omitted.
///
/// The panel overlays the canvas and moves nothing. Typing filters the
/// model's rows with the same predicate as `NavigatorModel.make`. It is an
/// auto-hide overlay: the pointer leaving it schedules the hide
/// (`ShellState.navigatorPointerExited`), Escape hides it at once, and a
/// canvas click hides it through `ShellState.canvasClicked`.
///
/// Rows jump: a mission row calls `onSelect(.mission(id))`, a workspace row
/// calls `onSelectWorkspace(id)` — the navigator "lists workspaces … as a
/// jump list" (MANIFESTO.md "Desktop information architecture"), so its
/// workspace rows are the caller `Store.setCurrentWorkspace` documents.
/// `selectWorkspace(_:store:shell:)` is that callback's one body; `RootView`
/// hands it in. `Selection` stays a chat destination and gains no workspace
/// case.
public struct NavigatorOverlay: View {
	private let model: NavigatorModel
	private let shell: ShellState
	private let onSelect: (Selection) -> Void
	private let onSelectWorkspace: (WorkspaceId) -> Void
	private let onOpenProject: () -> Void
	private let onNewProject: () -> Void
	@State private var query = ""

	/// - Parameters:
	///   - onSelect: A mission row was used: jump to that conversation.
	///   - onSelectWorkspace: A workspace row was used. Defaults to nothing
	///     for previews and tests that only read the panel; the app passes
	///     `selectWorkspace(_:store:shell:)`, which is the only behaviour
	///     this callback is meant to have.
	public init(
		model: NavigatorModel, shell: ShellState,
		onSelect: @escaping (Selection) -> Void,
		onSelectWorkspace: @escaping (WorkspaceId) -> Void = { _ in },
		onOpenProject: @escaping () -> Void = {},
		onNewProject: @escaping () -> Void = {}
	) {
		self.model = model
		self.shell = shell
		self.onSelect = onSelect
		self.onSelectWorkspace = onSelectWorkspace
		self.onOpenProject = onOpenProject
		self.onNewProject = onNewProject
	}

	/// Switches the shell to `id`: the store takes the selection (the toolbar
	/// and this panel both read `Store.currentWorkspaceId`), then the chat
	/// returns to that workspace's leader, because a mission or agent
	/// selection belongs to the workspace being left.
	///
	/// It does not hide the overlay: the row that called it does
	/// (`select(_ row: WorkspaceRow)`), the same way a mission row does.
	@MainActor
	public static func selectWorkspace(_ id: WorkspaceId, store: Store, shell: ShellState) {
		store.setCurrentWorkspace(id)
		shell.select(.leader)
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			searchField
			HStack(spacing: 8) {
				Button("Open Project", action: onOpenProject).buttonStyle(.borderedProminent)
				Button("New Project", action: onNewProject).buttonStyle(.bordered)
			}
			ScrollView(.vertical, showsIndicators: false) {
				VStack(alignment: .leading, spacing: 0) {
					ForEach(Array(sections(query: query).enumerated()), id: \.element.id) {
						index, section in
						sectionView(section)
							.padding(.top, index == 0 ? 0 : section.topGap)
					}
				}
			}
		}
		.padding(16)
		.frame(width: Theme.Metric.navigatorWidth)
		.netaGlass(.panel)
		.onHover { hovering in
			if hovering {
				shell.navigatorPointerEntered(.panel)
			} else {
				shell.navigatorPointerExited(.panel)
			}
		}
		.onExitCommand { shell.hideNavigator() }
	}

	/// Exactly what the panel draws for `query`: matching workspaces and the
	/// connected machine nested under each workspace that has a local root.
	///
	/// `body` renders this list and nothing else, so a test that builds it
	/// reads the headers, the row text and the selected state the overlay
	/// puts on screen.
	public func sections(query: String) -> [NavigatorSection] {
		let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
		return [
			NavigatorSection(
				header: .workspaces,
				rows: model.workspaces.filter {
					needle.isEmpty || $0.name.localizedCaseInsensitiveContains(needle)
				}.map { workspace in
					.workspace(WorkspaceRow(
						id: workspace.id,
						monogram: Self.monogram(for: workspace.name),
						name: workspace.name,
						isSelected: model.isSelected(workspace),
						machines: model.onlineRoots(for: workspace)))
				})
		]
	}

	/// Row activation: jumps to the mission's lead conversation and closes
	/// the overlay.
	@MainActor
	func select(_ row: NavigatorModel.Row) {
		onSelect(.mission(row.id))
		shell.hideNavigator()
	}

	/// Workspace row activation: switches the shell to that workspace and
	/// closes the overlay, exactly as a mission row does.
	@MainActor
	func select(_ row: WorkspaceRow) {
		onSelectWorkspace(row.id)
		shell.hideNavigator()
	}

	// MARK: - Private

	private var searchField: some View {
		HStack(spacing: 8) {
			TextField("Jump to…", text: $query)
				.font(Theme.text(13, .regular))
				.foregroundStyle(Theme.textPrimary)
				.textFieldStyle(.plain)
			Text("⌘L")
				.font(Theme.mono(11, .regular))
				.foregroundStyle(Theme.textSecondary)
		}
		.padding(.horizontal, 10)
		.padding(.vertical, 7)
		.netaGlass(.rounded(Theme.Metric.concentric(outer: Theme.Metric.panelRadius, padding: 8)))
	}

	/// A header and its rows, indented as a group when the header is one.
	private func sectionView(_ section: NavigatorSection) -> some View {
		VStack(alignment: .leading, spacing: 2) {
			section.header
			ForEach(section.rows) { row in
				rowView(row)
			}
		}
		.padding(.leading, section.indent)
	}

	@ViewBuilder
	private func rowView(_ row: NavigatorRow) -> some View {
		switch row {
		case .workspace(let workspace):
			workspaceRow(workspace)
		case .machine(let machine):
			machineRow(machine)
		case .mission(let mission):
			rowButton(mission)
		}
	}

	/// The selected workspace reads as selected without colour doing the
	/// work: `row.fill`'s lifted row, the brighter monogram tile and a
	/// heavier name, beside the plain rows.
	private func workspaceRow(_ row: WorkspaceRow) -> some View {
		VStack(alignment: .leading, spacing: 2) {
		Button { select(row) } label: {
			HStack(spacing: 8) {
				Text(row.monogram)
					.font(Theme.text(9, .bold))
					.foregroundStyle(row.isSelected ? Theme.textPrimary : Theme.textSecondary)
					.frame(width: NavigatorStyle.monogram, height: NavigatorStyle.monogram)
					.background(row.monogramFill)
					.clipShape(RoundedRectangle(cornerRadius: 5))
				Text(row.name)
					.font(Theme.text(12, row.isSelected ? .semibold : .medium))
					.foregroundStyle(row.isSelected ? Theme.textPrimary : Theme.textSecondary)
					.lineLimit(1)
			Spacer(minLength: 0)
		}
			.padding(.horizontal, 6)
			.frame(minHeight: Theme.Metric.minHitHeight)
			.background(
				RoundedRectangle(cornerRadius: NavigatorStyle.rowRadius).fill(row.fill))
			.contentShape(RoundedRectangle(cornerRadius: NavigatorStyle.rowRadius))
		}
		.buttonStyle(.plain)
		ForEach(row.machines) { machine in
			machineRow(machine).padding(.leading, NavigatorStyle.monogram + 8)
		}
		}
		.accessibilityLabel(row.name)
		.accessibilityAddTraits(row.isSelected ? [.isSelected] : [])
	}

	/// `mac-studio · Online`: a dot and the word, never the dot alone.
	private func machineRow(_ row: MachineRow) -> some View {
		HStack(spacing: 8) {
			Circle()
				.fill(row.tint)
				.frame(width: NavigatorStyle.dot, height: NavigatorStyle.dot)
			Text(row.name)
				.font(Theme.text(12, .medium))
				.foregroundStyle(Theme.textPrimary)
				.lineLimit(1)
			Spacer(minLength: 0)
			Text(row.status)
				.font(Theme.text(10, .semibold))
				.foregroundStyle(row.tint)
		}
		.padding(.horizontal, 6)
		.frame(minHeight: Theme.Metric.minHitHeight)
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(row.name), \(row.status)")
	}

	private func rowButton(_ row: NavigatorModel.Row) -> some View {
		Button { select(row) } label: {
			HStack(spacing: 6) {
				Text("#\(row.number)")
					.font(Theme.mono(11, .semibold))
					.foregroundStyle(Theme.textSecondary)
				Text(row.name)
					.font(Theme.text(12, .medium))
					.foregroundStyle(Theme.textPrimary)
					.lineLimit(1)
				Spacer(minLength: 0)
				Text(row.stateLabel)
					.font(Theme.text(10, .semibold))
					.foregroundStyle(row.tint)
			}
			.padding(.horizontal, 6)
			.frame(minHeight: Theme.Metric.minHitHeight)
			.contentShape(RoundedRectangle(cornerRadius: NavigatorStyle.rowRadius))
		}
		.buttonStyle(.plain)
		.accessibilityLabel("#\(row.number) \(row.name), \(row.stateLabel)")
	}

	private static func monogram(for name: String) -> String {
		guard let first = name.first else { return "·" }
		return String(first).uppercased()
	}
}

/// The 6pt hover strip on the window's left edge: hovering it shows the
/// overlay, and leaving it schedules the auto-hide, so a pointer that
/// crosses the strip and moves on does not leave the panel up.
///
/// It reports as `.edge` and the panel as `.panel`, so a fast move that
/// delivers the panel's enter before the strip's exit does not hide the panel
/// the pointer is now resting on.
public struct NavigatorEdgeTrigger: View {
	private let shell: ShellState

	public init(shell: ShellState) {
		self.shell = shell
	}

	public var body: some View {
		Color.clear
			.frame(width: Theme.Metric.hoverEdge)
			.contentShape(Rectangle())
			.onHover { hovering in
				if hovering {
					shell.navigatorPointerEntered(.edge)
					shell.showNavigator()
				} else {
					shell.navigatorPointerExited(.edge)
				}
			}
			.accessibilityLabel("Show navigator")
	}
}
