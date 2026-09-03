import AppKit
import SwiftUI

enum ProjectPicker {
	@MainActor
	static func open(model: AppModel) {
		let panel = NSOpenPanel()
		panel.title = "Open a Neta project"
		panel.prompt = "Start leader"
		panel.canChooseFiles = false
		panel.canChooseDirectories = true
		panel.allowsMultipleSelection = false
		guard panel.runModal() == .OK, let path = panel.url?.path else { return }
		model.openProject(at: path)
	}
}

struct ProjectSidebar: View {
	@ObservedObject var model: AppModel

	var body: some View {
		VStack(alignment: .leading, spacing: 16) {
			HStack(spacing: 10) {
				ZStack {
					RoundedRectangle(cornerRadius: 9, style: .continuous)
						.fill(NetaTheme.violet.gradient)
					Image(systemName: "point.3.filled.connected.trianglepath.dotted")
						.font(.system(size: 16, weight: .bold))
						.foregroundStyle(.white)
				}
				.frame(width: 34, height: 34)
				VStack(alignment: .leading, spacing: 1) {
					Text("Neta")
						.font(.system(size: 16, weight: .semibold))
					Text("Projects")
						.font(.system(size: 11, weight: .medium))
						.foregroundStyle(NetaTheme.secondaryText)
				}
				Spacer()
			}

			ScrollView {
				LazyVStack(alignment: .leading, spacing: 14) {
					ProjectSection(title: "ACTIVE", projects: model.projects, model: model)
					if !model.archivedProjects.isEmpty {
						ProjectSection(title: "ARCHIVE", projects: model.archivedProjects, model: model)
					}
				}
				.padding(.trailing, 3)
			}
			.scrollIndicators(.never)

			if let project = model.selectedProject {
				VStack(alignment: .leading, spacing: 8) {
					Text(project.lifecycle == .active ? "ACTIVE CANVAS" : "ARCHIVED SESSION")
						.font(.system(size: 10, weight: .bold))
						.foregroundStyle(NetaTheme.secondaryText)
					Text(project.path)
						.font(.system(size: 11, design: .monospaced))
						.foregroundStyle(NetaTheme.primaryText.opacity(0.72))
						.lineLimit(2)
					Label("\(project.agents.count) agent\(project.agents.count == 1 ? "" : "s")", systemImage: "person.2.fill")
						.font(.system(size: 11, weight: .medium))
						.foregroundStyle(NetaTheme.secondaryText)
					if let branch = project.workspace?.branch {
						Label(branch, systemImage: "arrow.triangle.branch")
							.font(.system(size: 10, weight: .medium))
							.foregroundStyle(NetaTheme.secondaryText)
					}
					if project.lifecycle == .archived {
						Text(project.updatedAt.formatted(date: .abbreviated, time: .shortened))
							.font(.system(size: 10, weight: .medium))
							.foregroundStyle(NetaTheme.secondaryText)
						if let error = project.errorMessage {
							Text(error)
								.font(.system(size: 10, weight: .medium))
								.foregroundStyle(NetaTheme.stateColor(.failed))
								.fixedSize(horizontal: false, vertical: true)
						}
						Button(action: model.resumeSelectedProject) {
							HStack(spacing: 7) {
								if model.isResuming { ProgressView().controlSize(.small) }
								Image(systemName: "play.fill")
								Text(resumeLabel(project))
							}
							.font(.system(size: 11, weight: .semibold))
							.frame(maxWidth: .infinity)
							.padding(.vertical, 8)
						}
						.buttonStyle(.plain)
						.background(NetaTheme.violet.opacity(0.72), in: RoundedRectangle(cornerRadius: 8))
						.disabled(!project.isResumable || model.isResuming)
						.opacity(project.isResumable ? 1 : 0.4)
					}
				}
				.padding(12)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
			}

			Button { ProjectPicker.open(model: model) } label: {
				Label("New project", systemImage: "plus")
					.font(.system(size: 12, weight: .semibold))
					.frame(maxWidth: .infinity)
					.padding(.vertical, 10)
			}
			.buttonStyle(.plain)
			.background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
		}
		.padding(16)
		.floatingPanel()
	}

	private func resumeLabel(_ project: NetaProject) -> String {
		project.workspace?.availability == .restorable ? "Restore & resume" : "Resume session"
	}
}

private struct ProjectSection: View {
	let title: String
	let projects: [NetaProject]
	@ObservedObject var model: AppModel

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack {
				Text(title)
				Spacer()
				Text("\(projects.count)")
			}
			.font(.system(size: 9, weight: .bold))
			.foregroundStyle(NetaTheme.secondaryText.opacity(0.78))
			.padding(.horizontal, 8)

			if projects.isEmpty {
				Text("No active sessions")
					.font(.system(size: 11, weight: .medium))
					.foregroundStyle(NetaTheme.secondaryText)
					.padding(.horizontal, 8)
			} else {
				ForEach(projects) { project in
					ProjectRow(project: project, isSelected: project.id == model.selectedProjectID) {
						model.selectProject(project.id)
					}
				}
			}
		}
	}
}

private struct ProjectRow: View {
	let project: NetaProject
	let isSelected: Bool
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: 10) {
				RoundedRectangle(cornerRadius: 8, style: .continuous)
					.fill(isSelected ? NetaTheme.violet.opacity(0.9) : Color.white.opacity(0.08))
					.frame(width: 30, height: 30)
					.overlay {
						Text(String(project.name.prefix(1)).uppercased())
							.font(.system(size: 12, weight: .bold))
					}
				VStack(alignment: .leading, spacing: 2) {
					Text(project.name)
						.font(.system(size: 13, weight: .semibold))
					Text(project.lifecycle == .active ? activeSubtitle : archiveSubtitle)
						.font(.system(size: 10, weight: .medium))
						.foregroundStyle(NetaTheme.secondaryText)
				}
				Spacer()
				if isSelected {
					Circle()
						.fill(project.lifecycle == .active ? NetaTheme.accent : NetaTheme.violet)
						.frame(width: 6, height: 6)
				}
			}
			.padding(8)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.background(
			isSelected ? Color.white.opacity(0.075) : Color.clear,
			in: RoundedRectangle(cornerRadius: 11)
		)
	}

	private var activeSubtitle: String {
		project.agents.first(where: { $0.kind == .leader })?.state.label ?? "Offline"
	}

	private var archiveSubtitle: String {
		if let branch = project.workspace?.branch { return branch }
		return project.updatedAt.formatted(date: .abbreviated, time: .omitted)
	}
}
