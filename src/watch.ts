/**
 * `neta watch <id>` — a live view of one worker — and `neta watch <room>`, the
 * same view of a room's merged transcript.
 *
 * This is what runs in a worker's pane, and what a person runs in a spare
 * terminal. It reads through the non-consuming `tail` and `room-tail`
 * requests, so watching never steals log lines the leader has not seen yet.
 *
 * When the worker finishes, the view stays until dismissed: a pane that
 * vanishes the moment a worker fails takes the error with it. A room view
 * stays the same way once its last member finishes.
 */

import { sendChannelRequest } from "./channel/client.ts";
import { type ChannelRequest, type ChannelResponse, NETA_LEADER_ENV, NETA_SOCKET_ENV } from "./channel/protocol.ts";
import { getAgentDir } from "./config.ts";
import { markWorkerPaneTerminal } from "./mux/panes.ts";
import { formatLastProgress } from "./orchestrator/status.ts";
import { estimateCost } from "./pricing.ts";
import { findSession, listSessions, readSessionRecord } from "./session.ts";
import {
	displayModel,
	isTerminalState,
	type RoomLogPage,
	type RoomPost,
	type WorkerLogEntry,
	type WorkerLogPage,
	type WorkerState,
	type WorkerSummary,
} from "./types.ts";

const POLL_MS = 400;
const ARCHIVE_POLL_MS = 2000;
const CONTROL_PLANE_RETRY_MS = 100;
const CONTROL_PLANE_RETRY_WINDOW_MS = 30_000;

/** Worker ids are minted as ro<N>/rw<N>; anything else `watch` takes as a room name. */
export function isWorkerId(target: string): boolean {
	return /^(ro|rw)\d+$/.test(target);
}

/** "ro2 pro · debater/architect", or undefined on an entry that carries no poster. */
export function sayAuthor(entry: WorkerLogEntry): string | undefined {
	if (!entry.from) return undefined;
	if (!entry.label || entry.label === entry.from) return entry.from;
	return `${entry.from} ${entry.label}`;
}

/** A room post rendered exactly like a worker's own "say" log entry. */
export function sayEntry(post: RoomPost): WorkerLogEntry {
	return { at: post.at, kind: "say", text: post.text, from: post.from, label: post.label };
}

/**
 * Everything sent TO the worker lands in its log as a status entry with one of
 * these fixed prefixes (manager send/answer — the pane's input line rides the
 * same path). These are the operator's voice, not one more status line, so the
 * views pick them out and render them in their own style, never cut.
 */
const SENT_PREFIXES: ReadonlyArray<readonly [prefix: string, label: string]> = [
	["Leader delivering now as next turn: ", "leader delivering"],
	["Leader queued for next turn: ", "leader queued"],
	// Historical checkpoint entries remain readable after upgrading.
	["Leader: ", "leader"],
	["Leader answered: ", "leader answered"],
	["Leader queued message (will be delivered at start): ", "leader queued"],
];

export interface SentMessage {
	label: string;
	text: string;
}

/** The message behind a sent-to-worker status entry, or undefined on any other entry. */
export function sentMessage(entry: WorkerLogEntry): SentMessage | undefined {
	if (entry.kind !== "status") return undefined;
	for (const [prefix, label] of SENT_PREFIXES) {
		if (entry.text.startsWith(prefix)) return { label, text: entry.text.slice(prefix.length) };
	}
	return undefined;
}

/**
 * A sent message in the plain view: alignment does not exist here, so the "«"
 * marker carries the direction — into the worker, mirroring the "»" its own
 * progress lines point out with. One line stays a line; a longer message reads
 * like a "say": attribution, then the whole body.
 */
function formatSent(label: string, text: string): string {
	return text.includes("\n") ? `\n« ${label}:\n${text}\n` : `« ${label}: ${text}`;
}

/**
 * A pane is read at a glance, so the shape of a line carries the meaning: what
 * the worker did is indented and quiet, what it said to the leader stands out,
 * what was sent to it carries the "«" marker, and trouble is impossible to
 * miss. Tags like "[output]" on every line are noise that makes a busy worker
 * unreadable.
 */
function formatLine(entry: WorkerLogEntry): string {
	const sent = sentMessage(entry);
	if (sent) return formatSent(sent.label, sent.text);
	switch (entry.kind) {
		case "progress":
			return `» ${entry.text}`;
		case "say": {
			// A room post is the content of a debate, and reads like the worker's
			// own prose: an attribution line, then the whole body, never squeezed
			// onto the arrow line.
			const author = sayAuthor(entry);
			return author ? `\n→ ${author}\n${entry.text}\n` : `→ ${entry.text}`;
		}
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
	const progress = formatLastProgress(worker);
	return [
		`${named} · ${worker.role}/${worker.tier} · ${worker.backend}${bridge} · ${access}${room}${session}`,
		`task: ${worker.task.replace(/\s+/g, " ").trim().slice(0, 300)}`,
		...(progress ? [progress] : []),
		...(worker.promptBlockedReason ? [`! steering blocked: ${worker.promptBlockedReason}`] : []),
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
	/** A registry-backed id lets a watcher stop when its manager is gone. */
	sessionId?: string;
	agentDir?: string;
}

/** Env first (we are inside the session), then the registry (we are not). */
export function resolveTarget(
	sessionId?: string,
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): WatchTarget | undefined {
	const address = process.env[NETA_SOCKET_ENV];
	const token = process.env[NETA_LEADER_ENV];
	const environmentSessionId = process.env.NETA_SESSION_ID || undefined;
	if (!sessionId && address && token) return { address, token, sessionId: environmentSessionId, agentDir };
	const record = sessionId
		? listSessions(agentDir).find((entry) => entry.id === sessionId)
		: findSession(cwd, agentDir);
	return record ? { address: record.socket, token: record.token, sessionId: record.id, agentDir } : undefined;
}

function isTransientChannelError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE";
}

function sessionStillRegistered(target: WatchTarget): boolean {
	return target.sessionId === undefined || readSessionRecord(target.sessionId, target.agentDir) !== undefined;
}

/**
 * A pane can start during the control-plane handoff: the socket path exists in
 * the session record, but the listener is not accepting yet. Retry only those
 * transport-level failures. A registry-backed watcher has no reason to outlive
 * the manager; an environment-only watcher gets a finite recovery window.
 */
export async function sendWatchRequest(
	target: WatchTarget,
	request: ChannelRequest,
): Promise<ChannelResponse | undefined> {
	const deadline = target.sessionId === undefined ? Date.now() + CONTROL_PLANE_RETRY_WINDOW_MS : undefined;
	for (;;) {
		try {
			return await sendChannelRequest(target.address, request);
		} catch (error) {
			if (!isTransientChannelError(error)) throw error;
			if (!sessionStillRegistered(target)) return undefined;
			if (deadline !== undefined && Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, CONTROL_PLANE_RETRY_MS));
		}
	}
}

