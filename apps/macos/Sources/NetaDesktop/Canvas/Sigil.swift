import SwiftUI

/// The agent mark: a deterministic 4x4 identity sigil from the agent name.
///
/// `hash` is the FNV-1a 32-bit hash from `design/canvas-directions/lib.mjs`.
/// `bits` folds that hash and clamps it so no agent gets an almost empty or
/// almost solid square; `hueIndex` indexes `Theme.agentHues`.
public struct Sigil: Sendable, Equatable {
	public let bits: UInt8
	public let hueIndex: Int

	public init(name: String) {
		let h = Self.hash(name)
		var b = UInt8((h ^ (h >> 11)) & 0xff)
		if b.nonzeroBitCount < 3 { b |= 0x93 }
		if b.nonzeroBitCount > 6 { b &= 0x6f }
		bits = b
		hueIndex = Int(h % 6)
	}

	/// Bit `row * 2 + min(column, 3 - column)`, so the grid mirrors
	/// left-to-right: column 0 reads as column 3, column 1 as column 2.
	public func isOn(row: Int, column: Int) -> Bool {
		((bits >> (row * 2 + min(column, 3 - column))) & 1) == 1
	}

	/// FNV-1a over the name's UTF-16 code units, matching `lib.mjs`
	/// (`charCodeAt` addresses UTF-16 units; `&*` is `Math.imul` wrap).
	public static func hash(_ name: String) -> UInt32 {
		var h: UInt32 = 2_166_136_261
		for unit in name.utf16 {
			h ^= UInt32(unit)
			h = h &* 16_777_619
		}
		return h
	}
}

/// The 4x4 sigil mark in the agent's hue; off cells rest at 13% opacity,
/// matching `lib.mjs`'s `sigil`.
public struct SigilView: View {
	private let sigil: Sigil
	private let size: CGFloat

	public init(name: String, size: CGFloat = 12) {
		sigil = Sigil(name: name)
		self.size = size
	}

	public var body: some View {
		let cell = size / 4
		VStack(spacing: 0) {
			ForEach(0 ..< 4, id: \.self) { row in
				HStack(spacing: 0) {
					ForEach(0 ..< 4, id: \.self) { column in
						RoundedRectangle(cornerRadius: cell * 0.22)
							.fill(Theme.agentHues[sigil.hueIndex].opacity(
								sigil.isOn(row: row, column: column) ? 1 : 0.13))
							.padding(cell * 0.11)
							.frame(width: cell, height: cell)
					}
				}
			}
		}
		.frame(width: size, height: size)
	}
}
