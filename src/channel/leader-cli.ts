/**
 * Leader side of the channel: the `neta workers|status|inspect|wait|send|kill`
 * subcommands.
 *
 * The leader normally drives workers through MCP tools, which run in its own
 * host process. These commands are the same operations over the socket, for
 * anything that is not the leader's tool loop: a process that holds the leader
 * token, or a human watching from another terminal.
 */

import { APP_NAME } from "../config.ts";
import { findSession, listSessions } from "../session.ts";
import { sendChannelRequest } from "./client.ts";
import { type LeaderChannelRequest, NETA_LEADER_ENV, NETA_SOCKET_ENV, NETA_WORKER_ENV } from "./protocol.ts";

export const LEADER_COMMANDS = new Set(["workers", "status", "inspect", "wait", "send", "kill"]);

const LEADER_HELP = `Leader channel commands (available where the leader token is set):

  ${APP_NAME} workers               List every worker and its state.
  ${APP_NAME} status                Show the writer slot, worker states and open notes.
  ${APP_NAME} inspect <id>          Expand a worker's recent input and output, bounded and
                                    non-consuming. Works for headless workers with no tab.
  ${APP_NAME} wait <id> [<id>...] [--timeout <seconds>]
      Block until the listed workers finish (default timeout 600s).
  ${APP_NAME} send <id> <message>   Interrupt a running worker's turn and make this its next prompt.
  ${APP_NAME} kill <id>             Stop a worker.
`;

interface ParsedFlags {
	flags: Map<string, string | true>;
	positional: string[];
}

/** `--writer` is boolean; every other `--flag` consumes the next argument. */
function parseFlags(args: string[], booleanFlags: Set<string>): ParsedFlags {
	const flags = new Map<string, string | true>();
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		if (booleanFlags.has(name)) {
			flags.set(name, true);
		} else {
			flags.set(name, args[++i] ?? "");
		}
	}
	return { flags, positional };
}

function buildRequest(command: string, token: string, rest: string[]): LeaderChannelRequest | string {
	switch (command) {
		case "workers":
			return { type: "workers", token };
		case "status":
			return { type: "status", token };
		case "inspect": {
			const workerId = rest[0];
			if (!workerId) return `Usage: ${APP_NAME} inspect <worker-id>`;
			return { type: "inspect", token, workerId };
		}
		case "wait": {
			const { flags, positional } = parseFlags(rest, new Set());
			if (positional.length === 0)
				return `Usage: ${APP_NAME} wait <worker-id> [<worker-id>...] [--timeout <seconds>]`;
			const timeout = flags.get("timeout");
			const seconds = typeof timeout === "string" ? Number.parseInt(timeout, 10) : Number.NaN;
			return {
				type: "wait",
				token,
				workerIds: positional,
				timeoutMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
			};
		}
		case "send": {
			const workerId = rest[0];
			const text = rest.slice(1).join(" ").trim();
			if (!workerId || !text) return `Usage: ${APP_NAME} ${command} <worker-id> <text>`;
			return { type: command, token, workerId, text };
		}
		case "kill": {
			const workerId = rest[0];
			if (!workerId) return `Usage: ${APP_NAME} kill <worker-id>`;
			return { type: "kill", token, workerId };
		}
		default:
			return `Unknown leader command "${command}".`;
	}
}

interface Target {
	address: string;
	token: string;
	rest: string[];
}

/**
 * Where to send the command. Inside the leader's own process the environment
 * says; from any other terminal the session registry does, which is what makes
 * `neta workers` work while you watch from a second window.
 */
function resolveTarget(args: string[]): Target | undefined {
	// A worker must never borrow a same-user session-registry token. The registry
	// is only the convenience path for a person in another terminal.
	if (process.env[NETA_WORKER_ENV]) return undefined;
	const index = args.indexOf("--session");
	const sessionId = index === -1 ? undefined : args[index + 1];
	const rest = index === -1 ? args : [...args.slice(0, index), ...args.slice(index + 2)];

	const address = process.env[NETA_SOCKET_ENV];
	const token = process.env[NETA_LEADER_ENV];
	if (!sessionId && address && token) return { address, token, rest };

	const record = sessionId ? listSessions().find((entry) => entry.id === sessionId) : findSession(process.cwd());
	return record ? { address: record.socket, token: record.token, rest } : undefined;
}

/**
 * Handle a leader channel subcommand. Returns false when the arguments are not
 * a leader command, or when there is no session to talk to, so the caller
 * continues with normal startup.
 */
export async function handleLeaderChannelCommand(args: string[]): Promise<boolean> {
	const command = args[0];
	if (!command || !LEADER_COMMANDS.has(command)) return false;
	// Help for a retained leader command works without a live session.
	if (args.includes("--help") || args.includes("-h")) {
		console.log(LEADER_HELP);
		return true;
	}
	const target = resolveTarget(args.slice(1));
	if (!target) return false;
	const { address, token, rest } = target;

	const request = buildRequest(command, token, rest);
	if (typeof request === "string") {
		console.error(request);
		process.exitCode = 1;
		return true;
	}

	try {
		const response = await sendChannelRequest(address, request);
		if (response.ok) {
			console.log(response.text ?? "ok");
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
