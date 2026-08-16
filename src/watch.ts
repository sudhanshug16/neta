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
import { estimateCost } from "./pricing.ts";
import { findSession, listSessions } from "./session.ts";
import {
	displayModel,
	isTerminalState,
	type WorkerLogEntry,
	type WorkerLogPage,
	type WorkerState,
	type WorkerSummary,
} from "./types.ts";

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
		case "progress":
			return `» ${entry.text}`;
		case "say":
			return `→ ${entry.text}`;
		case "status":
			return `· ${entry.text}`;
		case "error":
			return `! ${entry.text}`;
		case "text":
			// The worker's own prose reads as prose: no prefix, air around it.
			return `\n${entry.text}\n`;
		case "thought":
			return entry.text
				.split("\n")
				.map((line) => `~ ${line}`)
				.join("\n");
		case "diff":
			return entry.text
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n");
		default:
			return `  ${entry.text}`;
	}
}

/** Who this worker is and what it was asked to do. */
function header(worker: WorkerSummary): string[] {
	const access = worker.writer ? "writer" : "read-only";
	const room = worker.room ? ` · room ${worker.room}` : "";
	const model = displayModel(worker);
	const session = model || worker.mode ? ` · ${[model, worker.mode].filter(Boolean).join("/")}` : "";
	const bridge = worker.agentInfo ? ` · via ${worker.agentInfo}` : "";
	const named = worker.name === worker.role ? worker.id : `${worker.id} ${worker.name}`;
	return [
		`${named} · ${worker.role}/${worker.tier} · ${worker.backend}${bridge} · ${access}${room}${session}`,
		`task: ${worker.task.replace(/\s+/g, " ").trim().slice(0, 300)}`,
		"─".repeat(60),
	];
}

/** The line a pane ends on: how it went. The metadata line just above carries model and cost. */
function footer(page: WorkerLogPage): string {
	return `── ${page.worker?.id ?? "worker"} ${page.state} ──`;
}

/**
 * The metadata a watcher must never lose to a scrolled-off header: identity,
 * model, mode, state and spend, as one " · "-separated line. Returned widest
 * first; each following candidate drops the least essential remaining field —
 * cost, then tokens, then context, then mode, then name — so however narrow
 * the pane, id, model and state survive.
 */
export function metadataCandidates(worker: WorkerSummary, state: WorkerState): string[] {
	const usage = worker.usage;
	const context =
		usage?.contextUsed !== undefined && usage.contextSize
			? `context ${Math.round((usage.contextUsed / usage.contextSize) * 100)}%`
			: undefined;
	const counted =
		usage === undefined
			? undefined
			: (usage.totalTokens ??
				(usage.inputTokens !== undefined || usage.outputTokens !== undefined
					? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
					: undefined));
	const tokens = counted !== undefined ? `${counted.toLocaleString("en-US")} tokens` : undefined;
	const estimated =
		usage && usage.costAmount === undefined ? estimateCost(worker.modelId ?? worker.model, usage) : undefined;
	const cost =
		usage?.costAmount !== undefined
			? `${usage.costAmount.toFixed(2)} ${usage.costCurrency ?? "USD"}`
			: estimated !== undefined
				? `est. $${estimated.toFixed(2)}`
				: undefined;
	const named = worker.name === worker.role ? worker.id : `${worker.id} ${worker.name}`;
	const model = displayModel(worker);
	const line = (fields: (string | undefined)[]) => fields.filter((field) => field !== undefined).join(" · ");
	const candidates = [
		line([named, model, worker.mode, state, context, tokens, cost]),
		line([named, model, worker.mode, state, context, tokens]),
		line([named, model, worker.mode, state, context]),
		line([named, model, worker.mode, state]),
		line([named, model, state]),
		line([worker.id, model, state]),
	];
	return candidates.filter((candidate, index) => index === 0 || candidate !== candidates[index - 1]);
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
	let shownState: WorkerState | undefined;
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
		// The header scrolls away with the log; the metadata must not. Every state
		// change reprints it as one line — current model and spend included — so a
		// headless reader always has it nearby.
		if (page.worker && page.state !== shownState) {
			write(`· ${metadataCandidates(page.worker, page.state)[0]}`);
			shownState = page.state;
		}

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
		// This view is read-only by design. The worker's conversation lives in its
		// own CLI's history, so say how to open it there and talk to it.
		write(`(neta attach ${options.workerId} to open this in its own CLI · enter to close)`);
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
