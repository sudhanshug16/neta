import Foundation
import SwiftUI

/// The auto-hiding jump list (09-desktop-shell T9.10): workspaces, the
/// conditional machine level, and missions as OPEN / ARCHIVED rows.
///
/// `NavigatorModel` is a value snapshot of what the overlay shows: the
/// workspaces, the machine menu only when it matters, and the mission rows
/// already filtered by the query and sorted. Views own nothing: the overlay
/// reads the model and calls back into the shell, which owns overlay
/// visibility.
public struct NavigatorModel: Equatable, Sendable {
	public struct Row: Equatable, Identifiable, Sendable {
		public let id: Ulid
		public let number: Int
		public let name: String
		public let stateLabel: String
		public let tint: Color
	}

	public let workspaces: [Workspace]
	/// Nil when the selected workspace has roots on one machine: the machine
	/// level stays hidden, per MANIFESTO.md "Desktop information
	/// architecture" (the same rule as `ToolbarModel`).
	public let machines: [Machine]?
	/// Open missions, number descending.
	public let open: [Row]
	/// Closed missions, `closedAt` descending.
	public let archived: [Row]

	/// Snapshots the navigator from the store picture, filtered by `query`:
	/// a leading `#` or digits match the number prefix, anything else is a
	/// case-insensitive substring of the name; an empty query returns
	/// everything.
	@MainActor
	public static func make(store: Store, query: String) -> NavigatorModel {
		NavigatorModel(
			workspaces: store.workspaces,
			machines: machines(in: store),
			open: store.missions
				.filter { $0.state != .closed && matches(number: $0.number, name: $0.name, query: query) }
				.sorted { $0.number > $1.number }
				.map(row(for:)),
			archived: store.missions
				.filter { $0.state == .closed && matches(number: $0.number, name: $0.name, query: query) }
				.sorted { ($0.closedAt ?? .distantPast) > ($1.closedAt ?? .distantPast) }
				.map(row(for:)))
	}

