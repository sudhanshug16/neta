/**
 * Real tmux uses one server process and captures that server's environment at
 * its first session. Run against a private server so this never touches a
 * developer's existing tmux session.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newSessionArgs } from "../src/mux/tmux.ts";
import type { ProcessSpec } from "../src/mux/types.ts";
import { waitFor } from "./helpers.ts";

const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));
const dirs: string[] = [];
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const tmuxIt = tmuxAvailable ? it : it.skip;

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function leader(record: string, env: Record<string, string>): ProcessSpec {
	return {
		command: process.execPath,
		args: [FAKE_LEADER],
		env: { ...process.env, ...env, FAKE_LEADER_RECORD: record, FAKE_LEADER_HOLD_MS: "1000" },
	};
}

function start(tmuxSocket: string, name: string, spec: ProcessSpec): void {
	const args = newSessionArgs(name, spec);
	args.splice(1, 0, "-d");
	const result = spawnSync("tmux", ["-L", tmuxSocket, ...args], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr || `tmux exited ${result.status}`);
}

function readEnv(record: string): Record<string, string | null> {
	return (JSON.parse(readFileSync(record, "utf-8")) as { env: Record<string, string | null> }).env;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tmux leader environment isolation", () => {
	tmuxIt("gives two different NETA_DIR launches and two shared-dir launches their own socket and id", async () => {
		const socket = `neta-test-${process.pid}-${Date.now()}`;
		const records = scratch("neta-tmux-records-");
		const firstDir = scratch("neta-tmux-home-a-");
		const secondDir = scratch("neta-tmux-home-b-");
		const sharedDir = scratch("neta-tmux-home-shared-");
		const specs = [
			["a", firstDir, "/tmp/neta-a.sock", "a-id"],
			["b", secondDir, "/tmp/neta-b.sock", "b-id"],
			["c", sharedDir, "/tmp/neta-c.sock", "c-id"],
			["d", sharedDir, "/tmp/neta-d.sock", "d-id"],
		] as const;

		try {
			for (const [name, agentDir, channel, sessionId] of specs) {
				start(
					socket,
					`neta-${name}`,
					leader(join(records, `${name}.json`), {
						NETA_DIR: agentDir,
						NETA_SOCKET: channel,
						NETA_SESSION_ID: sessionId,
						NETA_LEADER_TOKEN: `token-${name}`,
					}),
				);
			}
			await waitFor(() => {
				for (const [name] of specs) expect(() => readFileSync(join(records, `${name}.json`))).not.toThrow();
			}, 5000);

			for (const [name, agentDir, channel, sessionId] of specs) {
				const env = readEnv(join(records, `${name}.json`));
				expect(env.NETA_DIR).toBe(agentDir);
				expect(env.NETA_SOCKET).toBe(channel);
				expect(env.NETA_SESSION_ID).toBe(sessionId);
			}
		} finally {
			spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
		}
	});

	it.skip("skips live Zellij matrix: its layout environment is covered by unit tests; no shared-server repro is available.", () => {});
});
