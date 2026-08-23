/**
 * Crash-safe tmux server watchdog.
 *
 * Spawns a private tmux server in a unique socket path with ownership tracking
 * via a control pipe. The watchdog process holds the direct ChildProcess handle
 * and one end of the pipe; when the test process closes its end (or exits),
 * the watchdog sees EOF and terminates its direct child tmux server only.
 * This ensures we never kill unrelated tmux processes, even if the test crashes.
 */

import { spawn, type ChildProcess } from "node:child_process";
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
 *
 * Optional tmuxExecutable parameter for test injection (default: "tmux").
 */
export async function startTmuxSession(
	name: string,
	timeoutMs: number = 5000,
	tmuxExecutable: string = "tmux",
	tmuxArgs: string[] = [],
): Promise<TmuxSession | undefined> {
	const socketDir = mkdtempSync(join(tmpdir(), `neta-tmux-${name}-`));
	chmodSync(socketDir, 0o700);

	const socketPath = join(socketDir, "server.sock");

	let watchdog: ChildProcess | undefined;
	try {
		// Start watchdog process that will manage the tmux server. The watchdog
		// holds the direct ChildProcess and waits for EOF on its stdin (from the
		// parent). On EOF, it terminates the direct child. This is crash-safe:
		// if the test is killed, the pipe EOF wakes the watchdog to clean up.
		watchdog = spawn(process.execPath, [WATCHDOG_HELPER, socketPath, tmuxExecutable, ...tmuxArgs], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
		});

		if (!watchdog.pid) throw new Error("Failed to spawn watchdog process.");
		const watchdogPid = watchdog.pid;

		// Wait for the watchdog to emit ready with verified server PID.
		const readyPayload = await new Promise<{ serverPid: number } | null>((resolve) => {
			const timeout = setTimeout(() => {
				resolve(null);
			}, timeoutMs);

			let buffer = "";
			const onData = (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines[lines.length - 1]; // Keep incomplete line

				for (let i = 0; i < lines.length - 1; i++) {
					const line = lines[i].trim();
					if (line) {
						try {
							clearTimeout(timeout);
							watchdog!.stdout?.removeListener("data", onData);
							watchdog!.removeListener("exit", onExit);
							resolve(JSON.parse(line));
							return;
						} catch {
							// Invalid JSON, keep waiting
						}
					}
				}
			};

			const onExit = () => {
				clearTimeout(timeout);
				watchdog!.stdout?.removeListener("data", onData);
				resolve(null);
			};

			watchdog!.stdout?.on("data", onData);
			watchdog!.once("exit", onExit);
		});

		if (!readyPayload?.serverPid) throw new Error("Watchdog startup timeout or invalid ready payload");

		// Wait for socket to exist.
		await waitFor(
			() => existsSync(socketPath),
			timeoutMs,
			100,
		);

		return {
			socket: socketPath,
			directory: socketDir,
			watchdogPid,
			async cleanup() {
				let watchdogExited = false;
				const cleanupError: Error[] = [];

				try {
					// Close the control pipe (test's stdin to watchdog). The watchdog sees
					// EOF and terminates its direct child tmux server, waiting boundedly,
					// then verifies pane descendants exited.
					if (watchdog!.stdin && !watchdog!.stdin.closed) {
						watchdog!.stdin.end();
					}
					watchdog!.unref();

					// Wait for watchdog to exit via the ChildProcess handle (bounded).
					watchdogExited = await new Promise<boolean>((resolve) => {
						const timeout = setTimeout(() => {
							resolve(false);
						}, 10000);
						watchdog!.once("exit", () => {
							clearTimeout(timeout);
							resolve(true);
						});
					});

					if (!watchdogExited) {
						throw new Error("Watchdog did not exit within 10s; server and directory left intact");
					}
				} catch (err) {
					if (err instanceof Error) {
						cleanupError.push(err);
					}
				}

				// Only remove directory after confirmed watchdog exit and server termination.
				if (watchdogExited) {
					try {
						rmSync(socketDir, { recursive: true, force: true });
					} catch (err) {
						if (err instanceof Error) {
							cleanupError.push(new Error(`Failed to remove directory: ${err.message}`));
						}
					}
				}

				// Surface all errors
				if (cleanupError.length > 0) {
					throw new Error(cleanupError.map((e) => e.message).join("; "));
				}
			},
		};
	} catch (error) {
		// Startup failed: close watchdog stdin, await bounded exit, remove directory only after confirmed.
		try {
			if (watchdog && watchdog.stdin && !watchdog.stdin.closed) {
				watchdog.stdin.end();
			}

			if (watchdog) {
				// Wait for watchdog to exit after stdin close.
				const exited = await new Promise<boolean>((resolve) => {
					const timeout = setTimeout(() => {
						resolve(false);
					}, 5000);
					watchdog!.once("exit", () => {
						clearTimeout(timeout);
						resolve(true);
					});
				});

				if (exited) {
					rmSync(socketDir, { recursive: true, force: true });
				}
			}
		} catch {
			// Directory left inert on cleanup failure
		}

		return undefined;
	}
}
