import Foundation
import Observation

@MainActor @Observable
public final class ProjectActions {
	public private(set) var errorMessage: String?
	public private(set) var isOpening = false

	public init() {}

	@discardableResult
	public func open(_ url: URL, using opener: (URL) async -> Bool) async -> Bool {
		errorMessage = nil
		isOpening = true
		defer { isOpening = false }
		guard await opener(url) else {
			errorMessage = "Neta could not open \(url.lastPathComponent)."
			return false
		}
		return true
	}

	@discardableResult
	public func create(
		_ url: URL,
		fileManager: FileManager = .default,
		using opener: (URL) async -> Bool
	) async -> Bool {
		errorMessage = nil
		guard !fileManager.fileExists(atPath: url.path) else {
			errorMessage = "A file or folder already exists at that location."
			return false
		}
		do {
			try fileManager.createDirectory(at: url, withIntermediateDirectories: false)
		} catch {
			errorMessage = "Neta could not create \(url.lastPathComponent): \(error.localizedDescription)"
			return false
		}
		return await open(url, using: opener)
	}

	public func dismissError() { errorMessage = nil }
}
