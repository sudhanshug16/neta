/**
 * `neta watch <id>` — a live view of one worker.
 *
 * This is what runs in a worker's pane, and what a person runs in a spare
 * terminal. It reads through the non-consuming `tail` request, so watching a
 * worker never steals log lines the leader has not seen yet.
 *
 * When the worker finishes, the view stays until dismissed: a pane that
 * vanishes the moment a worker fails takes the error with it.
 */

import { sendChannelRequest } from "./channel/client.ts";
import { NETA_LEADER_ENV, NETA_SOCKET_ENV } from "./channel/protocol.ts";
import { findSession, listSessions } from "./session.ts";
import { isTerminalState, type WorkerLogPage } from "./types.ts";

const POLL_MS = 400;

export interface WatchTarget {
	address: string;
	token: string;
}

/** Env first (we are inside the session), then the registry (we are not). */
export function resolveTarget(sessionId?: string, cwd: string = process.cwd()): WatchTarget | undefined {
	const address = process.env[NETA_SOCKET_ENV];
	const token = process.env[NETA_LEADER_ENV];
	if (!sessionId && address && token) return { address, token };
	const record = sessionId ? listSessions().find((entry) => entry.id === sessionId) : findSession(cwd);
	return record ? { address: record.socket, token: record.token } : undefined;
}

export interface WatchOptions {
	workerId: string;
	sessionId?: string;
	cwd?: string;
	/** Read once and return, instead of following. */
	once?: boolean;
	/** Keep the view open after the worker finishes. Defaults to true on a terminal. */
	hold?: boolean;
	write?: (line: string) => void;
}

export async function watchWorker(options: WatchOptions): Promise<number> {
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const target = resolveTarget(options.sessionId, options.cwd);
	if (!target) {
		write("No Neta session found. Start one with `neta`, or pass --session <id>.");
		return 1;
	}

	let since = 0;
	for (;;) {
		const response = await sendChannelRequest(target.address, {
			type: "tail",
			token: target.token,
			workerId: options.workerId,
			since,
		});
		if (!response.ok) {
			write(response.error);
			return 1;
		}

		const page = response.data as WorkerLogPage | undefined;
		if (!page) {
			write("The leader sent no log page; is this a current Neta session?");
			return 1;
		}
		for (const entry of page.entries) write(`[${entry.kind}] ${entry.text}`);
		since = page.cursor;

		if (isTerminalState(page.state) || options.once) {
			if (isTerminalState(page.state)) write(`-- worker ${options.workerId} ${page.state} --`);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}

	const hold = options.hold ?? (process.stdin.isTTY === true && !options.once);
	if (hold) {
		write("(press enter to close)");
		await new Promise<void>((resolve) => {
			process.stdin.resume();
			process.stdin.once("data", () => resolve());
		});
	}
	return 0;
}
