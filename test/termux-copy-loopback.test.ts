import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("loopback harness failure retains evidence and reaps its child", () => {
	const root = process.cwd();
	const output = mkdtempSync(join("/private/tmp", "neta-copy-harness-test-"));
	const fake = join(output, "fake-sshd.sh");
	const pidFile = join(output, "fake.pid");
	writeFileSync(fake, '#!/bin/sh\necho "$$" > "$FAKE_PID_FILE"\nexec sleep 60\n');
	chmodSync(fake, 0o755);
	const result = spawnSync(join(root, "scripts/termux-copy-loopback.sh"), [
		"--output", join(output, "run"),
		"--emulator", "fake-emulator",
		"--port", "2345",
	], {
		env: { ...process.env, NETA_COPY_SKIP_ADB: "1", NETA_COPY_SSHD_BIN: fake, FAKE_PID_FILE: pidFile },
		encoding: "utf8",
		timeout: 15000,
	});
	try {
		const run = join(output, "run");
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("SSH daemon did not start");
		expect(existsSync(run)).toBe(true);
		expect(existsSync(join(run, "node-start.log"))).toBe(true);
		expect(existsSync(join(run, "ssh", "id_ed25519"))).toBe(false);
		expect(existsSync(join(run, "ssh", "ssh_host_ed25519_key"))).toBe(false);
		const fakePid = Number(readFileSync(pidFile, "utf8"));
		expect(Number.isInteger(fakePid)).toBe(true);
		expect(() => process.kill(fakePid, 0)).toThrow();
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
}, 20000);
