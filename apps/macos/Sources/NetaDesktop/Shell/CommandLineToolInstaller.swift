import AppKit
import Foundation

enum CommandLineToolInstallError: LocalizedError, Equatable {
	case bundledToolMissing, destinationExists, authorizationFailed, verificationFailed

	var errorDescription: String? {
		switch self {
		case .bundledToolMissing: "The bundled neta command-line tool could not be found."
		case .destinationExists: "A different file already exists at /usr/local/bin/neta. Nothing was replaced."
		case .authorizationFailed: "Administrator authorization was cancelled or failed. Nothing was installed."
		case .verificationFailed: "The command-line tool could not be verified after installation."
		}
	}
}

enum CommandLineToolInstaller {
	static let destination = URL(fileURLWithPath: "/usr/local/bin/neta")
	typealias Link = (URL, URL) throws -> Void
	typealias Authorize = (URL, URL) throws -> Void

	static func install(
		source: URL, destination: URL = destination,
		fileManager: FileManager = .default, link: Link? = nil,
		authorize: Authorize = authorizeWithSystemDialog
	) throws {
		guard fileManager.isExecutableFile(atPath: source.path) else {
			throw CommandLineToolInstallError.bundledToolMissing
		}
		if entryExists(destination, fileManager: fileManager) {
			guard linkPointsToSource(destination, source: source, fileManager: fileManager) else {
				throw CommandLineToolInstallError.destinationExists
			}
			return
		}
		do {
			if let link { try link(source, destination) }
			else {
				try fileManager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
				try fileManager.createSymbolicLink(at: destination, withDestinationURL: source)
			}
		} catch {
			guard isPermissionError(error) else { throw error }
			try authorize(source, destination)
		}
		guard linkPointsToSource(destination, source: source, fileManager: fileManager) else {
			throw CommandLineToolInstallError.verificationFailed
		}
	}

	@MainActor static func present() {
		guard let source = Bundle.main.url(forResource: "neta", withExtension: nil) else {
			show(CommandLineToolInstallError.bundledToolMissing.localizedDescription); return
		}
		do {
			try install(source: source)
			show("The neta command is available at /usr/local/bin/neta.", title: "Command Line Tool Installed")
		} catch { show(error.localizedDescription) }
	}

	static func isPermissionError(_ error: Error) -> Bool {
		let error = error as NSError
		return (error.domain == NSPOSIXErrorDomain && [Int(EACCES), Int(EPERM)].contains(error.code))
			|| (error.domain == NSCocoaErrorDomain && error.code == CocoaError.fileWriteNoPermission.rawValue)
	}

	private static func entryExists(_ url: URL, fileManager: FileManager) -> Bool {
		(try? fileManager.attributesOfItem(atPath: url.path)) != nil
	}

	private static func linkPointsToSource(_ destination: URL, source: URL, fileManager: FileManager) -> Bool {
		guard let target = try? fileManager.destinationOfSymbolicLink(atPath: destination.path) else { return false }
		return URL(fileURLWithPath: target, relativeTo: destination.deletingLastPathComponent()).standardizedFileURL
			== source.standardizedFileURL
	}

	private static func authorizeWithSystemDialog(source: URL, destination: URL) throws {
		let script = """
		on run argv
		  set sourcePath to item 1 of argv
		  set destinationPath to item 2 of argv
		  set parentPath to do shell script "/usr/bin/dirname " & quoted form of destinationPath
		  do shell script "/bin/mkdir -p " & quoted form of parentPath & " && /bin/ln -s " & quoted form of sourcePath & " " & quoted form of destinationPath with administrator privileges
		end run
		"""
		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
		process.arguments = ["-e", script, source.path, destination.path]
		try process.run()
		process.waitUntilExit()
		guard process.terminationStatus == 0 else { throw CommandLineToolInstallError.authorizationFailed }
	}

	@MainActor private static func show(_ message: String, title: String = "Could Not Install Command Line Tool") {
		let alert = NSAlert(); alert.messageText = title; alert.informativeText = message; alert.runModal()
	}
}
