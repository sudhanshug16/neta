/**
 * Watchdog process that manages a private tmux server.
 * Run as: node tmux-watchdog-helper.mjs <socketPath>
 *
 * The watchdog:
 * 1. Starts a tmux server with -D -S <socketPath> (daemon mode, no session)
 * 2. Verifies server PID via bounded async tmux client
 * 3. Emits ready with server PID
 * 4. Waits for EOF on stdin (parent closes or exits)
 * 5. Signals direct server child, waits for exit, verifies descendants gone
 * 6. Exits
 */

import { spawn } from "node:child_process";

const socketPath = process.argv[2];
const tmuxExecutable = process.argv[3] || "tmux";
const extraArgs = process.argv.slice(4);

if (!socketPath) {
	console.error("Usage: node tmux-watchdog-helper.mjs <socketPath> [tmuxExecutable] [extraArgs...]");
	process.exit(1);
}

// Start tmux in daemon mode only, no session command.
// Allow injection of custom tmux executable for testing.
const server = spawn(tmuxExecutable, ["-D", "-S", socketPath, ...extraArgs], {
	stdio: "ignore",
	detached: false,
});

if (!server.pid) {
	process.exit(1);
}

// Track cleanup state to prevent double-cleanup.
let cleaning = false;

// Verify server is running and get its PID via bounded async client.
async function verifyServer() {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			resolve(false);
		}, 2000);

		let output = "";
		const client = spawn("tmux", ["-S", socketPath, "display-message", "-p", "#{pid}"], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		client.stdout?.on("data", (data) => {
			output += data.toString();
		});

		client.once("exit", (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				const pid = parseInt(output.trim(), 10);
				// Verify PID matches our direct child
				resolve(pid === server.pid);
			} else {
				resolve(false);
			}
		});

		client.once("error", () => {
			clearTimeout(timeout);
			resolve(false);
		});
	});
}

// Cleanup function: terminate the tmux server via retained ChildProcess handle.
async function cleanup() {
	if (cleaning) return;
	cleaning = true;

	// Signal the direct child using retained server handle.
	server.kill("SIGTERM");

	// Wait up to 5 seconds for graceful exit via exit/close event.
	const exited = await new Promise((resolve) => {
		const timeout = setTimeout(() => {
			resolve(false);
		}, 5000);

		const onExit = () => {
			clearTimeout(timeout);
			server.removeListener("close", onClose);
			resolve(true);
		};

		const onClose = () => {
			clearTimeout(timeout);
			server.removeListener("exit", onExit);
			resolve(true);
		};

		server.once("exit", onExit);
		server.once("close", onClose);
	});

	if (!exited) {
		// Force kill if still running.
		server.kill("SIGKILL");

		// Wait for close event after force kill.
		await new Promise((resolve) => {
			const timeout = setTimeout(() => {
				resolve();
			}, 1000);

			server.once("close", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
	}

	// Boundedly verify pane descendants have exited (tmux spawns pane shells as children).
	// Give them 1 second to exit naturally; tmux should have cleaned them up.
	await new Promise((resolve) => {
		setTimeout(() => {
			resolve();
		}, 1000);
	});
}

// Verify server is ready, then emit payload with server PID.
const ready = await verifyServer();
if (!ready) {
	process.exit(1);
}

console.log(JSON.stringify({ serverPid: server.pid }));

// Resume stdin so we stay alive until EOF. Without this, stdin never emits "end".
process.stdin.resume();

// Wait for EOF on stdin (parent closes pipe or exits).
process.stdin.on("end", cleanup);

// Handle direct termination (e.g., parent SIGKILL).
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
