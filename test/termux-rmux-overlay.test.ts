import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = dirname(import.meta.dir);
const prepareOverlay = join(root, "scripts/prepare-termux-rmux-overlay.sh");
const prepareBuild = join(root, "scripts/prepare-termux-rmux-android-build.sh");
const vendorBackend = join(root, "vendor/rmux/crates/rmux-pty/src/backend");
const vendorProcess = join(root, "vendor/rmux/crates/rmux-os/src/process.rs");
const vendorResize = join(root, "vendor/rmux/crates/rmux-client/src/attach/resize.rs");
const vendorLocale = join(root, "vendor/rmux/src/process_locale.rs");
const vendorSocketAccess = join(root, "vendor/rmux/crates/rmux-server/src/unix_socket_access.rs");
const temporary: string[] = [];

afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Termux rmux Android overlay", () => {
	test("patches a copied vendor tree without changing the reviewed source", () => {
		const work = mkdtempSync(join(tmpdir(), "neta rmux overlay "));
		temporary.push(work);
		const destination = join(work, "rmux with spaces");
		const originalMod = readFileSync(join(vendorBackend, "mod.rs"));
		const originalLinux = readFileSync(join(vendorBackend, "linux.rs"));
		const originalProcess = readFileSync(vendorProcess);
		const originalResize = readFileSync(vendorResize);
		const originalLocale = readFileSync(vendorLocale);
		const originalSocketAccess = readFileSync(vendorSocketAccess);

		const result = spawnSync(prepareOverlay, [destination], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(join(destination, "crates/rmux-pty/src/backend/mod.rs"))).toBe(true);
		const patchedMod = readFileSync(join(destination, "crates/rmux-pty/src/backend/mod.rs"), "utf8");
		const patchedLinux = readFileSync(join(destination, "crates/rmux-pty/src/backend/linux.rs"), "utf8");
		expect(patchedMod).toContain('any(target_os = "linux", target_os = "android")');
		expect(patchedLinux).toContain("open_slave_by_name(master)");
		expect(patchedLinux).toContain('#[cfg(target_os = "linux")]\nuse rustix::pty::ioctl_tiocgptpeer;');
		expect(readFileSync(join(destination, "crates/rmux-client/src/attach/resize.rs"), "utf8")).toContain('target_os = "android"');
		expect(readFileSync(join(destination, "src/process_locale.rs"), "utf8")).toContain('not(target_os = "android")');
		const patchedSocketAccess = readFileSync(join(destination, "crates/rmux-server/src/unix_socket_access.rs"), "utf8");
		expect(patchedSocketAccess).toContain("OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC");
		expect(patchedSocketAccess).toContain("if managed_by_rmux {");
		expect(patchedSocketAccess).not.toContain("endpoint: None,\n            access: UnixTransportAccess::OwnerOnly");
		expect(readFileSync(join(vendorBackend, "mod.rs"))).toEqual(originalMod);
		expect(readFileSync(join(vendorBackend, "linux.rs"))).toEqual(originalLinux);
		expect(readFileSync(vendorProcess)).toEqual(originalProcess);
		expect(readFileSync(vendorResize)).toEqual(originalResize);
		expect(readFileSync(vendorLocale)).toEqual(originalLocale);
		expect(readFileSync(vendorSocketAccess)).toEqual(originalSocketAccess);
	});

	test("refuses to replace an existing overlay", () => {
		const work = mkdtempSync(join(tmpdir(), "neta rmux overlay "));
		temporary.push(work);
		const destination = join(work, "existing");
		const first = spawnSync(prepareOverlay, [destination], { encoding: "utf8" });
		expect(first.status, first.stderr).toBe(0);
		const second = spawnSync(prepareOverlay, [destination], { encoding: "utf8" });
		expect(second.status).toBe(2);
		expect(second.stderr).toContain("destination already exists");
	});

	test("stages the Neta workspace with dependencies resolved through the overlay", () => {
		const work = mkdtempSync(join(tmpdir(), "neta rmux android build "));
		temporary.push(work);
		const destination = join(work, "build with spaces");
		const result = spawnSync(prepareBuild, [destination], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		const metadata = spawnSync("cargo", ["metadata", "--offline", "--no-deps", "--format-version", "1", "--manifest-path", join(destination, "Cargo.toml")], { encoding: "utf8" });
		expect(metadata.status, metadata.stderr).toBe(0);
		const parsed = JSON.parse(metadata.stdout) as { packages: Array<{ name: string; dependencies: Array<{ name: string; path?: string }> }> };
		const terminal = parsed.packages.find((pkg) => pkg.name === "neta-terminal");
		expect(terminal).toBeDefined();
		const sdk = terminal?.dependencies.find((dependency) => dependency.name === "rmux-sdk");
		expect(sdk?.path).toBe(join(destination, "vendor/rmux/crates/rmux-sdk"));
		expect(readFileSync(join(destination, "vendor/rmux/crates/rmux-pty/src/backend/mod.rs"), "utf8")).toContain('target_os = "android"');
	});
});
