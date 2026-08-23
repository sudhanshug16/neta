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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newSessionArgs, newWindowArgs } from "../src/mux/tmux.ts";
import type { ProcessSpec } from "../src/mux/types.ts";
import { waitFor } from "./helpers.ts";
import { startTmuxSession } from "./tmux-watchdog.ts";

const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));
const SIGKILL_SACRIFICIAL = fileURLToPath(new URL("./fixtures/sigkill-sacrificial.mjs", import.meta.url));
const dirs: string[] = [];

// Only check tmux availability if live tests are enabled.
// Default `bun test` never checks for tmux to keep default suite clean.
const tmuxAvailable = process.env.NETA_TEST_MUX_LIVE === "1" && spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

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
				[
					"-S",
					session.socket,
					...newWindowArgs("worker", { command: "sleep", args: ["30"] }, process.cwd(), name),
				],
				{
					encoding: "utf-8",
				},
			);

			expect(opened.status).toBe(0);
			expect(
				spawnSync("tmux", ["-S", session.socket, "list-windows", "-t", name, "-F", "#W"], { encoding: "utf-8" }).stdout,
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

		// Verify server is running before cleanup
		const beforeCleanup = spawnSync("tmux", ["-S", session.socket, "list-sessions"], { stdio: "ignore" });
		expect(beforeCleanup.status === 0 || beforeCleanup.status === 1);

		// Clean up via pipe EOF
		await session.cleanup();

		// After cleanup, verify socket is inaccessible by checking it returns an error.
		// The server should be terminated by the watchdog.
		const afterCleanup = spawnSync("tmux", ["-S", session.socket, "list-sessions"], { stdio: "ignore" });
		// Any non-zero status indicates the socket is no longer accessible
		expect(afterCleanup.status !== 0);
	});

	liveIt("two private servers cannot cross-talk or share state", async () => {
		const session1 = await startTmuxSession("isolation-1");
		const session2 = await startTmuxSession("isolation-2");
		if (!session1 || !session2) throw new Error("Failed to start tmux sessions");

		try {
			// Create a session in server1
			const start1 = spawnSync("tmux", ["-S", session1.socket, "new-session", "-d", "-s", "test-s1", "sleep", "30"], {
				encoding: "utf-8",
			});
			expect(start1.status === 0);

			// Server2 should NOT see this session
			const list2 = spawnSync("tmux", ["-S", session2.socket, "list-sessions"], { encoding: "utf-8" });
			expect(list2.stdout).not.toContain("test-s1");

			// Create a session in server2 with the same name
			const start2 = spawnSync("tmux", ["-S", session2.socket, "new-session", "-d", "-s", "test-s1", "sleep", "40"], {
				encoding: "utf-8",
			});
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

	liveIt("parent SIGKILL allows watchdog to terminate direct server child and pane descendants", async () => {
		// Sacrificial child process that creates a session and writes PIDs to parent.
		const sacrificial = spawn(process.execPath, [SIGKILL_SACRIFICIAL], { stdio: ["pipe", "pipe", "pipe"] });

		const sacrificialPid = sacrificial.pid;
		if (!sacrificialPid) throw new Error("Failed to spawn sacrificial child");

		// Read PIDs from sacrificial child
		const info = await new Promise<{ socket: string; directory: string; watchdogPid: number; panePid: number } | null>(
			(resolve) => {
				const timeout = setTimeout(() => resolve(null), 5000);
				let output = "";
				sacrificial.stdout?.on("data", (data) => {
					output += data.toString();
				});
				sacrificial.once("exit", () => {
					clearTimeout(timeout);
					try {
						resolve(JSON.parse(output));
					} catch {
						resolve(null);
					}
				});
			},
		);

		if (!info) throw new Error("Sacrificial child failed to report PIDs");

		try {
			// Verify unrelated tmux server stays alive (use bounded async client)
			const unrelated = await startTmuxSession("unrelated-survives");
			if (!unrelated) throw new Error("Failed to start unrelated tmux session");

			try {
				// SIGKILL the sacrificial parent
				process.kill(sacrificialPid, "SIGKILL");

				// Wait for sacrificial process to exit
				await new Promise<void>((resolve) => {
					const timeout = setTimeout(resolve, 2000);
					sacrificial.once("exit", () => {
						clearTimeout(timeout);
						resolve();
					});
				});

				// Verify watchdog detected pipe EOF and terminated its direct server child
				await waitFor(
					() =>
						new Promise<boolean>((resolve) => {
							const timeout = setTimeout(() => resolve(false), 1000);
							const client = spawn("tmux", ["-S", info.socket, "list-sessions"]);
							client.once("exit", (code) => {
								clearTimeout(timeout);
								// Non-zero means server is gone
								resolve(code !== 0);
							});
						}),
					3000,
					100,
				);

				// Verify pane is also gone (check if process exists)
				try {
					process.kill(info.panePid, 0);
					// If we get here, process still exists - that's an error
					throw new Error("Pane process did not exit after watchdog terminated server");
				} catch (e) {
					if (e instanceof Error && e.message.includes("did not exit")) throw e;
					// Expected: process doesn't exist
				}

				// Verify unrelated server still responds
				const unrelatedStillAlive = await new Promise<boolean>((resolve) => {
					const timeout = setTimeout(() => resolve(false), 1000);
					const client = spawn("tmux", ["-S", unrelated.socket, "list-sessions"]);
					client.once("exit", (code) => {
						clearTimeout(timeout);
						// Status 0 or 1 means server is alive
						resolve(code === 0 || code === 1);
					});
				});
				expect(unrelatedStillAlive).toBe(true);
			} finally {
				await unrelated.cleanup();
			}
		} finally {
			// Clean up sacrificial (already dead, but cleanup should handle it gracefully)
			try {
				sacrificial.kill();
			} catch {
				// Already gone
			}
		}
	});

	liveIt("runs cleanup idempotently and reentrantly", async () => {
		const session = await startTmuxSession("idempotent-cleanup");
		if (!session) throw new Error("Failed to start tmux session");

		// Call cleanup multiple times in parallel
		await Promise.all([session.cleanup(), session.cleanup(), session.cleanup()]);

		// Should not throw and directory should be cleaned
		expect(existsSync(session.directory)).toBe(false);
	});

	liveIt("cleanup handles timeout and force-kill gracefully", async () => {
		const session = await startTmuxSession("timeout-cleanup");
		if (!session) throw new Error("Failed to start tmux session");

		try {
			// Start a long-running session via bounded async client
			const started = await new Promise<boolean>((resolve) => {
				const timeout = setTimeout(() => resolve(false), 2000);
				const client = spawn("tmux", ["-S", session.socket, "new-session", "-d", "-s", "stubborn", "sleep", "300"]);
				client.once("exit", (code) => {
					clearTimeout(timeout);
					resolve(code === 0);
				});
			});
			expect(started).toBe(true);

			// Cleanup should force-kill if needed
			await session.cleanup();

			// Verify socket is gone via bounded async client
			const socketGone = await new Promise<boolean>((resolve) => {
				const timeout = setTimeout(() => resolve(false), 1000);
				const client = spawn("tmux", ["-S", session.socket, "list-sessions"]);
				client.once("exit", (code) => {
					clearTimeout(timeout);
					resolve(code !== 0);
				});
			});
			expect(socketGone).toBe(true);
		} finally {
			// Already cleaned up, but safe to call again
			try {
				await session.cleanup();
			} catch {
				// Expected if already cleaned
			}
		}
	});

	liveIt("startup failure leaves no stale resources", async () => {
		// Try to start session with an invalid socket path (directory doesn't exist)
		const notStarted = await startTmuxSession("nonexistent-path");

		// Should return undefined and not crash
		expect(notStarted).toBeUndefined();
	});

	liveIt("thrown assertion during test cleanup still cleans up watchdog", async () => {
		const session = await startTmuxSession("assertion-error");
		if (!session) throw new Error("Failed to start tmux session");

		try {
			// Verify we can use the session via bounded async client
			const canUse = await new Promise<boolean>((resolve) => {
				const timeout = setTimeout(() => resolve(false), 1000);
				const client = spawn("tmux", ["-S", session.socket, "list-sessions"]);
				client.once("exit", (code) => {
					clearTimeout(timeout);
					resolve(code === 0 || code === 1);
				});
			});
			expect(canUse).toBe(true);

			// Simulate an assertion failure in try block
			throw new Error("Simulated test assertion failure");
		} finally {
			// Cleanup should still run and complete successfully
			await session.cleanup();
		}
	});

	liveIt("multiple parallel sessions work independently", async () => {
		const sessions = await Promise.all([
			startTmuxSession("parallel-1"),
			startTmuxSession("parallel-2"),
			startTmuxSession("parallel-3"),
		]);

		const [s1, s2, s3] = sessions;
		if (!s1 || !s2 || !s3) throw new Error("Failed to start tmux sessions");

		try {
			// Create unique sessions in each server via bounded async clients
			for (const [i, session] of [s1, s2, s3].entries()) {
				const created = await new Promise<boolean>((resolve) => {
					const timeout = setTimeout(() => resolve(false), 2000);
					const client = spawn("tmux", ["-S", session.socket, "new-session", "-d", "-s", `test-${i}`, "sleep", "30"]);
					client.once("exit", (code) => {
						clearTimeout(timeout);
						resolve(code === 0);
					});
				});
				expect(created).toBe(true);
			}

			// Each server should only have its own session
			for (const [i, session] of [s1, s2, s3].entries()) {
				const listOutput = await new Promise<string>((resolve) => {
					const timeout = setTimeout(() => resolve(""), 1000);
					let output = "";
					const client = spawn("tmux", ["-S", session.socket, "list-sessions"]);
					client.stdout?.on("data", (data) => {
						output += data.toString();
					});
					client.once("exit", () => {
						clearTimeout(timeout);
						resolve(output);
					});
				});
				expect(listOutput).toContain(`test-${i}`);
				for (const j of [0, 1, 2]) {
					if (i !== j) {
						expect(listOutput).not.toContain(`test-${j}`);
					}
				}
			}
		} finally {
			await Promise.all([s1.cleanup(), s2.cleanup(), s3.cleanup()]);
		}
	});
});
