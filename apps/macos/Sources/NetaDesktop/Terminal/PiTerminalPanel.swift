import AppKit
import Observation
import SwiftTerm
import SwiftUI

public enum DesktopRuntime: Sendable {
	case native
	case pi

	public static func configured(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment) -> Self {
		let value = environment["NETA_RUNTIME"] ?? bundle.object(forInfoDictionaryKey: "NetaRuntime") as? String
		return value?.lowercased() == "pi" ? .pi : .native
	}
}

/// Resolves only actors which own a Pi process. A mission selects its own Pi
/// lead agent and never falls back to the workspace leader.
public enum PiTerminalRoute {
	@MainActor public static func sessionId(selection: Selection, store: Store) -> SessionId? {
		guard DesktopRuntime.configured() == .pi else { return nil }
		switch selection {
		case .leader:
			guard store.leader?.provider == "pi" else { return nil }
			return store.leader?.sessionId
		case .mission(let missionId):
			guard case .agent(let agentId) = store.missionsById[missionId]?.lead,
				let agent = store.agentsById[agentId], agent.provider == "pi" else { return nil }
			return agent.sessionId
		case .agent(let agentId):
			guard let agent = store.agentsById[agentId], agent.provider == "pi" else { return nil }
			return agent.sessionId
		}
	}
}

@MainActor @Observable public final class PiTerminalRegistry {
	private let client: any NodeClient
	private var controllers: [SessionId: PiTerminalController] = [:]

	public init(client: any NodeClient) { self.client = client }

	public func controller(sessionId: SessionId) -> PiTerminalController {
		if let existing = controllers[sessionId] { return existing }
		let controller = PiTerminalController(sessionId: sessionId, client: client)
		controllers[sessionId] = controller
		return controller
	}
}

@MainActor final class PiTerminalView: TerminalView {
	var pasteboard: () -> NSPasteboard = { .general }
	var pasteImage: (() -> Void)?

	override func paste(_ sender: Any) {
		let board = pasteboard()
		if board.canReadObject(forClasses: [NSImage.self], options: nil) {
			pasteImage?()
			return
		}
		super.paste(sender)
	}
}

@MainActor @Observable public final class PiTerminalController: NSObject, @preconcurrency TerminalViewDelegate {
	public let sessionId: SessionId
	public private(set) var phase: TerminalState.Phase = .restarting
	public private(set) var errorMessage: String?
	public private(set) var pid: Int?
	let terminalView: PiTerminalView

	private let client: any NodeClient
	private var attachmentId: String?
	private var lastSequence = 0
	private var generation: String?
	private var notificationTask: Task<Void, Never>?
	private var attachTask: Task<Void, Never>?
	private var inputTask: Task<Void, Never>?
	private var resizeTask: Task<Void, Never>?
	private var activeHosts = 0
	private var lastSize: (cols: Int, rows: Int)?
	private var bufferingAttach = false
	private var pendingOutput: [Int: TerminalOutput] = [:]

	public init(sessionId: SessionId, client: any NodeClient) {
		self.sessionId = sessionId
		self.client = client
		terminalView = PiTerminalView(frame: .zero)
		super.init()
		terminalView.configureNativeColors()
		terminalView.terminalDelegate = self
		terminalView.pasteImage = { [weak self] in self?.sendInput(Data([0x16])) }
	}

	func appear() {
		activeHosts += 1
		guard activeHosts == 1 else { return }
		startNotifications()
		attach()
		Task { @MainActor [weak self] in
			await Task.yield()
			guard let self else { return }
			self.terminalView.window?.makeFirstResponder(self.terminalView)
		}
	}

	func disappear() {
		activeHosts = max(0, activeHosts - 1)
		guard activeHosts == 0 else { return }
		attachTask?.cancel()
		attachTask = nil
		notificationTask?.cancel()
		notificationTask = nil
		guard let id = attachmentId else { return }
		attachmentId = nil
		Task { try? await client.terminalDetach(sessionId: sessionId, attachmentId: id) }
	}

	private func startNotifications() {
		let stream = client.notifications
		notificationTask?.cancel()
		notificationTask = Task { [weak self] in
			for await note in stream {
				guard let self, !Task.isCancelled else { return }
				switch note {
				case .terminalOutput(let id, let output) where id == self.sessionId:
					self.accept(output)
				case .terminalState(let state) where state.sessionId == self.sessionId:
					self.acceptGeneration(state.generation)
					self.phase = state.phase
				default: break
				}
			}
		}
	}

