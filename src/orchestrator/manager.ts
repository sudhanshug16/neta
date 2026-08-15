/**
 * The worker subsystem: spawning, the writer slot, logs, rooms, and the
 * blocking `ask` queue.
 *
 * Two rules drive most of this file:
 *
 * - Reads parallelize, writes serialize. One writer slot exists; a second
 *   spawn with writer:true fails loudly instead of racing.
 * - Workers are quiet. Everything a worker narrates lands in a log the leader
 *   pulls. Only completion, failure and a blocking question push.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpWorkerTransport } from "../acp/transport.ts";
import type { ChannelResponse, LeaderChannelRequest } from "../channel/protocol.ts";
import { NETA_SCRATCH_ENV, NETA_SOCKET_ENV, NETA_WORKER_ENV } from "../channel/protocol.ts";
import type { ChannelHandler } from "../channel/server.ts";
import { APP_NAME } from "../config.ts";
import { loadRoleText, roleNames, workingAgreement } from "../prompts/roles.ts";
import type { NetaConfig } from "../settings.ts";
import {
	formatUsage,
	isTerminalState,
	type RoomPost,
	type SpawnRequest,
	TIERS,
	type Tier,
	type WorkerEvent,
	type WorkerLogEntry,
	type WorkerLogPage,
	type WorkerState,
	type WorkerSummary,
	type WorkerUsage,
} from "../types.ts";
import type { TransportOptions, WorkerMcpServer, WorkerTransportDriver } from "./transport.ts";

const MAX_LOG_ENTRIES = 500;

interface WorkerRecord {
	id: string;
	name: string;
	role: string;
	tier: SpawnRequest["tier"];
	backend: string;
	writer: boolean;
	room: string | undefined;
	task: string;
	state: WorkerState;
	startedAt: number;
	endedAt?: number;
	result?: string;
	scratchDir: string;
	driver: WorkerTransportDriver;
	log: WorkerLogEntry[];
	/** Log entries the leader has already been shown. */
	logCursor: number;
	pendingAsk?: { question: string; resolve: (response: ChannelResponse) => void };
	/** Serializes prompts for this worker. */
	queue: Promise<void>;
	/** Prompts queued or running. The worker is only done when the last one ends. */
	queuedPrompts: number;
	waiters: Array<() => void>;
	usage?: WorkerUsage;
	vendorSessionId?: string;
	/** Finished, and superseded by a later batch: its view can close. */
	archived?: boolean;
}

/** Opens a pane per worker, when a multiplexer is running. */
export interface WorkerPaneHost {
	open(worker: WorkerSummary): void;
}

export type TransportFactory = (options: TransportOptions) => WorkerTransportDriver;

export interface WorkerManagerOptions {
	cwd: string;
	agentDir: string;
	config: NetaConfig;
	channelAddress: string;
	/** Authorizes socket-side worker management. Generated when the caller has no token to share. */
	leaderToken?: string;
	onEvent: (event: WorkerEvent) => void;
	/**
	 * Runs before every spawn: opens the worker channel and returns the extra
	 * environment every worker needs to talk back (the `neta` CLI on PATH).
	 * Called lazily so a leader that never delegates opens no socket.
	 */
	prepareEnv?: () => Promise<Record<string, string>>;
	/**
	 * MCP servers to hand each worker's backend, built per worker. This is the
	 * door a sandboxed worker uses to reach Neta, since its shell may not be
	 * allowed to open a socket.
	 */
	workerMcpServers?: (workerId: string, scratchDir: string) => WorkerMcpServer[];
	/** Opens a pane per worker. Omitted means headless. */
	panes?: WorkerPaneHost;
	/** Test seam: swap in a fake transport without touching real CLIs. */
	createTransport?: TransportFactory;
}

async function gitDirtyFiles(cwd: string): Promise<string[]> {
	return new Promise((resolve) => {
		execFile("git", ["status", "--porcelain"], { cwd }, (error, stdout) => {
			if (error) {
				resolve([]);
				return;
			}
			resolve(
				stdout
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean),
			);
		});
	});
}

