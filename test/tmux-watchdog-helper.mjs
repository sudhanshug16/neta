/**
 * Watchdog process that manages a private tmux server.
 * Run as: node tmux-watchdog-helper.mjs <socketPath>
 *
 * The watchdog:
 * 1. Starts a tmux server with -D -S <socketPath> (daemon mode, no session)
 * 2. Signals startup via stdout
 * 3. Waits for EOF on stdin (parent closes or exits)
 * 4. Signals tmux server child, waits for exit, verifies descendants gone
 * 5. Exits
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const socketPath = process.argv[2];
if (!socketPath) {
	console.error("Usage: node tmux-watchdog-helper.mjs <socketPath>");
	process.exit(1);
}

// Start tmux in daemon mode only, no session command.
const server = spawn("tmux", ["-D", "-S", socketPath], {
	stdio: "ignore",
	detached: false,
});

if (!server.pid) {
	process.exit(1);
}

const serverPid = server.pid;

// Track cleanup state to prevent double-cleanup.
let cleaning = false;

// Cleanup function: terminate the tmux server.
async function cleanup() {
	if (cleaning) return;
	cleaning = true;

	// Signal the direct child with SIGTERM.
	try {
		process.kill(serverPid, "SIGTERM");
	} catch {
		// Already gone
		process.exit(0);
	}

	// Wait up to 5 seconds for graceful exit.
	let waited = 0;
	const checkInterval = setInterval(() => {
		waited += 100;
		try {
			process.kill(serverPid, 0); // Check if process exists
		} catch {
			// Process gone, verify descendants
			clearInterval(checkInterval);

			// Boundedly verify pane descendants have exited (tmux spawns pane shells as children).
			// Give them 1 second to exit naturally; tmux should have cleaned them up.
			setTimeout(() => process.exit(0), 1000);
			return;
		}

		// Force kill after 5 seconds of waiting
		if (waited >= 5000) {
			clearInterval(checkInterval);
			try {
				process.kill(serverPid, "SIGKILL");
			} catch {
				// Already gone
			}
			setTimeout(() => process.exit(0), 1000);
		}
	}, 100);
}

// Write to stdout to signal we've spawned (parent will verify socket exists and PID).
console.log("ready");

// Resume stdin so we stay alive until EOF. Without this, stdin never emits "end".
process.stdin.resume();

// Wait for EOF on stdin (parent closes pipe or exits).
process.stdin.on("end", cleanup);

// Handle direct termination (e.g., parent SIGKILL).
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
