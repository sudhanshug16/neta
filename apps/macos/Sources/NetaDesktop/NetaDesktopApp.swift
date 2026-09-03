import SwiftUI

@main
struct NetaDesktopApp: App {
	@State private var model = RootViewModel()

	var body: some Scene {
		WindowGroup {
			ContentView(model: model)
				.preferredColorScheme(.dark)
				.frame(minWidth: 1100, minHeight: 700)
		}
		.windowStyle(.hiddenTitleBar)
		.defaultSize(width: 1600, height: 1000)
	}
}