export class WorkerManager implements ChannelHandler {
	private options: WorkerManagerOptions;
	private readonly workers = new Map<string, WorkerRecord>();
	private readonly rooms = new Map<string, RoomPost[]>();
	private readonly createTransport: TransportFactory;
	private counter = 0;
	private activeWriter: string | undefined;
	/** Authorizes leader channel commands. Given only to the leader's own process. */
	readonly leaderToken: string;

	constructor(options: WorkerManagerOptions) {
		this.options = options;
		this.leaderToken = options.leaderToken ?? randomBytes(16).toString("hex");
		this.createTransport =
			options.createTransport ?? ((transportOptions) => new AcpWorkerTransport(transportOptions));
	}

	/** Rebind to a different working directory or settings. */
	configure(options: { cwd: string; agentDir: string; config: NetaConfig }): void {
		this.options = { ...this.options, ...options };
	}

	// =========================================================================
	// Leader-facing API
	// =========================================================================

	async spawn(request: SpawnRequest): Promise<WorkerSummary> {
		const writer = request.writer ?? false;
		if (writer && this.activeWriter) {
			const holder = this.workers.get(this.activeWriter);
			throw new Error(
				`Worker ${this.activeWriter} (${holder?.role ?? "unknown"}) already holds the writer slot. ` +
					`Wait for it to finish, or kill it, before spawning another writer.`,
			);
		}

		const roleText = loadRoleText(request.role, this.options.cwd, this.options.agentDir);
		if (!roleText) {
			throw new Error(`Unknown role "${request.role}". Available roles: ${roleNames().join(", ")}.`);
		}

		// Starting a batch while the last one is finished means the last one has
		// been read, or never will be: let those views close so a long session
		// does not bury the leader in the tabs of workers that ended an hour ago.
		const existing = [...this.workers.values()];
		if (existing.length > 0 && existing.every((record) => isTerminalState(record.state))) {
			for (const record of existing) record.archived = true;
		}

		const backend = this.options.config.resolve(request.tier, request.backend, writer);
		const runtimeEnv = (await this.options.prepareEnv?.()) ?? {};
		const id = `w${++this.counter}`;
		const scratchDir = await mkdtemp(join(tmpdir(), `neta-${id}-`));

		const systemPrompt = [
			roleText.trim(),
			"",
			workingAgreement({ tier: request.tier, writer, room: request.room, binary: APP_NAME }),
			"",
			`Your scratch directory (outside the repository) is ${scratchDir}. Use it for notes and throwaway files.`,
		].join("\n");

		const record: WorkerRecord = {
			id,
			name: (request.name ?? request.role).trim() || request.role,
			role: request.role,
			tier: request.tier,
			backend: backend.name,
			writer,
			room: request.room,
			task: request.task,
			state: "starting",
			startedAt: Date.now(),
			scratchDir,
			log: [],
			logCursor: 0,
			queue: Promise.resolve(),
			queuedPrompts: 0,
			waiters: [],
			driver: undefined as unknown as WorkerTransportDriver,
		};

		const transportOptions: TransportOptions = {
			workerId: id,
			cwd: this.options.cwd,
			env: {
				...runtimeEnv,
				...backend.env,
				[NETA_SOCKET_ENV]: this.options.channelAddress,
				[NETA_WORKER_ENV]: id,
				[NETA_SCRATCH_ENV]: scratchDir,
			},
			command: backend.command,
			args: backend.args,
			model: backend.model,
			writer,
			systemPrompt,
			scratchDir,
			mcpServers: this.options.workerMcpServers?.(id, scratchDir) ?? [],
			events: {
				log: (kind, text) => this.appendLog(record, kind, text),
				usage: (usage) => {
					record.usage = usage;
				},
				vendorSession: (sessionId) => {
					record.vendorSessionId = sessionId;
				},
			},
		};

		record.driver = this.createTransport(transportOptions);
		this.workers.set(id, record);
		if (writer) this.activeWriter = id;
		if (request.room) this.ensureRoom(request.room);

		try {
			await record.driver.start();
		} catch (error) {
			this.finish(record, "failed", error instanceof Error ? error.message : String(error));
			throw error;
		}

		this.setState(record, "running");
		this.enqueue(record, request.task);
		const summary = this.summarize(record);
		// A pane is a convenience for the person watching; never let it fail a spawn.
		try {
			this.options.panes?.open(summary);
		} catch {
			this.appendLog(record, "error", "Could not open a pane for this worker; it is running headless.");
		}
		return summary;
	}

