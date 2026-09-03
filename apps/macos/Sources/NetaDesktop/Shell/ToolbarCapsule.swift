import SwiftUI

/// The only global control surface (09-desktop-shell T9.8): workspace,
/// machine when needed, Fit, time zoom.
///
/// `ToolbarModel` is a value snapshot: the menus show what the `Store` holds
/// and the zoom label shows the `ShellState` percent. Views own nothing: the
/// capsule reads the model and calls back into the shell, which owns zoom
/// and fit state.
public struct ToolbarModel: Equatable, Sendable {
	public let workspaces: [Workspace]
	public let selectedWorkspaceId: String
	/// Nil when the selected workspace has roots on one machine: the machine
	/// level stays hidden, per MANIFESTO.md "Desktop information
	/// architecture".
	public let machines: [Machine]?
	public let selectedMachineId: Ulid?
	public let zoomPercent: Int

	/// Snapshots the toolbar from the store picture and the person's view.
	/// The selected workspace is the leader's, falling back to the first
	/// workspace; the selected machine is the leader's, falling back to the
	/// connected machine. The store only knows the machine it is connected
	/// to, so a root on any other machine surfaces under its id with the
	/// selected workspace's creation date.
	@MainActor
	public static func make(store: Store, shell: ShellState) -> ToolbarModel {
		let workspaces = store.workspaces
		let selectedWorkspaceId = store.leader?.workspaceId ?? workspaces.first?.id ?? ""
		let selectedWorkspace = workspaces.first(where: { $0.id == selectedWorkspaceId })
		var machineIds: [MachineId] = []
		for root in selectedWorkspace?.roots ?? [] where !machineIds.contains(root.machineId) {
			machineIds.append(root.machineId)
		}
		machineIds.sort()
		let machines: [Machine]? = machineIds.count > 1
			? machineIds.map { id in
				if let known = store.machine, known.id == id {
					return known
				}
				return Machine(
					id: id, name: id,
					createdAt: selectedWorkspace?.createdAt ?? Date(timeIntervalSince1970: 0))
			}
			: nil
		return ToolbarModel(
			workspaces: workspaces,
			selectedWorkspaceId: selectedWorkspaceId,
			machines: machines,
			selectedMachineId: store.leader?.machineId ?? store.machine?.id,
			zoomPercent: shell.zoomPercent)
	}
}

/// The floating toolbar capsule: top centre, 12 down (geometry in T9.7).
///
/// Order: `workspace ▾`, the machine menu when the model carries one, `Fit`,
/// then `− 100% +` with the percentage in mono tabular digits. The capsule
/// and every control are glass; controls take the concentric radius. The only
/// actions are `shell.fit()`, `zoomIn()` and `zoomOut()`: workspace and
/// machine switching land in a later task, so the menus list without acting.
public struct ToolbarCapsule: View {
	private let model: ToolbarModel
	private let shell: ShellState

	public init(model: ToolbarModel, shell: ShellState) {
		self.model = model
		self.shell = shell
	}

	public var body: some View {
		HStack(spacing: 4) {
			Menu {
				ForEach(model.workspaces) { workspace in
					Button(workspace.name) {}
				}
			} label: {
				HStack(spacing: 4) {
					Text(selectedWorkspaceName)
					Text("▾")
				}
				.font(Theme.text(12, .regular))
				.foregroundStyle(Theme.textPrimary)
				.padding(.horizontal, 10)
				.padding(.vertical, 5)
			}
			.netaGlass(.rounded(controlRadius))
			if let machines = model.machines {
				Menu {
					ForEach(machines) { machine in
						Button(machine.name) {}
					}
				} label: {
					HStack(spacing: 4) {
						Text(selectedMachineName(in: machines))
						Text("▾")
					}
					.font(Theme.text(12, .regular))
					.foregroundStyle(Theme.textSecondary)
					.padding(.horizontal, 10)
					.padding(.vertical, 5)
				}
				.netaGlass(.rounded(controlRadius))
			}
			Divider()
				.frame(height: 16)
			Button("Fit") { shell.fit() }
				.font(Theme.text(12, .regular))
				.foregroundStyle(Theme.textPrimary)
				.padding(.horizontal, 10)
				.padding(.vertical, 5)
				.netaGlass(.rounded(controlRadius))
			HStack(spacing: 2) {
				Button("−") { shell.zoomOut() }
					.font(Theme.text(12, .regular))
					.foregroundStyle(Theme.textPrimary)
					.padding(.horizontal, 8)
				Text("\(model.zoomPercent)%")
					.font(Theme.mono(12, .regular))
					.foregroundStyle(Theme.textPrimary)
					.frame(minWidth: 44)
				Button("+") { shell.zoomIn() }
					.font(Theme.text(12, .regular))
					.foregroundStyle(Theme.textPrimary)
					.padding(.horizontal, 8)
			}
			.padding(.vertical, 5)
			.netaGlass(.rounded(controlRadius))
		}
		.padding(.horizontal, 8)
		.padding(.vertical, 6)
		.netaGlass(.capsule)
	}

	// MARK: - Private

	/// Nested-control radius inside the capsule.
	private var controlRadius: CGFloat {
		Theme.Metric.concentric(outer: Theme.Metric.barRadius, padding: 8)
	}

	private var selectedWorkspaceName: String {
		model.workspaces.first(where: { $0.id == model.selectedWorkspaceId })?.name ?? "Workspace"
	}

	private func selectedMachineName(in machines: [Machine]) -> String {
		machines.first(where: { $0.id == model.selectedMachineId })?.name
			?? model.selectedMachineId ?? "Machine"
	}
}
