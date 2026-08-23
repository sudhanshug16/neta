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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
let tmuxAvailable = false;
if (process.env.NETA_TEST_MUX_LIVE === "1") {
	tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
}

// Only run these tests if explicitly enabled via environment variable.
// Default `bun test` never runs this file.
const liveIt = process.env.NETA_TEST_MUX_LIVE === "1" && tmuxAvailable ? it : it.skip;

// Bounded async tmux client: runs command, collects stdout, enforces timeout.
async function tmuxClient(
	socketPath: string,
	args: string[],
	timeoutMs: number = 2000,
): Promise<{ code: number; stdout: string; error?: Error }> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			client.kill();
			resolve({ code: -1, stdout: "", error: new Error("tmux client timeout") });
		}, timeoutMs);

		let stdout = "";
		const client = spawn("tmux", ["-S", socketPath, ...args]);

		client.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		client.once("exit", (code) => {
			clearTimeout(timeout);
			resolve({ code: code ?? -1, stdout });
		});

		client.once("error", (err) => {
			clearTimeout(timeout);
			resolve({ code: -1, stdout, error: err });
		});
	});
}

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

async function start(socketPath: string, name: string, spec: ProcessSpec): Promise<void> {
	const args = newSessionArgs(name, spec);
	args.splice(1, 0, "-d");
	const result = await tmuxClient(socketPath, args, 3000);
	if (result.code !== 0) throw new Error(`tmux exited ${result.code}`);
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
			const started = await tmuxClient(session.socket, ["new-session", "-d", "-s", name, "sleep", "30"], 2000);
			expect(started.code).toBe(0);

			const windowArgs = newWindowArgs("worker", { command: "sleep", args: ["30"] }, process.cwd(), name);
			const opened = await tmuxClient(session.socket, windowArgs, 2000);

			expect(opened.code).toBe(0);

			const listed = await tmuxClient(session.socket, ["list-windows", "-t", name, "-F", "#W"], 2000);
			expect(listed.stdout).toContain("worker");
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
					await start(
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
					expect(env.NETA_DIR).toEqual(agentDir);
					expect(env.NETA_SOCKET).toEqual(channel);
					expect(env.NETA_SESSION_ID).toEqual(sessionId);
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
		const beforeCleanup = await tmuxClient(session.socket, ["list-sessions"], 2000);
		expect([0, 1]).toContain(beforeCleanup.code);

		// Clean up via pipe EOF
		await session.cleanup();

		// After cleanup, verify socket is inaccessible by checking it returns an error.
		const afterCleanup = await tmuxClient(session.socket, ["list-sessions"], 1000);
		// Non-zero status indicates socket is no longer accessible
		expect(afterCleanup.code).not.toBe(0);
	});

	liveIt("two private servers cannot cross-talk or share state", async () => {
		const session1 = await startTmuxSession("isolation-1");
		const session2 = await startTmuxSession("isolation-2");
		if (!session1 || !session2) throw new Error("Failed to start tmux sessions");

		try {
			// Create a session in server1
			const start1 = await tmuxClient(session1.socket, ["new-session", "-d", "-s", "test-s1", "sleep", "30"], 2000);
			expect(start1.code).toBe(0);

			// Server2 should NOT see this session
			const list2 = await tmuxClient(session2.socket, ["list-sessions"], 2000);
			expect(list2.stdout).not.toContain("test-s1");

			// Create a session in server2 with the same name
			const start2 = await tmuxClient(session2.socket, ["new-session", "-d", "-s", "test-s1", "sleep", "40"], 2000);
			expect(start2.code).toBe(0);

			// Each server should have its own session
			const list1 = await tmuxClient(session1.socket, ["list-sessions"], 2000);
			const list2After = await tmuxClient(session2.socket, ["list-sessions"], 2000);

			expect(list1.stdout).toContain("test-s1");
			expect(list2After.stdout).toContain("test-s1");

			// Both should work independently
			expect(list1.code).toBe(0);
			expect(list2After.code).toBe(0);
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

		// Read PIDs from sacrificial child incrementally while child is alive.
		const info = await new Promise<{ socket: string; directory: string; watchdogPid: number; panePid: number } | null>(
			(resolve) => {
				const timeout = setTimeout(() => resolve(null), 5000);
				let buffer = "";

				sacrificial.stdout?.on("data", (chunk) => {
					buffer += chunk.toString();
					const lines = buffer.split("\n");

					for (let i = 0; i < lines.length - 1; i++) {
						const line = lines[i].trim();
						if (line) {
							try {
								clearTimeout(timeout);
								sacrificial.stdout?.pause();
								resolve(JSON.parse(line));
								return;
							} catch {
								// Invalid JSON, keep buffering
							}
						}
					}

					buffer = lines[lines.length - 1];
				});

				sacrificial.once("exit", () => {
					clearTimeout(timeout);
					resolve(null);
				});
			},
		);

		expect(info).toBeDefined();
		if (!info) throw new Error("Sacrificial child failed to report PIDs");

		try {
			// Verify unrelated tmux server stays alive
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
					async () => {
						const result = await tmuxClient(info.socket, ["list-sessions"], 1000);
						return result.code !== 0;
					},
					3000,
					100,
				);

				// Verify pane is also gone
				try {
					process.kill(info.panePid, 0);
					throw new Error("Pane process did not exit after watchdog terminated server");
				} catch (e) {
					if (e instanceof Error && e.message.includes("did not exit")) throw e;
					// Expected: process doesn't exist
				}

				// Verify unrelated server still responds
				const unrelatedResult = await tmuxClient(unrelated.socket, ["list-sessions"], 1000);
				expect([0, 1]).toContain(unrelatedResult.code);
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
			const started = await tmuxClient(session.socket, ["new-session", "-d", "-s", "stubborn", "sleep", "300"], 2000);
			expect(started.code).toBe(0);

			// Cleanup should force-kill if needed
			await session.cleanup();

			// Verify socket is gone via bounded async client
			const socketGone = await tmuxClient(session.socket, ["list-sessions"], 1000);
			expect(socketGone.code).not.toBe(0);
		} finally {
			// Already cleaned up, but safe to call again
			try {
				await session.cleanup();
			} catch {
				// Expected if already cleaned
			}
		}
	});

	liveIt("startup failure cleans up directory and watchdog gracefully", async () => {
		// Use an injected failing tmux executable to force startup failure.
		// The failing executable always exits with code 1.
		const FAILING_TMUX = fileURLToPath(new URL("./fixtures/failing-tmux.mjs", import.meta.url));

		// Test with failing executable: should return undefined, cleanup all resources.
		const result = await startTmuxSession("fail-startup", 5000, process.execPath, [FAILING_TMUX]);

		expect(result).toBeUndefined();
	});

	liveIt("thrown assertion during test cleanup still cleans up watchdog", async () => {
		const session = await startTmuxSession("assertion-error");
		if (!session) throw new Error("Failed to start tmux session");

		let assertionErrorCaught = false;
		let cleanupCompleted = false;

		try {
			// Verify we can use the session via bounded async client
			const canUse = await tmuxClient(session.socket, ["list-sessions"], 1000);
			expect([0, 1]).toContain(canUse.code);

			// Simulate an assertion failure in try block
			throw new Error("Simulated test assertion failure");
		} catch (err) {
			assertionErrorCaught = true;
			if (!(err instanceof Error) || !err.message.includes("assertion failure")) {
				throw err; // Re-throw if not our simulated error
			}
		} finally {
			// Cleanup should still run and complete successfully
			await session.cleanup();
			cleanupCompleted = true;
		}

		// Verify both error and cleanup happened
		expect(assertionErrorCaught).toBe(true);
		expect(cleanupCompleted).toBe(true);
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
				const created = await tmuxClient(session.socket, ["new-session", "-d", "-s", `test-${i}`, "sleep", "30"], 2000);
				expect(created.code).toBe(0);
			}

			// Each server should only have its own session
			for (const [i, session] of [s1, s2, s3].entries()) {
				const listResult = await tmuxClient(session.socket, ["list-sessions"], 1000);
				expect(listResult.stdout).toContain(`test-${i}`);
				for (const j of [0, 1, 2]) {
					if (i !== j) {
						expect(listResult.stdout).not.toContain(`test-${j}`);
					}
				}
			}
		} finally {
			await Promise.all([s1.cleanup(), s2.cleanup(), s3.cleanup()]);
		}
	});
});
