import SwiftUI

struct ContentView: View {
	@ObservedObject var model: AppModel

	var body: some View {
		GeometryReader { geometry in
			let chatWidth = model.selectedAgent == nil ? 0 : min(410, geometry.size.width * 0.36)
			ZStack {
				NetaTheme.canvas.ignoresSafeArea()
				if let project = model.selectedProject {
					AgentCanvas(
						project: project,
						selectedAgentID: model.selectedAgentID,
						interactionInsets: EdgeInsets(
							top: 22,
							leading: 292,
							bottom: 22,
							trailing: chatWidth == 0 ? 22 : chatWidth + 44
						),
						onSelectAgent: model.selectAgent
					)
				} else if model.isLoading {
					ProgressView().controlSize(.large)
				} else {
					EmptyCanvasView(model: model)
				}

				HStack(alignment: .top, spacing: 0) {
					ProjectSidebar(model: model)
						.frame(width: 248)
					Spacer(minLength: 360)
					if model.selectedAgent != nil {
						AgentChatPanel(model: model)
							.frame(width: chatWidth)
					}
				}
				.padding(22)
			}
		}
		.alert("Neta", isPresented: Binding(
			get: { model.errorMessage != nil },
			set: { if !$0 { model.errorMessage = nil } }
		)) {
			Button("OK", role: .cancel) { model.errorMessage = nil }
		} message: {
			Text(model.errorMessage ?? "Unknown error")
		}
		.preferredColorScheme(.dark)
	}
}

private struct EmptyCanvasView: View {
	@ObservedObject var model: AppModel

	var body: some View {
		VStack(spacing: 12) {
			Image(systemName: "point.3.connected.trianglepath.dotted")
				.font(.system(size: 36, weight: .light))
				.foregroundStyle(NetaTheme.violet)
			Text("No live Neta projects")
				.font(.system(size: 20, weight: .semibold))
			Text("Open a folder to start its leader through ACP.")
				.font(.system(size: 12))
				.foregroundStyle(NetaTheme.secondaryText)
			Button("Open project…") { ProjectPicker.open(model: model) }
				.buttonStyle(.borderedProminent)
				.tint(NetaTheme.violet)
		}
	}
}
