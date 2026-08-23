/**
 * Crash-safe tmux server watchdog.
 *
 * Spawns a private tmux server using a unique socket name with ownership tracking
 * via a control pipe. The watchdog process holds one end of the pipe; when the
 * test process closes its end (or exits), the watchdog sees EOF and terminates
 * its direct child tmux server only. This ensures we never kill unrelated tmux
 * processes, even if the test crashes.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processGone, waitFor } from "./helpers.ts";

interface TmuxSession {
	socketName: string;
	directory: string;
	watchdogPid: number;
	cleanup(): Promise<void>;
}

const WATCHDOG_HELPER = fileURLToPath(new URL("./tmux-watchdog-helper.mjs", import.meta.url));

/**
 * Start a private tmux server and return its socket name. The server runs as a
 * child of a watchdog process that cleans up only when this process exits or
 * the returned cleanup function is called.
 *
 * All paths and descriptors owned by the watchdog until cleanup.
 */
export async function startTmuxSession(name: string, timeoutMs: number = 5000): Promise<TmuxSession | undefined> {
	const socketDir = mkdtempSync(join(tmpdir(), `neta-tmux-${name}-`));
	chmodSync(socketDir, 0o700);

	// Use a unique socket name that won't collide with other tmux sessions.
	// This is a tmux socket name (used with -L), not a file path.
	const socketName = `neta-${name}-${process.pid}-${Date.now()}`;

	try {
		// Start watchdog process that will manage the tmux server. The watchdog
		// waits for EOF on its stdin (from the parent) and then terminates its
		// tmux child. This is crash-safe: if the test is killed, the pipe EOF
		// wakes the watchdog to clean up.
		const watchdog = spawn(process.execPath, [WATCHDOG_HELPER, socketName], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
		});

		const watchdogPid = watchdog.pid;
		if (!watchdogPid) throw new Error("Failed to spawn watchdog process.");

		// Wait for the watchdog to signal it started the tmux process.
		const started = await new Promise<boolean>((resolve) => {
			const timeout = setTimeout(() => {
				resolve(false);
			}, timeoutMs);

			const onData = () => {
				clearTimeout(timeout);
				watchdog.stdout?.removeListener("data", onData);
				watchdog.removeListener("exit", onExit);
				resolve(true);
			};

			const onExit = () => {
				clearTimeout(timeout);
				watchdog.stdout?.removeListener("data", onData);
				resolve(false);
			};

			watchdog.stdout?.on("data", onData);
			watchdog.once("exit", onExit);
		});

		if (!started) throw new Error("Watchdog startup timeout or early exit");

		// Verify the server is actually responding to commands.
		await waitFor(
			() => {
				const check = spawnSync("tmux", ["-L", socketName, "list-sessions"], { stdio: "ignore" });
				// Status 0 (has sessions) or 1 (no sessions but server exists) both mean server is alive
				return check.status === 0 || check.status === 1;
			},
			timeoutMs,
			100,
		);

		return {
			socketName,
			directory: socketDir,
			watchdogPid,
			async cleanup() {
				try {
					// Close the control pipe (test's stdin to watchdog). The watchdog sees
					// EOF and terminates its tmux server child, waiting boundedly.
					if (watchdog.stdin && !watchdog.stdin.closed) {
						watchdog.stdin.end();
					}
					watchdog.unref();

					// Wait for watchdog to exit via the ChildProcess handle (up to 5 seconds).
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(resolve, 5000);
						watchdog.once("exit", () => {
							clearTimeout(timeout);
							resolve();
						});
					});

					// If watchdog is still alive (didn't exit), signal it.
					if (!processGone(watchdogPid)) {
						try {
							process.kill(watchdogPid, "SIGTERM");
							await new Promise<void>((resolve) => {
								const timeout = setTimeout(resolve, 1000);
								watchdog.once("exit", () => {
									clearTimeout(timeout);
									resolve();
								});
							});

							// Force kill if still not gone.
							if (!processGone(watchdogPid)) {
								process.kill(watchdogPid, "SIGKILL");
							}
						} catch {
							// Already gone
						}
					}
				} finally {
					// Clean up the socket directory. Only remove after confirming ownership
					// via watchdog exit and server termination.
					try {
						rmSync(socketDir, { recursive: true, force: true });
					} catch {
						// Directory in use or already gone; fail closed by leaving it.
					}
				}
			},
		};
	} catch (_error) {
		// Cleanup on failure
		try {
			rmSync(socketDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors on startup failure
		}
		return undefined;
	}
}
