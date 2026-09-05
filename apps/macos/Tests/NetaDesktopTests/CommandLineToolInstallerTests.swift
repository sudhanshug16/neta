import Foundation
import XCTest

@testable import NetaDesktop

final class CommandLineToolInstallerTests: XCTestCase {
	func testInstallCreatesLinkAndRepeatingItIsHarmless() throws {
		let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		defer { try? FileManager.default.removeItem(at: root) }
		try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
		let source = root.appendingPathComponent("bundle/neta")
		try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
		try Data("tool".utf8).write(to: source)
		try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: source.path)
		let destination = root.appendingPathComponent("bin/neta")

		try CommandLineToolInstaller.install(source: source, destination: destination)
		try CommandLineToolInstaller.install(source: source, destination: destination)

		XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: destination.path), source.path)
	}

	func testInstallNeverOverwritesExistingDestination() throws {
		let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		defer { try? FileManager.default.removeItem(at: root) }
		try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
		let source = root.appendingPathComponent("neta")
		let destination = root.appendingPathComponent("existing")
		try Data("tool".utf8).write(to: source)
		try Data("keep me".utf8).write(to: destination)
		try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: source.path)

		XCTAssertThrowsError(try CommandLineToolInstaller.install(source: source, destination: destination)) {
			XCTAssertEqual($0 as? CommandLineToolInstallError, .destinationExists)
		}
		XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "keep me")
	}

	func testPermissionFailureUsesAuthorizationWithExactPathsAndVerifiesLink() throws {
		let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		defer { try? FileManager.default.removeItem(at: root) }
		try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
		let source = root.appendingPathComponent("bundle tool")
		let destination = root.appendingPathComponent("bin/neta")
		try Data("tool".utf8).write(to: source)
		try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: source.path)
		var authorized: (URL, URL)?

		try CommandLineToolInstaller.install(
			source: source, destination: destination,
			link: { _, _ in throw NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES)) },
			authorize: { authorized = ($0, $1)
				try FileManager.default.createDirectory(at: $1.deletingLastPathComponent(), withIntermediateDirectories: true)
				try FileManager.default.createSymbolicLink(at: $1, withDestinationURL: $0)
			})

		XCTAssertEqual(authorized?.0, source)
		XCTAssertEqual(authorized?.1, destination)
		XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: destination.path), source.path)
	}

	func testAuthorizationThatDoesNotCreateExpectedLinkFailsVerification() throws {
		let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		defer { try? FileManager.default.removeItem(at: root) }
		try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
		let source = root.appendingPathComponent("neta")
		try Data("tool".utf8).write(to: source)
		try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: source.path)

		XCTAssertThrowsError(try CommandLineToolInstaller.install(
			source: source, destination: root.appendingPathComponent("bin/neta"),
			link: { _, _ in throw NSError(domain: NSPOSIXErrorDomain, code: Int(EPERM)) },
			authorize: { _, _ in })) {
			XCTAssertEqual($0 as? CommandLineToolInstallError, .verificationFailed)
		}
	}
}
