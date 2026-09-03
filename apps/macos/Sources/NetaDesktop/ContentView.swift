import SwiftUI

@Observable
final class RootViewModel {
	var status: String = "Neta"
}

struct ContentView: View {
	let model: RootViewModel

	var body: some View {
		Text(model.status)
	}
}
