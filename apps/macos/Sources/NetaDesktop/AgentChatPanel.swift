import SwiftUI

struct AgentChatPanel: View {
	@ObservedObject var model: AppModel

	var body: some View {
		VStack(spacing: 0) {
			if let agent = model.selectedAgent, let project = model.selectedProject {
				ChatHeader(agent: agent, onStop: model.stopSelectedAgent)
				Divider().overlay(Color.white.opacity(0.06))
				MessageList(agent: agent, isSending: model.isSending)
				Divider().overlay(Color.white.opacity(0.06))
				if project.lifecycle == .archived {
					ArchiveComposer(model: model, project: project)
				} else {
					ChatComposer(model: model, agent: agent)
				}
			}
		}
		.floatingPanel()
	}
}

private struct ArchiveComposer: View {
	@ObservedObject var model: AppModel
	let project: NetaProject

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Label("Read-only archived session", systemImage: "archivebox")
				.font(.system(size: 10, weight: .medium))
				.foregroundStyle(NetaTheme.secondaryText)
			Button(action: model.resumeSelectedProject) {
				HStack {
					if model.isResuming { ProgressView().controlSize(.small) }
					Image(systemName: "play.fill")
					Text(project.workspace?.availability == .restorable ? "Restore worktree and resume" : "Resume exact session")
					Spacer()
				}
				.font(.system(size: 11, weight: .semibold))
				.padding(.horizontal, 11)
				.padding(.vertical, 9)
			}
			.buttonStyle(.plain)
			.background(NetaTheme.violet.opacity(0.72), in: RoundedRectangle(cornerRadius: 9))
			.disabled(!project.isResumable || model.isResuming)
			.opacity(project.isResumable ? 1 : 0.4)
		}
		.padding(13)
		.background(Color.black.opacity(0.08))
	}
}

private struct ChatHeader: View {
	let agent: NetaAgent
	let onStop: () -> Void

	var body: some View {
		HStack(spacing: 11) {
			AgentAvatar(agent: agent, size: 38)
			VStack(alignment: .leading, spacing: 3) {
				HStack(spacing: 6) {
					Text(agent.name)
						.font(.system(size: 14, weight: .semibold))
					if agent.kind == .leader {
						Text("Leader")
							.font(.system(size: 9, weight: .bold))
							.foregroundStyle(NetaTheme.violet)
					}
				}
				Text("\(agent.backend) · \(agent.state.label)")
					.font(.system(size: 10, weight: .medium))
					.foregroundStyle(NetaTheme.secondaryText)
			}
			Spacer()
			Button(action: onStop) {
				Image(systemName: "stop.fill")
					.frame(width: 30, height: 30)
					.background(Color.white.opacity(0.07), in: Circle())
			}
			.buttonStyle(.plain)
			.disabled(!agent.canStop)
			.opacity(agent.canStop ? 1 : 0.35)
			.help(agent.kind == .leader ? "Stop the current turn" : "Stop this worker")
		}
		.padding(15)
	}
}

private struct MessageList: View {
	let agent: NetaAgent
	let isSending: Bool

	var body: some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(spacing: 14) {
					ForEach(agent.messages) { message in
						MessageBubble(message: message)
							.id(message.id)
					}
					if isSending {
						HStack(spacing: 5) {
							ProgressView().controlSize(.small)
							Text("Working…")
								.font(.system(size: 10, weight: .medium))
								.foregroundStyle(NetaTheme.secondaryText)
							Spacer()
						}
						.id("sending")
					}
				}
				.padding(15)
			}
			.onChange(of: agent.messages.count) {
				if let last = agent.messages.last {
					withAnimation(.easeOut(duration: 0.16)) {
						proxy.scrollTo(last.id, anchor: .bottom)
					}
				}
			}
		}
		.frame(maxHeight: .infinity)
	}
}

private struct MessageBubble: View {
	let message: AgentMessage

	var body: some View {
		if message.author == .system {
			Text(message.text)
				.font(.system(size: 10, weight: .medium))
				.foregroundStyle(NetaTheme.secondaryText)
				.frame(maxWidth: .infinity)
		} else {
			HStack {
				if message.author == .user { Spacer(minLength: 42) }
				Text(message.text)
					.font(.system(size: 12.5))
					.foregroundStyle(NetaTheme.primaryText)
					.textSelection(.enabled)
					.padding(.horizontal, 12)
					.padding(.vertical, 10)
					.background(
						message.author == .user ? NetaTheme.violet.opacity(0.55) : Color.white.opacity(0.065),
						in: RoundedRectangle(cornerRadius: 13, style: .continuous)
					)
				if message.author == .agent { Spacer(minLength: 42) }
			}
		}
	}
}

private struct ChatComposer: View {
	@ObservedObject var model: AppModel
	let agent: NetaAgent

	var body: some View {
		VStack(spacing: 9) {
			TextField("Message \(agent.name)…", text: $model.draft, axis: .vertical)
				.textFieldStyle(.plain)
				.font(.system(size: 12.5))
				.lineLimit(1 ... 5)
				.onSubmit(model.sendDraft)
				.disabled(!agent.canChat)
			HStack {
				Label(agent.canChat ? "ACP session" : "Native CLI owns this leader", systemImage: "bolt.horizontal.circle")
					.font(.system(size: 9, weight: .medium))
					.foregroundStyle(NetaTheme.secondaryText)
				Spacer()
				Button(action: model.sendDraft) {
					Image(systemName: "arrow.up")
						.font(.system(size: 11, weight: .bold))
						.frame(width: 28, height: 28)
						.background(
							model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
								? Color.white.opacity(0.08)
								: NetaTheme.accent,
							in: Circle()
						)
						.foregroundStyle(model.draft.isEmpty ? NetaTheme.secondaryText : Color.black.opacity(0.78))
				}
				.buttonStyle(.plain)
				.disabled(!agent.canChat || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
			}
		}
		.padding(13)
		.background(Color.black.opacity(0.08))
	}
}
