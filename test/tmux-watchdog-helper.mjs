/**
 * Watchdog process that manages a private tmux server.
 * Run as: node tmux-watchdog-helper.mjs <socketPath>
 *
 * The watchdog:
 * 1. Starts a tmux server with -D -S <socketPath>
 * 2. Waits for parent to confirm server is up (via listing sessions)
 * 3. Parent writes "ready\n" to indicate it verified the socket responds
 * 4. Watchdog waits for EOF on stdin (parent closes or exits)
 * 5. Watchdog terminates the tmux server and exits
 */

import { spawn } from "node:child_process";

const socketName = process.argv[2];
if (!socketName) {
	console.error("Usage: node tmux-watchdog-helper.mjs <socketName>");
	process.exit(1);
}

// Start tmux in daemon mode with explicit socket name (-L uses default location).
const server = spawn("tmux", ["-L", socketName, "new-session", "-d", "-s", "server"], {
	stdio: "ignore",
	detached: false,
});

if (!server.pid) {
	process.exit(1);
}

const serverPid = server.pid;

// Signal that tmux was spawned (but parent must verify socket is actually ready).
console.log("started");

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

	// Wait up to 5 seconds for graceful exit before force-killing.
	let waited = 0;
	const checkInterval = setInterval(() => {
		waited += 100;
		try {
			process.kill(serverPid, 0); // Check if process exists
		} catch {
			// Process gone
			clearInterval(checkInterval);
			process.exit(0);
		}

		// Force kill after 5 seconds of waiting
		if (waited >= 5000) {
			clearInterval(checkInterval);
			try {
				process.kill(serverPid, "SIGKILL");
			} catch {
				// Already gone
			}
			process.exit(0);
		}
	}, 100);
}

// Resume stdin so we stay alive until EOF. Without this, stdin never emits "end".
process.stdin.resume();

// Wait for EOF on stdin (parent closes pipe or exits).
process.stdin.on("end", cleanup);

// Handle direct termination (e.g., parent SIGKILL).
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