	private func attach() {
		let terminal = terminalView.getTerminal()
		let cols = max(1, terminal.cols)
		let rows = max(1, terminal.rows)
		attachTask?.cancel()
		bufferingAttach = true
		attachTask = Task { [weak self] in
			guard let self else { return }
			do {
				let result = try await client.terminalAttach(sessionId: sessionId, cols: cols, rows: rows)
				guard !Task.isCancelled, activeHosts > 0 else {
					try? await client.terminalDetach(sessionId: sessionId, attachmentId: result.attachmentId)
					return
				}
				phase = .running
				pid = result.pid
				acceptGeneration(result.generation)
				bufferingAttach = false
				attachmentId = result.attachmentId
				for output in result.replay.sorted(by: { $0.seq < $1.seq }) { accept(output) }
				for output in pendingOutput.values.sorted(by: { $0.seq < $1.seq }) { accept(output) }
				pendingOutput.removeAll(keepingCapacity: true)
				lastSize = (cols, rows)
				errorMessage = nil
			} catch is CancellationError {
				bufferingAttach = false
				return
			} catch {
				bufferingAttach = false
				errorMessage = error.localizedDescription
			}
		}
	}

	private func accept(_ output: TerminalOutput) {
		acceptGeneration(output.generation)
		if bufferingAttach {
			pendingOutput[output.seq] = output
			return
		}
		guard output.seq > lastSequence, let data = output.data else { return }
		lastSequence = output.seq
		terminalView.feed(byteArray: Array(data)[...])
	}

	private func acceptGeneration(_ next: String) {
		guard generation != next else { return }
		generation = next
		lastSequence = 0
		pendingOutput.removeAll(keepingCapacity: true)
		terminalView.feed(byteArray: Array("\u{1b}c".utf8)[...])
	}

	private func sendInput(_ data: Data) {
		guard let attachmentId else { return }
		let previous = inputTask
		inputTask = Task {
			await previous?.value
			do { try await client.terminalInput(sessionId: sessionId, attachmentId: attachmentId, data: data) }
			catch { errorMessage = error.localizedDescription }
		}
	}

	public func send(source: TerminalView, data: ArraySlice<UInt8>) { sendInput(Data(data)) }

	public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
		guard newCols > 0, newRows > 0, lastSize?.cols != newCols || lastSize?.rows != newRows,
			let attachmentId else { return }
		lastSize = (newCols, newRows)
		resizeTask?.cancel()
		resizeTask = Task {
			try? await Task.sleep(for: .milliseconds(30))
			guard !Task.isCancelled else { return }
			do { try await client.terminalResize(sessionId: sessionId, attachmentId: attachmentId, cols: newCols, rows: newRows) }
			catch { errorMessage = error.localizedDescription }
		}
	}

	public func setTerminalTitle(source: TerminalView, title: String) {}
	public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
	public func scrolled(source: TerminalView, position: Double) {}
	public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

	/// One bounded line for the signed-app driver. The displayed cells come
	/// from SwiftTerm itself, so this observes renderer input rather than the
	/// Node notification before it reaches the terminal.
	func debugSummary(focused: Bool) -> String {
		let terminal = terminalView.getTerminal()
		let cols = max(1, terminal.cols), rows = max(1, terminal.rows)
		let firstRow = terminal.buffer.yDisp
		let rendered = terminal.getText(
			start: .init(col: 0, row: firstRow),
			end: .init(col: cols - 1, row: firstRow + rows - 1))
		let bounded = String(rendered.suffix(2_048))
			.replacingOccurrences(of: "\\", with: "\\\\")
			.replacingOccurrences(of: "\r", with: "\\r")
			.replacingOccurrences(of: "\n", with: "\\n")
		let pidText = pid.map(String.init) ?? "-"
		let generationText = generation ?? "-"
		return "terminalSession=\(sessionId) terminalPid=\(pidText)"
			+ " terminalGeneration=\(generationText) terminalPhase=\(phase.rawValue)"
			+ " terminalCols=\(cols) terminalRows=\(rows) terminalFocused=\(focused)"
			+ " terminalSeq=\(lastSequence) terminalText=\(bounded)"
	}
}

struct PiTerminalHost: NSViewRepresentable {
	let controller: PiTerminalController
	func makeNSView(context: Context) -> TerminalView {
		controller.appear()
		return controller.terminalView
	}
	func updateNSView(_ nsView: TerminalView, context: Context) {
		Task { @MainActor in nsView.window?.makeFirstResponder(nsView) }
	}
	static func dismantleNSView(_ nsView: TerminalView, coordinator: Void) {
		(nsView.terminalDelegate as? PiTerminalController)?.disappear()
	}
}

public struct PiTerminalPanel: View {
	private let controller: PiTerminalController
	public init(controller: PiTerminalController) { self.controller = controller }

	public var body: some View {
		ZStack(alignment: .top) {
			PiTerminalHost(controller: controller)
				.accessibilityIdentifier("pi-terminal")
			if let message = controller.errorMessage {
				Text(message).font(.callout).padding(8)
					.background(.regularMaterial, in: .rect(cornerRadius: 8)).padding(10)
			}
		}
	}
}
