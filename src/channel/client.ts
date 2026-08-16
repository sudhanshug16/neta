/**
 * Worker side of the channel: the `neta notify|ask|say|room|status` subcommands.
 *
 * These only exist inside a worker process, which is why the dispatcher below
 * requires NETA_SOCKET to be set.
 */

import { connect } from "node:net";
import { APP_NAME } from "../config.ts";
import { type ChannelRequest, type ChannelResponse, NETA_SOCKET_ENV, NETA_WORKER_ENV } from "./protocol.ts";

const CHANNEL_COMMANDS = new Set(["notify", "ask", "say", "room", "status"]);

const CHANNEL_HELP = `Worker channel commands (available inside a Neta worker):

  ${APP_NAME} notify <message>   Append to your log. The leader reads it when it chooses.
  ${APP_NAME} ask <question>     Ask the leader and wait for the answer. Not available to junior workers.
  ${APP_NAME} say <message>      Post to your room, visible to the other members.
  ${APP_NAME} room [--tail N]    Read your room transcript.
  ${APP_NAME} status --writers   Show active, queued and finished writers.
`;

/**
 * Send one request and wait for the single response. `ask` legitimately blocks
 * for as long as the leader takes, so there is no timeout here; the leader
 * closes the socket when the worker is killed.
 */
export function sendChannelRequest(address: string, request: ChannelRequest): Promise<ChannelResponse> {
	return new Promise((resolve, reject) => {
		const socket = connect(address);
		let buffer = "";
		let settled = false;

		const finish = (response: ChannelResponse) => {
			if (settled) return;
			settled = true;
			socket.end();
			resolve(response);
		};

		socket.on("connect", () => {
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
			reject(error);
		});
		socket.on("close", () => {
			if (settled) return;
			settled = true;
			resolve({ ok: false, error: "Leader closed the channel without answering." });
		});
	});
}

function parseTail(args: string[]): number | undefined {
	const index = args.indexOf("--tail");
	if (index === -1) return undefined;
	const value = Number.parseInt(args[index + 1] ?? "", 10);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Handle a worker channel subcommand. Returns false when the arguments are not
 * a channel command, so the caller continues with normal startup.
 */
export async function handleWorkerChannelCommand(args: string[]): Promise<boolean> {
	const address = process.env[NETA_SOCKET_ENV];
	const workerId = process.env[NETA_WORKER_ENV];
	const command = args[0];
	if (!address || !workerId || !command || !CHANNEL_COMMANDS.has(command)) return false;

	const rest = args.slice(1);
	if (rest.includes("--help") || rest.includes("-h")) {
		console.log(CHANNEL_HELP);
		return true;
	}

	let request: ChannelRequest;
	if (command === "room") {
		request = { type: "room", workerId, tail: parseTail(rest) };
	} else if (command === "status") {
		if (rest.length !== 1 || rest[0] !== "--writers") {
			console.error(`Usage: ${APP_NAME} status --writers`);
			process.exitCode = 1;
			return true;
		}
		request = { type: "writer-status", workerId };
	} else {
		const text = rest.join(" ").trim();
		if (!text) {
			console.error(`Usage: ${APP_NAME} ${command} <text>`);
			process.exitCode = 1;
			return true;
		}
		request = { type: command as "notify" | "ask" | "say", workerId, text };
	}

	try {
		const response = await sendChannelRequest(address, request);
		if (response.ok) {
			if (response.text) console.log(response.text);
			else if (command === "notify" || command === "say") console.log("ok");
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
