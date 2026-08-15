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
import { getAgentDir } from "./config.ts";
import { findSession, listSessions } from "./session.ts";
import { formatUsage, isTerminalState, type WorkerLogEntry, type WorkerLogPage, type WorkerSummary } from "./types.ts";

const POLL_MS = 400;
const ARCHIVE_POLL_MS = 2000;

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
	const named = worker.name === worker.role ? worker.id : `${worker.id} ${worker.name}`;
	return [
		`${named} · ${worker.role}/${worker.tier} · ${worker.backend} · ${access}${room}`,
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
export function resolveTarget(
	sessionId?: string,
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): WatchTarget | undefined {
	const address = process.env[NETA_SOCKET_ENV];
	const token = process.env[NETA_LEADER_ENV];
	if (!sessionId && address && token) return { address, token };
	const record = sessionId
		? listSessions(agentDir).find((entry) => entry.id === sessionId)
		: findSession(cwd, agentDir);
	return record ? { address: record.socket, token: record.token } : undefined;
}

/** Resolves when the leader has moved on, or when the session goes away. */
async function waitForArchive(target: WatchTarget, workerId: string): Promise<void> {
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, ARCHIVE_POLL_MS));
		let response: Awaited<ReturnType<typeof sendChannelRequest>>;
		try {
			response = await sendChannelRequest(target.address, {
				type: "tail",
				token: target.token,
				workerId,
				since: Number.MAX_SAFE_INTEGER,
			});
		} catch {
			// The leader is gone; nothing left to watch.
			return;
		}
		if (!response.ok) return;
		if ((response.data as WorkerLogPage | undefined)?.archived) return;
	}
}

export interface WatchOptions {
	workerId: string;
	sessionId?: string;
	cwd?: string;
	/** Where the session registry lives, for panes started without our env. */
	agentDir?: string;
	/** Read once and return, instead of following. */
	once?: boolean;
	/** Keep the view open after the worker finishes. Defaults to true on a terminal. */
	hold?: boolean;
	write?: (line: string) => void;
}

export async function watchWorker(options: WatchOptions): Promise<number> {
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const target = resolveTarget(options.sessionId, options.cwd, options.agentDir);
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

	// A finished worker's tab stays up so its report can be read, and closes
	// itself once the leader starts a new batch — or sooner, on a keypress.
	const hold = options.hold ?? (process.stdin.isTTY === true && !options.once);
	if (hold) {
		write("(stays until the leader starts new workers · press enter to close now)");
		await Promise.race([
			new Promise<void>((resolve) => {
				process.stdin.resume();
				process.stdin.once("data", () => resolve());
			}),
			waitForArchive(target, options.workerId),
		]);
	}
	return 0;
}
