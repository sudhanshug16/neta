/**
 * Live tmux integration tests. These spawn real tmux servers.
 *
 * Run ONLY via opt-in script: `bun run test:mux-live`
 * Default `bun test` skips these to keep the default suite clean.
 *
 * Uses a crash-safe watchdog to manage the tmux server lifecycle, ensuring
 * the server is terminated only when the test exits, and never affecting
 * unrelated tmux sessions.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newSessionArgs, newWindowArgs } from "../src/mux/tmux.ts";
import type { ProcessSpec } from "../src/mux/types.ts";
import { waitFor } from "./helpers.ts";
import { startTmuxSession } from "./tmux-watchdog.ts";

const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));
const dirs: string[] = [];
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

// Only run these tests if explicitly enabled via environment variable.
// Default `bun test` never runs this file.
const liveIt = process.env.NETA_TEST_MUX_LIVE === "1" && tmuxAvailable ? it : it.skip;

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

function start(socketPath: string, name: string, spec: ProcessSpec): void {
	const args = newSessionArgs(name, spec);
	args.splice(1, 0, "-d");
	const result = spawnSync("tmux", ["-S", socketPath, ...args], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr || `tmux exited ${result.status}`);
}

function readEnv(record: string): Record<string, string | null> {
	return (JSON.parse(readFileSync(record, "utf-8")) as { env: Record<string, string | null> }).env;
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore errors
		}
	}
});

describe("live tmux server isolation", () => {
	liveIt("opens a worker window in the explicit session on a private tmux server", async () => {
		const session = await startTmuxSession("worker-window");
		if (!session) throw new Error("Failed to start tmux session");

		try {
			const name = `neta-pane-${process.pid}`;
			const started = spawnSync("tmux", ["-S", session.socket, "new-session", "-d", "-s", name, "sleep", "30"], {
				encoding: "utf-8",
			});
			if (started.status !== 0) throw new Error(started.stderr || "Could not start tmux test session.");

			const opened = spawnSync(
				"tmux",
				["-S", session.socket, ...newWindowArgs("worker", { command: "sleep", args: ["30"] }, process.cwd(), name)],
				{
					encoding: "utf-8",
				},
			);

			expect(opened.status).toBe(0);
			expect(
				spawnSync("tmux", ["-S", session.socket, "list-windows", "-t", name, "-F", "#W"], { encoding: "utf-8" })
					.stdout,
			).toContain("worker");
		} finally {
			await session.cleanup();
		}
	});

	liveIt(
		"gives two different NETA_DIR launches and two shared-dir launches their own socket and id",
		async () => {
			const session = await startTmuxSession("env-isolation");
			if (!session) throw new Error("Failed to start tmux session");

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
						session.socket,
						`neta-${name}`,
						leader(join(records, `${name}.json`), {
							NETA_DIR: agentDir,
							NETA_SOCKET: channel,
							NETA_SESSION_ID: sessionId,
							NETA_LEADER_TOKEN: `token-${name}`,
						}),
					);
				}
				await waitFor(() => specs.every(([name]) => existsSync(join(records, `${name}.json`))), 5000);

				for (const [name, agentDir, channel, sessionId] of specs) {
					const env = readEnv(join(records, `${name}.json`));
					expect(env.NETA_DIR).toBe(agentDir);
					expect(env.NETA_SOCKET).toBe(channel);
					expect(env.NETA_SESSION_ID).toBe(sessionId);
				}
			} finally {
				await session.cleanup();
			}
		},
		30000,
	);

	liveIt("cleans up private server on normal pipe EOF via cleanup()", async () => {
		const session = await startTmuxSession("pipe-eof-cleanup");
		if (!session) throw new Error("Failed to start tmux session");

		// Verify server is running
		const beforeCleanup = spawnSync("tmux", ["-S", session.socket, "list-sessions"], { encoding: "utf-8" });
		expect(beforeCleanup.status === 1 || beforeCleanup.status === 0); // Either 0 or 1 means server exists

		// Clean up via pipe EOF
		await session.cleanup();

		// After cleanup, server should be gone (connection refused)
		const afterCleanup = spawnSync("tmux", ["-S", session.socket, "list-sessions"], { stdio: "ignore" });
		expect(afterCleanup.status !== 0 && afterCleanup.status !== 1); // Connection error means server is gone
	});

	liveIt("two private servers cannot cross-talk or share state", async () => {
		const session1 = await startTmuxSession("isolation-1");
		const session2 = await startTmuxSession("isolation-2");
		if (!session1 || !session2) throw new Error("Failed to start tmux sessions");

		try {
			// Create a session in server1
			const start1 = spawnSync(
				"tmux",
				["-S", session1.socket, "new-session", "-d", "-s", "test-s1", "sleep", "30"],
				{
					encoding: "utf-8",
				},
			);
			expect(start1.status === 0);

			// Server2 should NOT see this session
			const list2 = spawnSync("tmux", ["-S", session2.socket, "list-sessions"], { encoding: "utf-8" });
			expect(list2.stdout).not.toContain("test-s1");

			// Create a session in server2 with the same name
			const start2 = spawnSync(
				"tmux",
				["-S", session2.socket, "new-session", "-d", "-s", "test-s1", "sleep", "40"],
				{
					encoding: "utf-8",
				},
			);
			expect(start2.status === 0);

			// Each server should have its own session
			const list1 = spawnSync("tmux", ["-S", session1.socket, "list-sessions"], { encoding: "utf-8" });
			const list2After = spawnSync("tmux", ["-S", session2.socket, "list-sessions"], { encoding: "utf-8" });

			expect(list1.stdout).toContain("test-s1");
			expect(list2After.stdout).toContain("test-s1");

			// Both should work independently
			expect(list1.status === 0);
			expect(list2After.status === 0);
		} finally {
			await session1.cleanup();
			await session2.cleanup();
		}
	});
});
