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
import { formatUsage, isTerminalState, type WorkerLogEntry, type WorkerLogPage, type WorkerSummary } from "./types.ts";

const POLL_MS = 400;

/**
 * A pane is read at a glance, so the shape of a line carries the meaning: what
 * the worker did is indented and quiet, what it said to the leader stands out,
 * and trouble is impossible to miss. Tags like "[output]" on every line are
 * noise that makes a busy worker unreadable.
 */
function formatLine(entry: WorkerLogEntry): string {
	switch (entry.kind) {
		case "notify":
			return `» ${entry.text}`;
		case "say":
			return `→ ${entry.text}`;
		case "status":
			return `· ${entry.text}`;
		case "error":
			return `! ${entry.text}`;
		default:
			return `  ${entry.text}`;
	}
}

/** Who this worker is and what it was asked to do. */
function header(worker: WorkerSummary): string[] {
	const access = worker.writer ? "writer" : "read-only";
	const room = worker.room ? ` · room ${worker.room}` : "";
	return [
		`${worker.id} · ${worker.role}/${worker.tier} · ${worker.backend} · ${access}${room}`,
		`task: ${worker.task.replace(/\s+/g, " ").trim().slice(0, 300)}`,
		"─".repeat(60),
	];
}

/** The line a pane ends on: how it went, and what it cost. */
function footer(page: WorkerLogPage): string {
	const usage = formatUsage(page.worker?.usage);
	return `── ${page.worker?.id ?? "worker"} ${page.state}${usage ? ` · ${usage}` : ""} ──`;
}

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
	let introduced = false;
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
		if (!introduced && page.worker) {
			for (const line of header(page.worker)) write(line);
			introduced = true;
		}
		for (const entry of page.entries) write(formatLine(entry));
		since = page.cursor;

		if (isTerminalState(page.state) || options.once) {
			if (isTerminalState(page.state)) write(footer(page));
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
