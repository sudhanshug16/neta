/**
 * Sacrificial child that creates a tmux session and reports PIDs to parent.
 * Gets SIGKILL'd to test watchdog cleanup of direct server child.
 * Run as: node sigkill-sacrificial.mjs
 */

import { spawn } from "node:child_process";
import { startTmuxSession } from "../tmux-watchdog.ts";

const session = await startTmuxSession("sigkill-sac");
if (!session) process.exit(1);

// Create a session with a pane via bounded async client
const startSession = await new Promise((resolve) => {
	const timeout = setTimeout(() => resolve(false), 2000);
	const client = spawn("tmux", ["-S", session.socket, "new-session", "-d", "-s", "worker", "sleep", "300"]);
	client.once("exit", (code) => {
		clearTimeout(timeout);
		resolve(code === 0);
	});
});
if (!startSession) process.exit(1);

// Get pane PID via bounded async client
const panePid = await new Promise((resolve) => {
	const timeout = setTimeout(() => resolve(0), 2000);
	let output = "";
	const client = spawn("tmux", ["-S", session.socket, "display-message", "-t", "worker", "-p", "#{pane_pid}"]);
	client.stdout?.on("data", (data) => {
		output += data.toString();
	});
	client.once("exit", (code) => {
		clearTimeout(timeout);
		resolve(code === 0 ? parseInt(output.trim()) : 0);
	});
});

if (!panePid) process.exit(1);

// Write socket and PIDs to parent
console.log(JSON.stringify({
	socket: session.socket,
	directory: session.directory,
	watchdogPid: session.watchdogPid,
	panePid,
}));

// Hold open until SIGKILL
process.stdin.resume();
