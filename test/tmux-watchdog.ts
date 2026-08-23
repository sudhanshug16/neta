/**
 * Crash-safe tmux server watchdog.
 *
 * Spawns a private tmux server in a unique socket path with ownership tracking
 * via a control pipe. The watchdog process holds the direct ChildProcess handle
 * and one end of the pipe; when the test process closes its end (or exits),
 * the watchdog sees EOF and terminates its direct child tmux server only.
 * This ensures we never kill unrelated tmux processes, even if the test crashes.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
		// holds the direct ChildProcess and waits for EOF on its stdin (from the
		// parent). On EOF, it terminates the direct child. This is crash-safe:
		// if the test is killed, the pipe EOF wakes the watchdog to clean up.
		const watchdog = spawn(process.execPath, [WATCHDOG_HELPER, socketPath], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
		});

		const watchdogPid = watchdog.pid;
		if (!watchdogPid) throw new Error("Failed to spawn watchdog process.");

		// Wait for the watchdog to signal it started the tmux process.
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

		// Wait for socket to exist.
		await waitFor(
			() => existsSync(socketPath),
			timeoutMs,
			100,
		);

		// Verify the server is actually running and responding to clients.
		// Use bounded async client with explicit timeout.
		const serverResponds = await new Promise<boolean>((resolve) => {
			const timeout = setTimeout(() => {
				resolve(false);
			}, timeoutMs);

			const client = spawn("tmux", ["-S", socketPath, "display-message", "-p", "#{pid}"], {
				stdio: ["ignore", "pipe", "pipe"],
			});

			client.once("exit", (code) => {
				clearTimeout(timeout);
				// Exit 0 means server is running and responded
				resolve(code === 0);
			});

			client.once("error", () => {
				clearTimeout(timeout);
				resolve(false);
			});
		});

		if (!serverResponds) throw new Error("Server did not respond to client request");

		return {
			socket: socketPath,
			directory: socketDir,
			watchdogPid,
			async cleanup() {
				try {
					// Close the control pipe (test's stdin to watchdog). The watchdog sees
					// EOF and terminates its direct child tmux server, waiting boundedly,
					// then verifies pane descendants exited.
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