	send(workerId: string, message: string): WorkerSummary {
		const record = this.require(workerId);
		if (isTerminalState(record.state)) {
			throw new Error(`Worker ${workerId} already finished (${record.state}). Spawn a new worker instead.`);
		}
		this.appendLog(record, "status", `Leader: ${message}`);
		this.enqueue(record, message);
		return this.summarize(record);
	}

	answer(workerId: string, answer: string): WorkerSummary {
		const record = this.require(workerId);
		const pending = record.pendingAsk;
		if (!pending) throw new Error(`Worker ${workerId} is not waiting for an answer.`);
		record.pendingAsk = undefined;
		this.appendLog(record, "status", `Leader answered: ${answer}`);
		this.setState(record, "running");
		pending.resolve({ ok: true, text: answer });
		return this.summarize(record);
	}

	kill(workerId: string): WorkerSummary {
		const record = this.require(workerId);
		if (!isTerminalState(record.state)) {
			record.driver.kill();
			this.finish(record, "killed", "Killed by the leader.");
		}
		return this.summarize(record);
	}

	list(): WorkerSummary[] {
		return [...this.workers.values()].map((record) => this.summarize(record));
	}

	get(workerId: string): WorkerSummary {
		return this.summarize(this.require(workerId));
	}

	/** New log lines since the last drain, oldest first. */
	drainLog(workerId: string): WorkerLogEntry[] {
		const record = this.require(workerId);
		const entries = record.log.slice(record.logCursor);
		record.logCursor = record.log.length;
		return entries;
	}

	/**
	 * Log entries after `since`, without moving the leader's cursor. Pane
	 * watchers and other terminals read through here so they never steal lines
	 * the leader has not seen.
	 */
	tailLog(workerId: string, since = 0): WorkerLogPage {
		const record = this.require(workerId);
		const from = Math.max(0, Math.min(since, record.log.length));
		return {
			entries: record.log.slice(from),
			cursor: record.log.length,
			state: record.state,
			worker: this.summarize(record),
			archived: record.archived ?? false,
		};
	}

	roomTranscript(room: string, tail?: number): RoomPost[] {
		const posts = this.rooms.get(room) ?? [];
		return tail && tail > 0 ? posts.slice(-tail) : posts;
	}

	postToRoom(room: string, from: string, label: string, text: string): void {
		this.ensureRoom(room).push({ at: Date.now(), from, label, text });
	}

