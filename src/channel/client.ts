/**
 * Worker side of the channel: the `neta progress|ask|say|room|status` subcommands.
 *
 * These only exist inside a worker process, which is why the dispatcher below
 * requires NETA_SOCKET to be set.
 */

import { Socket } from "node:net";
import { APP_NAME } from "../config.ts";
import {
	type ChannelRequest,
	type ChannelResponse,
	NETA_SOCKET_ENV,
	NETA_WORKER_ENV,
	NETA_WORKER_TOKEN_ENV,
} from "./protocol.ts";

const CHANNEL_COMMANDS = new Set(["progress", "blocked", "room-post", "room", "discover", "status"]);

const CHANNEL_HELP = `Worker channel commands (available inside a Neta worker):

  ${APP_NAME} progress <message> Records a progress milestone in your log. Use it when you start, when a major step completes, and when something surprising changes your plan — one line each, not a running commentary. The leader and the user read these at a glance; frequent trivial calls bury the signal.
  ${APP_NAME} blocked <question> Stop this turn with a blocker; the leader resumes it with send.
  ${APP_NAME} room-post <message> Post to your team transcript.
  ${APP_NAME} room [--tail N]    Read your room transcript.
  ${APP_NAME} discover --impact local|goal --finding <text> [--suggest <text>] Report a finding.
  ${APP_NAME} status --writers   Show active, queued and finished writers.
  ${APP_NAME} status --goal      Show the compact current goal.
`;

/**
 * Send one request and wait for the single response. `ask` legitimately blocks
 * for as long as the leader takes, so there is no timeout here; the leader
 * closes the socket when the worker is killed.
 */
export function sendChannelRequest(
	address: string,
	request: ChannelRequest,
	signal?: AbortSignal,
): Promise<ChannelResponse> {
	if (signal?.aborted) {
		const error = new Error("The channel request was aborted.");
		error.name = "AbortError";
		return Promise.reject(error);
	}
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		let buffer = "";
		let settled = false;
		let connected = false;
		const abort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			const error = new Error("The channel request was aborted.");
			error.name = "AbortError";
			reject(error);
		};
		const cleanup = () => signal?.removeEventListener("abort", abort);

		const finish = (response: ChannelResponse) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.end();
			resolve(response);
		};

		signal?.addEventListener("abort", abort, { once: true });

		socket.on("connect", () => {
			connected = true;
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			try {
				finish(JSON.parse(line) as ChannelResponse);
			} catch (error) {
				finish({ ok: false, error: `Malformed response from leader: ${error}` });
			}
		});
		socket.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});
		socket.on("close", () => {
			if (settled) return;
			settled = true;
			cleanup();
			if (!connected) {
				const error = new Error("The leader closed the channel before accepting the connection.");
				(error as NodeJS.ErrnoException).code = "ECONNRESET";
				reject(error);
				return;
			}
			resolve({ ok: false, error: "Leader closed the channel without answering." });
		});
		socket.connect(address);
	});
}

function parseTail(args: string[]): number | undefined {
	const index = args.indexOf("--tail");
	if (index === -1) return undefined;
	const value = Number.parseInt(args[index + 1] ?? "", 10);
	return Number.isFinite(value) ? value : undefined;
}

export function parseDiscoveryArgs(
	args: string[],
): { impact: "local" | "goal"; finding: string; suggestion?: string } | string {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (flag !== "--impact" && flag !== "--finding" && flag !== "--suggest")
			return `Usage: ${APP_NAME} discover --impact local|goal --finding <text> [--suggest <text>]`;
		if (values.has(flag))
			return `Usage: ${APP_NAME} discover --impact local|goal --finding <text> [--suggest <text>] (duplicate ${flag})`;
		const value = args[index + 1];
		if (!value || value.startsWith("--"))
			return `Usage: ${APP_NAME} discover --impact local|goal --finding <text> [--suggest <text>] (missing ${flag} value)`;
		values.set(flag, value);
		index += 1;
	}
	const impact = values.get("--impact");
	const finding = values.get("--finding");
	if (impact !== "local" && impact !== "goal")
		return `Usage: ${APP_NAME} discover --impact local|goal --finding <text> [--suggest <text>]`;
	if (!finding?.trim()) return `Usage: ${APP_NAME} discover --impact local|goal --finding <text> [--suggest <text>]`;
	const suggestion = values.get("--suggest");
	return { impact, finding, ...(suggestion ? { suggestion } : {}) };
}

/**
 * Handle a worker channel subcommand. Returns false when the arguments are not
 * a channel command, so the caller continues with normal startup.
 */
export async function handleWorkerChannelCommand(args: string[]): Promise<boolean> {
	const address = process.env[NETA_SOCKET_ENV];
	const workerId = process.env[NETA_WORKER_ENV];
	const token = process.env[NETA_WORKER_TOKEN_ENV];
	const command = args[0];
	if (!address || !workerId || !command || !CHANNEL_COMMANDS.has(command)) return false;
	if (!token) {
		console.error("Worker channel token is missing.");
		process.exitCode = 1;
		return true;
	}

	const rest = args.slice(1);
	if (rest.includes("--help") || rest.includes("-h")) {
		console.log(CHANNEL_HELP);
		return true;
	}

	let request: ChannelRequest;
	if (command === "room") {
		request = { type: "room", workerId, token, tail: parseTail(rest) };
	} else if (command === "discover") {
		const discovery = parseDiscoveryArgs(rest);
		if (typeof discovery === "string") {
			console.error(discovery);
			process.exitCode = 1;
			return true;
		}
		request = { type: "discover", workerId, token, ...discovery };
	} else if (command === "status") {
		if (rest.length !== 1 || (rest[0] !== "--writers" && rest[0] !== "--goal")) {
			console.error(`Usage: ${APP_NAME} status --writers|--goal`);
			process.exitCode = 1;
			return true;
		}
		request =
			rest[0] === "--writers"
				? { type: "writer-status", workerId, token }
				: { type: "goal-status", workerId, token };
	} else {
		const text = rest.join(" ").trim();
		if (!text) {
			console.error(`Usage: ${APP_NAME} ${command} <text>`);
			process.exitCode = 1;
			return true;
		}
		request = { type: command as "progress" | "blocked" | "room-post", workerId, token, text };
	}

	try {
		const response = await sendChannelRequest(address, request);
		if (response.ok) {
			if (response.text) console.log(response.text);
			else if (command === "progress" || command === "room-post" || command === "discover") console.log("ok");
		} else {
			console.error(response.error);
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(`Could not reach the leader on ${address}: ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	}
	return true;
}
