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

	/// The zoom readout, drawn in mono tabular digits so the percentage does
	/// not jitter as it changes.
	public var zoomText: String { "\(zoomPercent)%" }

	/// Snapshots the toolbar from the store picture and the person's view.
	/// The selected workspace is `Store.currentWorkspaceId` — the selection
	/// itself, taken the way `Store.setCurrentWorkspace` documents and the way
	/// the navigator takes it, never derived from `leader?.workspaceId`, which
	/// follows the selection — falling back to the first workspace before the
	/// first snapshot lands; the selected machine is the leader's, falling back to the
	/// connected machine. The store only knows the machine it is connected
	/// to, so a root on any other machine surfaces under its id with the
	/// selected workspace's creation date.
	@MainActor
	public static func make(store: Store, shell: ShellState) -> ToolbarModel {
		let workspaces = store.workspaces
		let selectedWorkspaceId = store.currentWorkspaceId ?? workspaces.first?.id ?? ""
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
/// Order: the workspace menu, the machine menu when the model carries one,
/// `Fit`, then `− 100% +`. Labels are 12/600 and the zoom readout 10/600 mono
/// tabular; menus carry an SF Symbol chevron, never a literal glyph. The
/// capsule and every control are glass, controls at the concentric radius and
/// without the outer shadow, since they sit on the capsule.
///
/// The workspace menu acts: picking a row calls `onSelectWorkspace`, which
/// the shell answers with `NavigatorOverlay.selectWorkspace` — the same one
/// body the navigator's workspace rows use, so both pickers move the same
/// selection. The machine is drawn as a plain label, not a menu: nothing in
/// the app can move a workspace's machine, and a menu that lists rows which
/// do nothing when clicked is a control that lies about what it does.
public struct ToolbarCapsule: View {
	private let model: ToolbarModel
	private let shell: ShellState
	private let onSelectWorkspace: (WorkspaceId) -> Void

	/// - Parameter onSelectWorkspace: A workspace row was used. Defaults to
	///   nothing for previews and tests that only read the capsule; the app
	///   passes `NavigatorOverlay.selectWorkspace(_:store:shell:)`.
	public init(
		model: ToolbarModel, shell: ShellState,
		onSelectWorkspace: @escaping (WorkspaceId) -> Void = { _ in }
	) {
		self.model = model
		self.shell = shell
		self.onSelectWorkspace = onSelectWorkspace
	}

	public var body: some View {
		HStack(spacing: 4) {
			Menu {
				ForEach(model.workspaces) { workspace in
					Button(workspace.name) { onSelectWorkspace(workspace.id) }
				}
			} label: {
				menuLabel(selectedWorkspaceName, tone: Theme.textPrimary)
			}
			.menuStyle(.button)
			.buttonStyle(.plain)
			.menuIndicator(.hidden)
			.fixedSize()
			.netaGlass(.rounded(controlRadius))
			.accessibilityLabel("Workspace")
			if let machines = model.machines {
				Text(selectedMachineName(in: machines))
					.font(Theme.text(12, .semibold))
					.foregroundStyle(Theme.textSecondary)
					.padding(.horizontal, 10)
					.frame(minHeight: Theme.Metric.minHitHeight)
					.netaGlass(.rounded(controlRadius))
					.accessibilityLabel("Machine \(selectedMachineName(in: machines))")
			}
			Rectangle()
				.fill(Theme.divider)
				.frame(width: Theme.Metric.ruleWidth, height: 16)
			control("Fit") { shell.fit() }
				.netaGlass(.rounded(controlRadius))
			HStack(spacing: 2) {
				control("−") { shell.zoomOut() }
					.accessibilityLabel("Zoom out")
				Text(model.zoomText)
					.font(Theme.mono(10, .semibold))
					.foregroundStyle(Theme.textPrimary)
					.frame(minWidth: 44)
				control("+") { shell.zoomIn() }
					.accessibilityLabel("Zoom in")
			}
			.netaGlass(.rounded(controlRadius))
		}
		.padding(.horizontal, Self.padding)
		.padding(.vertical, Self.verticalPadding)
		.netaGlass(.capsule)
	}

	// MARK: - Private

	/// A menu label: the name in 12/600 with an SF Symbol chevron, never a
	/// literal glyph.
	private func menuLabel(_ text: String, tone: Color) -> some View {
		HStack(spacing: 4) {
			Text(text)
				.font(Theme.text(12, .semibold))
			Image(systemName: "chevron.down")
				.font(Theme.text(9, .semibold))
		}
		.foregroundStyle(tone)
		.padding(.horizontal, 10)
		.frame(minHeight: Theme.Metric.minHitHeight)
	}

	/// A plain glass control: 12/600 on the primary tone, hit target at the
	/// floor.
	private func control(_ label: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(label)
				.font(Theme.text(12, .semibold))
				.foregroundStyle(Theme.textPrimary)
				.padding(.horizontal, 10)
				.frame(minHeight: Theme.Metric.minHitHeight)
		}
		.buttonStyle(.plain)
	}

	/// The capsule's own padding. Its outer shape is a capsule, so its
	/// effective radius is half its height: the hit floor plus the vertical
	/// padding on both sides.
	private static let padding: CGFloat = 8
	private static let verticalPadding: CGFloat = 6
	private static var height: CGFloat {
		Theme.Metric.minHitHeight + verticalPadding * 2
	}

	/// Nested-control radius inside the capsule: concentric with the
	/// capsule's own radius, never with the mission bar's, which belongs to
	/// a different surface.
	private var controlRadius: CGFloat {
		Theme.Metric.concentric(outer: Self.height / 2, padding: Self.padding)
	}

	private var selectedWorkspaceName: String {
		model.workspaces.first(where: { $0.id == model.selectedWorkspaceId })?.name ?? "Workspace"
	}

	private func selectedMachineName(in machines: [Machine]) -> String {
		machines.first(where: { $0.id == model.selectedMachineId })?.name
			?? model.selectedMachineId ?? "Machine"
	}
}
