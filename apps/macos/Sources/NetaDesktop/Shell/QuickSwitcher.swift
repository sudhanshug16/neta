import SwiftUI

@MainActor @Observable final class QuickSwitcherModel {
	struct Entry: Identifiable, Equatable { let id: String; let workspace: Workspace; let machine: Machine?; var title: String { machine.map { "\(workspace.name) · \($0.name)" } ?? workspace.name } }
	var query = "" { didSet { selectedIndex = 0 } }
	var selectedIndex = 0
	func entries(store: Store) -> [Entry] {
		store.workspaces.compactMap { workspace in
			let machine = !store.nodeOffline && workspace.roots.contains(where: { $0.machineId == store.machine?.id }) ? store.machine : nil
			return Entry(id: "\(workspace.id):\(machine?.id ?? "")", workspace: workspace, machine: machine)
		}.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
	}
	func move(_ delta: Int, in entries: [Entry]) { guard !entries.isEmpty else { selectedIndex = 0; return }; selectedIndex = min(max(selectedIndex + delta, 0), entries.count - 1) }
	func selected(in entries: [Entry]) -> Entry? { entries.indices.contains(selectedIndex) ? entries[selectedIndex] : nil }
}

struct QuickSwitcher: View {
	let model: QuickSwitcherModel; let store: Store; let shell: ShellState; let onSelectWorkspace: (WorkspaceId) -> Void; let dismiss: () -> Void
	@FocusState private var focused: Bool
	var body: some View {
		let entries = model.entries(store: store)
		VStack(alignment: .leading, spacing: 10) {
			TextField("Switch workspace", text: Bindable(model).query).textFieldStyle(.roundedBorder).focused($focused)
				.accessibilityIdentifier("workspace-switcher-query")
			ScrollViewReader { scroll in ScrollView { LazyVStack(alignment: .leading, spacing: 2) { ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
				Button { activate(entry) } label: { HStack { Text(entry.workspace.name); Spacer(); if let machine = entry.machine { Text(machine.name).foregroundStyle(.secondary) } }.padding(8).background(index == model.selectedIndex ? Color.accentColor.opacity(0.2) : .clear, in: RoundedRectangle(cornerRadius: 6)) }.buttonStyle(.plain)
					.accessibilityIdentifier("workspace-option-\(entry.workspace.id)")
					.id(entry.id)
			} }
			.onChange(of: model.selectedIndex) { _, _ in if let entry = model.selected(in: entries) { scroll.scrollTo(entry.id) } }
			} }.frame(maxHeight: 260)
			if entries.isEmpty { ContentUnavailableView("No matching workspaces", systemImage: "magnifyingglass") }
		}.padding(14).frame(width: 360).glassEffect(in: .rect(cornerRadius: 16))
		.onAppear { model.query = ""; model.selectedIndex = 0; focused = true }
		.onKeyPress(.upArrow) { model.move(-1, in: entries); return .handled }
		.onKeyPress(.downArrow) { model.move(1, in: entries); return .handled }
		.onKeyPress(.return) { if let entry = model.selected(in: entries) { activate(entry) }; return .handled }
		.onExitCommand { dismiss() }
	}
	private func activate(_ entry: QuickSwitcherModel.Entry) { onSelectWorkspace(entry.workspace.id); dismiss() }
}
