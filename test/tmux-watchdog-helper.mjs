/**
 * Watchdog process that manages a private tmux server.
 * Run as: node tmux-watchdog-helper.mjs <socketPath>
 *
 * The watchdog:
 * 1. Starts a tmux server with -D -S <socketPath>
 * 2. Writes "ready" to stdout when the server is alive
 * 3. Waits for EOF on stdin (parent closes or exits)
 * 4. Terminates the tmux server and exits
 */

import { spawn } from "node:child_process";

const socketPath = process.argv[2];
if (!socketPath) {
	console.error("Usage: node tmux-watchdog-helper.mjs <socketPath>");
	process.exit(1);
}

// Start tmux in daemon mode with explicit socket.
const server = spawn("tmux", ["-D", "-S", socketPath, "new-session", "-d", "-s", "server"], {
	stdio: "ignore",
	detached: false,
});

if (!server.pid) {
	process.exit(1);
}

const serverPid = server.pid;

// Signal readiness to parent.
console.log("ready");

// Track cleanup state to prevent double-cleanup.
let cleaning = false;

// Cleanup function: terminate the tmux server.
function cleanup() {
	if (cleaning) return;
	cleaning = true;

	try {
		process.kill(serverPid, "SIGTERM");
	} catch {
		// Already gone
		process.exit(0);
	}

	// Wait up to 5 seconds for graceful exit.
	const checkInterval = setInterval(() => {
		try {
			process.kill(serverPid, 0); // Check if process exists
		} catch {
			// Process gone
			clearInterval(checkInterval);
			process.exit(0);
		}
	}, 100);

	setTimeout(() => {
		clearInterval(checkInterval);
		// Force kill if still alive.
		try {
			process.kill(serverPid, "SIGKILL");
		} catch {
			// Already gone
		}
		process.exit(0);
	}, 5000);
}

// Wait for EOF on stdin.
process.stdin.on("end", cleanup);

// Handle direct termination (e.g., parent SIGKILL).
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
