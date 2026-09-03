import SwiftUI

@main
struct NetaDesktopApp: App {
	@StateObject private var model = AppModel(client: NetaBridgeClient())

	var body: some Scene {
		WindowGroup {
			ContentView(model: model)
				.frame(minWidth: 1_000, minHeight: 680)
				.task {
					await model.monitor()
				}
		}
		.defaultSize(width: 1_440, height: 900)
		.windowStyle(.hiddenTitleBar)
		.windowToolbarStyle(.unifiedCompact(showsTitle: false))
	}
}