	/** Resolves when every listed worker is terminal, or when the timeout fires. */
	async waitFor(workerIds: string[], timeoutMs: number): Promise<WorkerSummary[]> {
		const records = workerIds.map((id) => this.require(id));
		const pending = records.filter((record) => !isTerminalState(record.state));
		if (pending.length === 0) return records.map((record) => this.summarize(record));

		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(finish, timeoutMs);
			timer.unref?.();
			let remaining = pending.length;
			for (const record of pending) {
				record.waiters.push(() => {
					remaining -= 1;
					if (remaining === 0) finish();
				});
			}
		});

		return records.map((record) => this.summarize(record));
	}

	async dispose(): Promise<void> {
		for (const record of this.workers.values()) {
			if (!isTerminalState(record.state)) {
				record.driver.kill();
				this.finish(record, "killed", "Leader shut down.");
			}
			await rm(record.scratchDir, { recursive: true, force: true }).catch(() => {});
		}
		this.workers.clear();
	}

	// =========================================================================
	// Worker channel (ChannelHandler)
	// =========================================================================

	notify(workerId: string, text: string): ChannelResponse {
		const record = this.workers.get(workerId);
		if (!record) return { ok: false, error: `Unknown worker ${workerId}.` };
		this.appendLog(record, "notify", text);
		return { ok: true };
	}

	say(workerId: string, text: string): ChannelResponse {
		const record = this.workers.get(workerId);
		if (!record) return { ok: false, error: `Unknown worker ${workerId}.` };
		if (!record.room) return { ok: false, error: "You are not in a room." };
		this.postToRoom(record.room, workerId, `${record.role}/${record.tier}`, text);
		this.appendLog(record, "say", text);
		return { ok: true };
	}

	room(workerId: string, tail: number | undefined): ChannelResponse {
		const record = this.workers.get(workerId);
		if (!record) return { ok: false, error: `Unknown worker ${workerId}.` };
		if (!record.room) return { ok: false, error: "You are not in a room." };
		const posts = this.roomTranscript(record.room, tail);
		if (posts.length === 0) return { ok: true, text: "(room is empty)" };
		return { ok: true, text: posts.map((post) => `[${post.label}] ${post.text}`).join("\n") };
	}

	ask(workerId: string, text: string, signal: AbortSignal): Promise<ChannelResponse> {
		const record = this.workers.get(workerId);
		if (!record) return Promise.resolve({ ok: false, error: `Unknown worker ${workerId}.` });
		if (record.tier === "junior") {
			return Promise.resolve({
				ok: false,
				error: "Junior workers cannot ask the leader. Stop and finish with a report describing what is missing.",
			});
		}
		if (record.pendingAsk) {
			return Promise.resolve({ ok: false, error: "You already have a question waiting for an answer." });
		}

		return new Promise<ChannelResponse>((resolve) => {
			const settle = (response: ChannelResponse) => {
				if (record.pendingAsk?.resolve === settle) record.pendingAsk = undefined;
				resolve(response);
			};
			record.pendingAsk = { question: text, resolve: settle };
			this.appendLog(record, "status", `Asked the leader: ${text}`);
			this.setState(record, "waiting");
			signal.addEventListener(
				"abort",
				() => {
					if (record.pendingAsk?.resolve !== settle) return;
					record.pendingAsk = undefined;
					if (record.state === "waiting") this.setState(record, "running");
				},
				{ once: true },
			);
			this.options.onEvent({ type: "ask", workerId, question: text });
		});
	}

	/**
	 * Leader operations over the socket. The MCP control plane and this path
	 * share all state; the token is what separates a leader from a worker.
	 */
	async leader(request: LeaderChannelRequest, _signal: AbortSignal): Promise<ChannelResponse> {
		if (request.token !== this.leaderToken) {
			return { ok: false, error: "Invalid leader token. Worker processes cannot use leader commands." };
		}
		try {
			switch (request.type) {
				case "spawn": {
					if (!(TIERS as readonly string[]).includes(request.tier)) {
						return { ok: false, error: `Unknown tier "${request.tier}". Tiers: ${TIERS.join(", ")}.` };
					}
					const summary = await this.spawn({
						role: request.role,
						tier: request.tier as Tier,
						task: request.task,
						writer: request.writer,
						room: request.room,
						backend: request.backend,
					});
					const access = summary.writer ? "writer" : "read-only";
					return {
						ok: true,
						text: `Spawned ${summary.id} (${summary.role}/${summary.tier}, ${access}, backend ${summary.backend}). You get a message when it finishes or asks a question.`,
					};
				}
				case "workers": {
					const workers = this.list();
					if (workers.length === 0) return { ok: true, text: "No workers." };
					return { ok: true, text: workers.map((worker) => this.statusLine(worker, 200)).join("\n") };
				}
				case "log": {
					const entries = this.drainLog(request.workerId);
					if (entries.length === 0) return { ok: true, text: "(no new log entries)" };
					return { ok: true, text: entries.map((entry) => `[${entry.kind}] ${entry.text}`).join("\n") };
				}
				case "tail": {
					const page = this.tailLog(request.workerId, request.since);
					return {
						ok: true,
						text: page.entries.map((entry) => `[${entry.kind}] ${entry.text}`).join("\n"),
						data: page,
					};
				}
				case "wait": {
					const summaries = await this.waitFor(request.workerIds, request.timeoutMs ?? 600_000);
					return { ok: true, text: summaries.map((summary) => this.statusLine(summary)).join("\n\n") };
				}
				case "send":
					return { ok: true, text: this.statusLine(this.send(request.workerId, request.text), 200) };
				case "answer":
					return { ok: true, text: this.statusLine(this.answer(request.workerId, request.text), 200) };
				case "kill":
					return { ok: true, text: this.statusLine(this.kill(request.workerId), 200) };
			}
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private statusLine(summary: WorkerSummary, resultLimit?: number): string {
		const access = summary.writer ? "writer" : "read-only";
		const room = summary.room ? `, room ${summary.room}` : "";
		let line = `${summary.id} [${summary.role}/${summary.tier}, ${access}${room}] ${summary.state} — ${summary.task}`;
		const usage = formatUsage(summary.usage);
		if (usage) line += `\n  usage: ${usage}`;
		if (summary.pendingQuestion) line += `\n  asks: ${summary.pendingQuestion}`;
		if (summary.result) {
			const result =
				resultLimit && summary.result.length > resultLimit
					? `${summary.result.slice(0, resultLimit)}…`
					: summary.result;
			line += `\n  ${result}`;
		}
		return line;
	}

	private require(workerId: string): WorkerRecord {
		const record = this.workers.get(workerId);
		if (!record) {
			const known = [...this.workers.keys()].join(", ") || "none";
			throw new Error(`Unknown worker "${workerId}". Active workers: ${known}.`);
		}
		return record;
	}

	private ensureRoom(room: string): RoomPost[] {
		const existing = this.rooms.get(room);
		if (existing) return existing;
		const posts: RoomPost[] = [];
		this.rooms.set(room, posts);
		return posts;
	}

	private appendLog(record: WorkerRecord, kind: WorkerLogEntry["kind"], text: string): void {
		record.log.push({ at: Date.now(), kind, text });
		if (record.log.length > MAX_LOG_ENTRIES) {
			const dropped = record.log.length - MAX_LOG_ENTRIES;
			record.log.splice(0, dropped);
			record.logCursor = Math.max(0, record.logCursor - dropped);
		}
	}

	private setState(record: WorkerRecord, state: WorkerState): void {
		record.state = state;
	}

	private enqueue(record: WorkerRecord, message: string): void {
		record.queuedPrompts += 1;
		record.queue = record.queue.then(async () => {
			try {
				if (isTerminalState(record.state)) return;
				const outcome = await record.driver.prompt(message);
				if (isTerminalState(record.state)) return;
				if (!outcome.ok) {
					this.finish(record, "failed", outcome.summary);
					this.options.onEvent({ type: "failed", workerId: record.id, error: outcome.summary });
					return;
				}
				// A follow-up arrived while this turn ran. An earlier version
				// finished the worker here anyway, which silently dropped every
				// message sent to a running worker: it was logged, queued, and then
				// thrown away by the terminal-state check above.
				if (record.queuedPrompts > 1) {
					this.appendLog(record, "status", `turn ended: ${outcome.summary}`);
					return;
				}
				const dirtyFiles = record.writer ? await gitDirtyFiles(this.options.cwd) : [];
				this.finish(record, "done", outcome.summary);
				this.options.onEvent({
					type: "done",
					workerId: record.id,
					summary: outcome.summary,
					dirtyFiles: dirtyFiles.length > 0 ? dirtyFiles : undefined,
				});
			} finally {
				record.queuedPrompts -= 1;
			}
		});
	}

	private finish(record: WorkerRecord, state: WorkerState, result: string): void {
		record.state = state;
		record.endedAt = Date.now();
		record.result = result;
		// A finished worker's prose already streamed into the log, so logging the
		// full result here printed the whole final message a second time, raw, in
		// every pane. The state is the news; the text is not. Failures still carry
		// their reason, which did not stream.
		this.appendLog(record, state === "done" ? "status" : "error", state === "done" ? "done" : `${state}: ${result}`);
		if (this.activeWriter === record.id) this.activeWriter = undefined;
		record.pendingAsk?.resolve({ ok: false, error: `Worker ${state}.` });
		record.pendingAsk = undefined;
		const waiters = record.waiters;
		record.waiters = [];
		for (const waiter of waiters) waiter();
	}

	private summarize(record: WorkerRecord): WorkerSummary {
		return {
			id: record.id,
			name: record.name,
			role: record.role,
			tier: record.tier,
			backend: record.backend,
			writer: record.writer,
			room: record.room,
			state: record.state,
			task: record.task,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			result: record.result,
			pendingQuestion: record.pendingAsk?.question,
			scratchDir: record.scratchDir,
			usage: record.usage,
			vendorSessionId: record.vendorSessionId,
		};
	}
}
