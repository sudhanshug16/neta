/**
 * Crash-safe tmux server watchdog.
 *
 * Spawns a private tmux server in a unique directory with ownership tracking
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
	socket: string;
	directory: string;
	watchdogPid: number;
	cleanup(): Promise<void>;
}

const WATCHDOG_HELPER = fileURLToPath(new URL("./tmux-watchdog-helper.mjs", import.meta.url));

/**
 * Start a private tmux server and return its socket path. The server runs as a
 * child of a watchdog process that cleans up only when this process exits or
 * the returned cleanup function is called.
 *
 * All paths and descriptors owned by the watchdog until cleanup.
 */
export async function startTmuxSession(name: string, timeoutMs: number = 5000): Promise<TmuxSession | undefined> {
	const socketDir = mkdtempSync(join(tmpdir(), `neta-tmux-${name}-`));
	chmodSync(socketDir, 0o700);

	const socketPath = join(socketDir, "server.sock");

	try {
		// Start watchdog process that will manage the tmux server. The watchdog
		// waits for EOF on its stdin (from the parent) and then terminates its
		// tmux child. This is crash-safe: if the test is killed, the pipe EOF
		// wakes the watchdog to clean up.
		const watchdog = spawn(process.execPath, [WATCHDOG_HELPER, socketPath], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
		});

		const watchdogPid = watchdog.pid;
		if (!watchdogPid) throw new Error("Failed to spawn watchdog process.");

		// Wait for the watchdog's ready signal.
		const ready = await new Promise<boolean>((resolve) => {
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

		if (!ready) throw new Error("Watchdog startup timeout or early exit");

		// Verify the server is actually listening before returning.
		await waitFor(
			() => {
				const check = spawnSync("tmux", ["-S", socketPath, "list-sessions"], { stdio: "ignore" });
				return check.status === 0 || check.status === 1; // 0 = has sessions, 1 = no sessions but server exists
			},
			timeoutMs,
			100,
		);

		return {
			socket: socketPath,
			directory: socketDir,
			watchdogPid,
			async cleanup() {
				// Close the control pipe (test's stdin to watchdog). The watchdog sees
				// EOF and terminates its tmux server child, waiting boundedly. Then the
				// watchdog exits. We wait for it to ensure cleanup completes.
				if (watchdog.stdin && !watchdog.stdin.closed) {
					watchdog.stdin.end();
				}
				watchdog.unref();

				// Wait for watchdog to exit (up to 5 seconds).
				await new Promise<void>((resolve) => {
					const deadline = Date.now() + 5000;

					const checkInterval = setInterval(() => {
						if (processGone(watchdogPid) || Date.now() >= deadline) {
							clearInterval(checkInterval);
							resolve();
						}
					}, 100);
				});

				// If watchdog is still alive, it's stuck. Signal it and wait again.
				if (!processGone(watchdogPid)) {
					try {
						process.kill(watchdogPid, "SIGTERM");
						await new Promise<void>((resolve) => {
							const timeout = setTimeout(resolve, 1000);
							const checkInterval = setInterval(() => {
								if (processGone(watchdogPid)) {
									clearInterval(checkInterval);
									clearTimeout(timeout);
									resolve();
								}
							}, 50);
						});

						// Force kill if still not gone.
						if (!processGone(watchdogPid)) {
							process.kill(watchdogPid, "SIGKILL");
						}
					} catch {
						// Already gone
					}
				}

				// Clean up the socket directory. At this point the watchdog is gone and
				// the server is terminated, so the socket should be stale.
				try {
					rmSync(socketDir, { recursive: true, force: true });
				} catch {
					// Directory already gone or in use; fail closed.
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
