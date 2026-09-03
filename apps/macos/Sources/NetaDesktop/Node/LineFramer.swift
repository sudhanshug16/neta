import Foundation

/// NDJSON framing for the Node socket (09-desktop-shell T9.4, 04-node).
///
/// The wire is one JSON object per line, `\n`-terminated, UTF-8, with no
/// length prefix. `push` buffers arbitrary byte chunks and returns only
/// complete lines; a multibyte UTF-8 sequence split across chunks is safe
/// because no UTF-8 lead or continuation byte is `0x0A`, so splitting raw
/// bytes on `\n` can never tear a character apart.
public struct LineFramer: Sendable {
	private var buffer = Data()

	public init() {}

	/// Appends a chunk and returns every complete line now available, without
	/// the terminator (and without a trailing `\r`, so `\r\n` senders work).
	/// Blank lines — empty or only spaces/tabs — are ignored, never emitted.
	/// A trailing partial line stays buffered until its `\n` arrives.
	public mutating func push(_ data: Data) -> [Data] {
		buffer.append(data)
		var lines: [Data] = []
		while let newline = buffer.firstIndex(of: 0x0A) {
			var line = buffer[buffer.startIndex ..< newline]
			buffer.removeSubrange(buffer.startIndex ... newline)
			if line.last == 0x0D { line = line.dropLast() }
			if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) { continue }
			lines.append(Data(line))
		}
		return lines
	}

	/// Frames one line for sending: the payload plus its `\n` terminator.
	public static func frame(_ line: Data) -> Data {
		var out = line
		out.append(0x0A)
		return out
	}
}