/** Resolves when the leader has moved on, or when the session goes away. */
async function waitForArchive(target: WatchTarget, workerId: string): Promise<void> {
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, ARCHIVE_POLL_MS));
		let response: ChannelResponse | undefined;
		try {
			response = await sendWatchRequest(target, {
				type: "tail",
				token: target.token,
				workerId,
				since: Number.MAX_SAFE_INTEGER,
			});
		} catch {
			// The leader is gone; nothing left to watch.
			return;
		}
		if (!response) return;
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
		let response: ChannelResponse | undefined;
		try {
			response = await sendWatchRequest(target, {
				type: "tail",
				token: target.token,
				workerId: options.workerId,
				since,
			});
		} catch (error) {
			write(`Could not reach the leader on ${target.address}: ${error instanceof Error ? error.message : error}`);
			return 1;
		}
		if (!response) return 0;
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
			// The header's "task:" line truncates; the brief was the first thing
			// sent to the worker and opens the transcript whole.
			write(formatSent("task", page.worker.task));
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
			if (isTerminalState(page.state)) {
				if (page.worker) markWorkerPaneTerminal(page.worker);
				write(footer(page));
			}
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

/** Which room this is and who is in it, mirroring the worker header. */
function roomHeader(room: string, page: RoomLogPage): string[] {
	const members = page.members.map((member) => `${member.id} ${member.name} (${member.backend})`).join(", ");
	return [`room ${room}${members ? ` · members: ${members}` : ""}`, "─".repeat(60)];
}

/** Resolves when the room's batch has been archived, or the session goes away. */
async function waitForRoomArchive(target: WatchTarget, room: string): Promise<void> {
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, ARCHIVE_POLL_MS));
		let response: ChannelResponse | undefined;
		try {
			response = await sendWatchRequest(target, {
				type: "room-tail",
				token: target.token,
				room,
				since: Number.MAX_SAFE_INTEGER,
			});
		} catch {
			// The leader is gone; nothing left to watch.
			return;
		}
		if (!response) return;
		if (!response.ok) return;
		if ((response.data as RoomLogPage | undefined)?.archived) return;
	}
}

export interface WatchRoomOptions {
	room: string;
	sessionId?: string;
	cwd?: string;
	/** Where the session registry lives, for panes started without our env. */
	agentDir?: string;
	/** Read once and return, instead of following. */
	once?: boolean;
	/** Keep the view open after the room finishes. Defaults to true on a terminal. */
	hold?: boolean;
	write?: (line: string) => void;
}

/**
 * One merged transcript for a whole room, so a person follows a debate in one
 * place instead of interleaving its members' panes mentally. Every post
 * renders the way a worker's own "say" does: attribution line, full body.
 */
export async function watchRoom(options: WatchRoomOptions): Promise<number> {
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const target = resolveTarget(options.sessionId, options.cwd, options.agentDir);
	if (!target) {
		write("No Neta session found. Start one with `neta`, or pass --session <id>.");
		return 1;
	}

	let since = 0;
	let introduced = false;
	for (;;) {
		let response: ChannelResponse | undefined;
		try {
			response = await sendWatchRequest(target, {
				type: "room-tail",
				token: target.token,
				room: options.room,
				since,
			});
		} catch (error) {
			write(`Could not reach the leader on ${target.address}: ${error instanceof Error ? error.message : error}`);
			return 1;
		}
		if (!response) return 0;
		if (!response.ok) {
			write(response.error);
			return 1;
		}
		const page = response.data as RoomLogPage | undefined;
		if (!page) {
			write("The leader sent no room page; is this a current Neta session?");
			return 1;
		}
		if (!introduced) {
			for (const line of roomHeader(options.room, page)) write(line);
			introduced = true;
		}
		for (const post of page.posts) write(formatLine(sayEntry(post)));
		since = page.cursor;

		if (page.done || options.once) {
			if (page.done) write(`── room ${options.room} done ──`);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}

	// Like a finished worker's tab: the exchange stays readable until dismissed,
	// and the view closes itself when the leader moves on to a new batch.
	const hold = options.hold ?? (process.stdin.isTTY === true && !options.once);
	if (hold) {
		write("(enter to close)");
		await Promise.race([
			new Promise<void>((resolve) => {
				process.stdin.resume();
				process.stdin.once("data", () => resolve());
			}),
			waitForRoomArchive(target, options.room),
		]);
	}
	return 0;
}