	/// The jump predicate, shared with the overlay's local filtering: empty
	/// matches everything; a leading `#` is stripped and a remaining
	/// all-digit query matches the number prefix; anything else is a
	/// case-insensitive substring of the name.
	public static func matches(number: Int, name: String, query: String) -> Bool {
		let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return true }
		var digits = trimmed
		if digits.hasPrefix("#") { digits.removeFirst() }
		digits = digits.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !digits.isEmpty else { return true }
		if digits.allSatisfy(\.isNumber) {
			return String(number).hasPrefix(digits)
		}
		return name.range(of: trimmed, options: [.caseInsensitive, .diacriticInsensitive]) != nil
	}

	// MARK: - Private

	private static func row(for mission: Mission) -> Row {
		if mission.state == .closed {
			return Row(
				id: mission.id, number: mission.number, name: mission.name,
				stateLabel: archiveLabel(for: mission), tint: Theme.textSecondary)
		}
		return Row(
			id: mission.id, number: mission.number, name: mission.name,
			stateLabel: MissionBarItem.label(for: mission.state),
			tint: stateColor(for: mission.state))
	}

	/// Archived rows carry the recorded disposition (`Merged`/`Abandoned`),
	/// falling back to `Archived` when none was recorded.
	private static func archiveLabel(for mission: Mission) -> String {
		switch mission.disposition {
		case .merged: return "Merged"
		case .abandoned: return "Abandoned"
		case nil: return "Archived"
		}
	}

	/// The selected workspace's machines, mirroring `ToolbarModel.make`:
	/// the store only knows the machine it is connected to, so a root on
	/// any other machine surfaces under its id with the selected
	/// workspace's creation date.
	@MainActor
	private static func machines(in store: Store) -> [Machine]? {
		let workspaces = store.workspaces
		let selectedWorkspaceId = store.leader?.workspaceId ?? workspaces.first?.id ?? ""
		let selectedWorkspace = workspaces.first(where: { $0.id == selectedWorkspaceId })
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

/// The floating navigator panel: a `Jump to…` field with a `⌘L` hint, then
/// WORKSPACES, MACHINE when the model carries one, then MISSIONS as OPEN and
/// ARCHIVED groups. No leader row, no counts, no cards, no status tiles.
///
/// The panel overlays the canvas and moves nothing. Typing filters the
/// model's rows with the same predicate as `NavigatorModel.make`.
/// Escape clears it via `dismissOverlay`; a canvas click is handled where
/// the canvas tap is recognized (the shell/root side), not here.
public struct NavigatorOverlay: View {
	private let model: NavigatorModel
	private let shell: ShellState
	private let onSelect: (Selection) -> Void
	@State private var query = ""

	public init(model: NavigatorModel, shell: ShellState, onSelect: @escaping (Selection) -> Void) {
		self.model = model
		self.shell = shell
		self.onSelect = onSelect
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 12) {
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
			ScrollView(.vertical, showsIndicators: false) {
				VStack(alignment: .leading, spacing: 12) {
					VStack(alignment: .leading, spacing: 4) {
						Text("WORKSPACES")
							.font(Theme.text(10, .semibold))
							.foregroundStyle(Theme.textSecondary)
						ForEach(model.workspaces) { workspace in
							HStack(spacing: 8) {
								Text(monogram(for: workspace.name))
									.font(Theme.text(11, .semibold))
									.foregroundStyle(Theme.textPrimary)
									.frame(width: 20, height: 20)
									.background(Theme.subtleSurface)
									.clipShape(RoundedRectangle(cornerRadius: 5))
								Text(workspace.name)
									.font(Theme.text(12, .regular))
									.foregroundStyle(Theme.textPrimary)
									.lineLimit(1)
							}
							.padding(.vertical, 2)
						}
					}
					if let machines = model.machines {
						VStack(alignment: .leading, spacing: 4) {
							Text("MACHINE")
								.font(Theme.text(10, .semibold))
								.foregroundStyle(Theme.textSecondary)
							ForEach(machines) { machine in
								Text(machine.name)
									.font(Theme.text(12, .regular))
									.foregroundStyle(Theme.textPrimary)
									.lineLimit(1)
									.padding(.vertical, 2)
							}
						}
					}
					VStack(alignment: .leading, spacing: 4) {
						Text("MISSIONS")
							.font(Theme.text(10, .semibold))
							.foregroundStyle(Theme.textSecondary)
						Text("OPEN")
							.font(Theme.text(10, .medium))
							.foregroundStyle(Theme.textSecondary)
						ForEach(visibleOpen) { row in
							rowButton(row)
						}
						Text("ARCHIVED")
							.font(Theme.text(10, .medium))
							.foregroundStyle(Theme.textSecondary)
							.padding(.top, 4)
						ForEach(visibleArchived) { row in
							rowButton(row)
						}
					}
				}
			}
		}
		.padding(16)
		.frame(width: Theme.Metric.navigatorWidth)
		.netaGlass(.panel)
		.onExitCommand { _ = shell.dismissOverlay() }
	}

	/// Row activation: jumps to the mission's lead conversation and closes
	/// the overlay.
	@MainActor
	func select(_ row: NavigatorModel.Row) {
		onSelect(.mission(row.id))
		shell.navigatorVisible = false
	}

	// MARK: - Private

	private var visibleOpen: [NavigatorModel.Row] {
		model.open.filter { NavigatorModel.matches(number: $0.number, name: $0.name, query: query) }
	}

	private var visibleArchived: [NavigatorModel.Row] {
		model.archived.filter { NavigatorModel.matches(number: $0.number, name: $0.name, query: query) }
	}

	private func rowButton(_ row: NavigatorModel.Row) -> some View {
		Button { select(row) } label: {
			HStack(spacing: 6) {
				Text("#\(row.number)")
					.font(Theme.mono(12, .medium))
					.foregroundStyle(Theme.textPrimary)
				Text(row.name)
					.font(Theme.text(12, .regular))
					.foregroundStyle(Theme.textPrimary)
					.lineLimit(1)
				Spacer(minLength: 0)
				Text(row.stateLabel)
					.font(Theme.text(11, .regular))
					.foregroundStyle(row.tint)
			}
			.padding(.vertical, 2)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("#\(row.number) \(row.name), \(row.stateLabel)")
	}

	private func monogram(for name: String) -> String {
		guard let first = name.first else { return "·" }
		return String(first).uppercased()
	}
}

/// The 6pt hover strip on the window's left edge: hovering it sets
/// `navigatorVisible`, opening the overlay without pushing the canvas.
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
					shell.navigatorVisible = true
				}
			}
			.accessibilityLabel("Show navigator")
	}
}
