import AppKit
import SwiftUI

@MainActor final class ComposerNSTextView: NSTextView {
	private(set) var keyDownCount = 0
	private(set) var returnCount = 0
	private(set) var pasteCount = 0
	private(set) var lastPasteHandled = false
	var attachmentPaste: ((NSPasteboard) -> Bool)?
	var sendAction: ((String) -> Void)?
	var stopAction: (() -> Void)?
	var textChanged: ((String) -> Void)?
	var debugState: (() -> String)?
	var debugInbox: (() -> [InboxMessage])?
	var pasteboard: () -> NSPasteboard = { .general }

	override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
		Array(Set(super.readablePasteboardTypes + [.png, .tiff, .fileURL]))
	}

	override func didChangeText() {
		super.didChangeText()
		textChanged?(string)
	}

	override func paste(_ sender: Any?) {
		pasteCount += 1
		let board = pasteboard()
		if attachmentPaste?(board) == true { lastPasteHandled = true; return }
		lastPasteHandled = false
		if board !== NSPasteboard.general, readSelection(from: board) { return }
		super.paste(sender)
	}

	override func keyDown(with event: NSEvent) {
		keyDownCount += 1
		let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
		if (event.keyCode == 36 || event.keyCode == 76), modifiers.isEmpty {
			returnCount += 1
			sendAction?(string)
			return
		}
		if event.charactersIgnoringModifiers == ".", modifiers == .command {
			stopAction?()
			return
		}
		super.keyDown(with: event)
	}
}

struct ComposerTextInput: NSViewRepresentable {
	@Binding var text: String
	let onSend: (String) -> Void
	let onStop: () -> Void
	let onPaste: (NSPasteboard) -> Bool
	let focusRequested: Bool
	let debugState: () -> String
	let debugInbox: () -> [InboxMessage]

	func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

	func makeNSView(context: Context) -> NSScrollView {
		let scroll = NSScrollView()
		let input = ComposerNSTextView(frame: NSRect(x: 0, y: 0, width: 320, height: 26))
		input.delegate = context.coordinator
		input.textChanged = { context.coordinator.text.wrappedValue = $0 }
		input.isRichText = false
		input.drawsBackground = false
		input.isVerticallyResizable = true
		input.isHorizontallyResizable = false
		input.minSize = NSSize(width: 0, height: 26)
		input.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
		input.autoresizingMask = [.width]
		input.textContainer?.widthTracksTextView = true
		input.textContainerInset = NSSize(width: 4, height: 5)
		input.font = .systemFont(ofSize: 12.5)
		input.string = text
		input.sendAction = onSend
		input.stopAction = onStop
		input.attachmentPaste = onPaste
		input.debugState = debugState
		input.debugInbox = debugInbox
		scroll.drawsBackground = false
		scroll.hasVerticalScroller = false
		scroll.documentView = input
		return scroll
	}

	func updateNSView(_ scroll: NSScrollView, context: Context) {
		guard let input = scroll.documentView as? ComposerNSTextView else { return }
		if input.string != text { input.string = text }
		context.coordinator.text = $text
		input.textChanged = { context.coordinator.text.wrappedValue = $0 }
		input.sendAction = onSend
		input.stopAction = onStop
		input.attachmentPaste = onPaste
		input.debugState = debugState
		input.debugInbox = debugInbox
		applyFocus(input, context: context)
	}

	private func applyFocus(_ input: ComposerNSTextView, context: Context) {
		if focusRequested, !context.coordinator.focusApplied {
			context.coordinator.focusApplied = true
			DispatchQueue.main.async { input.window?.makeFirstResponder(input) }
		} else if !focusRequested, context.coordinator.focusApplied {
			context.coordinator.focusApplied = false
			if input.window?.firstResponder === input { input.window?.makeFirstResponder(nil) }
		}
	}

	final class Coordinator: NSObject, NSTextViewDelegate {
		var text: Binding<String>
		var focusApplied = false
		init(text: Binding<String>) { self.text = text }
		func textDidChange(_ notification: Notification) {
			guard let input = notification.object as? NSTextView else { return }
			text.wrappedValue = input.string
		}
	}
}
