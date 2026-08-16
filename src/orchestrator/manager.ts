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

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AcpWorkerTransport } from "../acp/transport.ts";
import type { ChannelResponse, LeaderChannelRequest } from "../channel/protocol.ts";
import { NETA_SCRATCH_ENV, NETA_SOCKET_ENV, NETA_WORKER_ENV, NETA_WORKER_TOKEN_ENV } from "../channel/protocol.ts";
import type { ChannelHandler } from "../channel/server.ts";
import { APP_NAME } from "../config.ts";
import { loadRoleText, roleNames, workingAgreement } from "../prompts/roles.ts";
import type { NetaConfig, ResolvedBackend } from "../settings.ts";
import {
	displayModel,
	formatUsage,
	isTerminalState,
	type Note,
	type RoomPost,
	type SpawnRequest,
	TIERS,
	type Tier,
	type WaitOptions,
	type WaitResult,
	type WorkerEvent,
	type WorkerLogEntry,
	type WorkerLogPage,
	type WorkerState,
	type WorkerStatusSnapshot,
	type WorkerSummary,
	type WorkerUsage,
} from "../types.ts";
import {
	formatLastProgress,
	formatStatusSnapshot,
	formatWriterActivityNotice,
	formatWriterContext,
	formatWriterStatus,
} from "./status.ts";
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
	/** Capability token for this worker's channel requests. */
	channelToken: string;
	driver: WorkerTransportDriver;
	log: WorkerLogEntry[];
	/** Absolute index of the first retained log entry. */
	logFirstIndex: number;
	/** Log entries the leader has already been shown. */
	logCursor: number;
	pendingAsk?: { question: string; resolve: (response: ChannelResponse) => void };
	/** The worker's most recent `neta progress`, for a "last:" line in listings. */
	lastProgress?: { text: string; at: number };
	/** Serializes prompts for this worker. */
	queue: Promise<void>;
	/** Prompts queued or running. The worker is only done when the last one ends. */
	queuedPrompts: number;
	/** Terminal result is captured and its ACP process is being stopped. */
	finishing?: Promise<void>;
	/** A leader-initiated stop must beat a rejected in-flight prompt. */
	killReason?: string;
	waiters: Array<() => void>;
	usage?: WorkerUsage;
	vendorSessionId?: string;
	/** Finished, and superseded by a later batch: its view can close. */
	archived?: boolean;
	model?: string;
	modelId?: string;
	mode?: string;
	/** The ACP bridge the backend runs behind, as "name@version". */
	agentInfo?: string;
	/** Note this worker is linked to. */
	noteId?: string;
	/** Writer holding the slot this worker is queued behind. */
	queuedBehind?: string;
	/** Messages held until this worker's first prompt can accept them. */
	pendingBrief: string[];
	/** HEAD when a writer began, used to report commit state without guessing. */
	headAtStart?: string;
	/** Detached ACP process group, for startup cleanup after a manager crash. */
	processGroupId?: number;
	/** Why this worker has no visible mux tab. */
	headlessReason?: string;
}

/** Opens a pane per worker, when a multiplexer is running. */
export interface WorkerPaneHost {
	open(worker: WorkerSummary): { opened: true } | { opened: false; reason: string };
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
	workerMcpServers?: (workerId: string, scratchDir: string, token: string) => WorkerMcpServer[];
	/** Opens a pane per worker. Omitted means headless. */
	panes?: WorkerPaneHost;
	/** The explicit reason every worker runs headless when there is no pane host. */
	headlessReason?: string;
	/** Persists a detached worker group while it can outlive the manager. */
	onWorkerProcessGroup?: (workerId: string, pgid: number | undefined) => void;
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

function gitHead(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

export class WorkerManager implements ChannelHandler {
	private options: WorkerManagerOptions;
	private readonly workers = new Map<string, WorkerRecord>();
	private readonly rooms = new Map<string, RoomPost[]>();
	private readonly createTransport: TransportFactory;
	/** Waits watching a room for new posts; poked by postToRoom. */
	private readonly roomWatchers = new Map<string, Array<() => void>>();
	private counter = 0;
	private activeWriter: string | undefined;
	/** Backend of the most recent writer, for diversity rule. Never cleared. */
	private lastWriterBackend: string | undefined;
	/** Per-room debater backend assignments, for room-scoped vendor mixing. */
	private readonly roomDebaterBackends = new Map<string, string[]>();
	/** Authorizes leader channel commands. Given only to the leader's own process. */
	readonly leaderToken: string;
	/** Open-notes ledger. */
	private readonly notes = new Map<string, Note>();
	private noteCounter = 0;
	/** FIFO queue of writer worker IDs waiting for the slot. */
	private readonly writerQueue: string[] = [];
	/** Shutdown has begun; no queued writer may acquire the slot. */
	private disposed = false;

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

	/** Current working directory. */
	get cwd(): string {
		return this.options.cwd;
	}

	// =========================================================================
	// Leader-facing API
	// =========================================================================

	async spawn(request: SpawnRequest): Promise<WorkerSummary> {
		const writer = request.writer ?? false;

		// Validate note linkage
		if (request.note) {
			const note = this.notes.get(request.note);
			if (!note) {
				throw new Error(`Unknown note id "${request.note}".`);
			}
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

		const backendName = this.computeBackendAssignment(request, {
			cursors: this.spreadCursors,
			lastWriterBackend: this.lastWriterBackend,
			roomDebaterBackends: this.roomDebaterBackends,
		});
		const backend = this.options.config.resolve(request.tier, backendName, writer);
		const id = `${writer ? "rw" : "ro"}${++this.counter}`;
		const reservedWriterSlot = writer && !this.activeWriter;
		if (reservedWriterSlot) this.activeWriter = id;
		let runtimeEnv: Record<string, string>;
		let scratchDir: string;
		try {
			runtimeEnv = (await this.options.prepareEnv?.()) ?? {};
			scratchDir = await mkdtemp(join(tmpdir(), `neta-${id}-`));
		} catch (error) {
			if (reservedWriterSlot && this.activeWriter === id) {
				this.activeWriter = undefined;
				void this.dequeueNextWriter();
			}
			throw error;
		}
		const shouldQueue = writer && this.activeWriter !== id;
		if (writer && !this.activeWriter) this.activeWriter = id;

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
			state: shouldQueue ? "queued" : "starting",
			startedAt: Date.now(),
			scratchDir,
			channelToken: randomBytes(16).toString("hex"),
			log: [],
			logFirstIndex: 0,
			logCursor: 0,
			queue: Promise.resolve(),
			queuedPrompts: 0,
			waiters: [],
			driver: undefined as unknown as WorkerTransportDriver,
			noteId: request.note,
			pendingBrief: [],
		};

		this.workers.set(id, record);
		if (request.room) this.ensureRoom(request.room);

		// Linked at spawn, not at finish: the ledger shows the note as being
		// worked while the worker runs, instead of "(unworked)".
		if (record.noteId) {
			this.notes.get(record.noteId)?.workers.push({ workerId: id, state: record.state });
		}

		// If queued, add to queue and return early. The queue notice is
		// spawn-response text, not a result: an earlier version stored it in
		// record.result and every listing showed it as the worker's output.
		if (shouldQueue) {
			this.writerQueue.push(id);
			const queuedBehind = this.activeWriter;
			const holderInfo = queuedBehind ? this.workers.get(queuedBehind) : undefined;
			record.queuedBehind = queuedBehind;
			this.appendLog(
				record,
				"status",
				`Queued behind ${queuedBehind} (${holderInfo?.role ?? "unknown"}). Will start automatically.`,
			);
			return this.summarize(record);
		}

		// Non-queued path: start immediately
		record.driver = this.createWorkerTransport(record, backend, runtimeEnv, systemPrompt);
		if (writer) {
			record.headAtStart = gitHead(this.options.cwd);
			this.lastWriterBackend = backend.name;
		}

		// Track debater assignments in room state for room-scoped mixing
		if (request.role === "debater" && request.room) {
			const roomBackends = this.roomDebaterBackends.get(request.room) ?? [];
			roomBackends.push(backend.name);
			this.roomDebaterBackends.set(request.room, roomBackends);
		}

		try {
			await record.driver.start();
		} catch (error) {
			await this.finish(record, "failed", error instanceof Error ? error.message : String(error));
			throw error;
		}

		this.setState(record, "running");
		if (writer) this.notifyReadOnlyWorkers(record, "started");
		const activeWriter = this.activeWriter ? this.workers.get(this.activeWriter) : undefined;
		const writerContext = writer
			? undefined
			: formatWriterContext(
					activeWriter ? this.summarize(activeWriter) : undefined,
					this.writerQueue.flatMap((workerId) => {
						const queued = this.workers.get(workerId);
						return queued ? [this.summarize(queued)] : [];
					}),
				);
		const task = writerContext ? `${writerContext}\n\n---\n\n# Task\n\n${request.task}` : request.task;
		this.enqueue(record, this.withPendingBrief(record, task));
		this.openWorkerView(record);
		return this.summarize(record);
	}

	send(workerId: string, message: string): WorkerSummary {
		const record = this.require(workerId);
		if (isTerminalState(record.state)) {
			throw new Error(`Worker ${workerId} already finished (${record.state}). Spawn a new worker instead.`);
		}
		if (record.finishing) {
			throw new Error(`Worker ${workerId} is finishing. Spawn a new worker instead.`);
		}
		if (record.state === "queued") {
			// Append to pending brief for delivery when started
			record.pendingBrief.push(message);
			this.appendLog(record, "status", `Leader queued message (will be delivered at start): ${message}`);
		} else {
			this.appendLog(record, "status", `Leader: ${message}`);
			this.enqueue(record, message);
		}
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

	async kill(workerId: string): Promise<WorkerSummary> {
		const record = this.require(workerId);
		if (!isTerminalState(record.state)) {
			record.killReason = "Killed by the leader.";
			record.driver?.markTerminal();
			if (record.state === "queued") {
				// Remove from queue and mark killed without starting driver
				const index = this.writerQueue.indexOf(workerId);
				if (index >= 0) this.writerQueue.splice(index, 1);
				await this.finish(record, "killed", "Killed by the leader.");
			} else {
				await record.driver?.kill();
				await this.finish(record, "killed", "Killed by the leader.");
			}
		}
		return this.summarize(record);
	}

	list(): WorkerSummary[] {
		return [...this.workers.values()].map((record) => this.summarize(record));
	}

	get(workerId: string): WorkerSummary {
		return this.summarize(this.require(workerId));
	}

	/** One complete, point-in-time view for the MCP and socket status commands. */
	statusSnapshot(): WorkerStatusSnapshot {
		const summaries = this.list();
		const byId = new Map(summaries.map((summary) => [summary.id, summary]));
		return {
			writerSlot: this.activeWriter ? byId.get(this.activeWriter) : undefined,
			writerQueue: this.writerQueue.flatMap((workerId) => {
				const summary = byId.get(workerId);
				return summary ? [summary] : [];
			}),
			workers: {
				running: summaries.filter((summary) => summary.state === "starting" || summary.state === "running"),
				queued: summaries.filter((summary) => summary.state === "queued"),
				waiting: summaries.filter((summary) => summary.state === "waiting"),
				terminal: summaries.filter((summary) => isTerminalState(summary.state)),
			},
			openNotes: this.getOpenNotes(),
		};
	}

	/** Render the shared status snapshot for the socket channel. */
	status(): string {
		return formatStatusSnapshot(this.statusSnapshot());
	}

	/** Writers-only status available to read-only workers through their channel. */
	writerStatus(workerId: string): ChannelResponse {
		this.require(workerId);
		return { ok: true, text: formatWriterStatus(this.statusSnapshot()) };
	}

	/** New log lines since the last drain, oldest first. */
	drainLog(workerId: string): WorkerLogEntry[] {
		const record = this.require(workerId);
		const from = Math.max(record.logCursor, record.logFirstIndex);
		const entries = record.log.slice(from - record.logFirstIndex);
		record.logCursor = record.logFirstIndex + record.log.length;
		return entries;
	}

	/**
	 * Log entries after `since`, without moving the leader's cursor. Pane
	 * watchers and other terminals read through here so they never steal lines
	 * the leader has not seen.
	 */
	tailLog(workerId: string, since = 0): WorkerLogPage {
		const record = this.require(workerId);
		const from = Math.max(0, since);
		const trimmed = Math.max(0, record.logFirstIndex - from);
		const entries = record.log.slice(Math.max(0, from - record.logFirstIndex));
		return {
			entries:
				trimmed > 0
					? [{ at: Date.now(), kind: "status", text: `…${trimmed} earlier entries trimmed` }, ...entries]
					: entries,
			cursor: record.logFirstIndex + record.log.length,
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
		for (const watcher of [...(this.roomWatchers.get(room) ?? [])]) watcher();
	}

	/**
	 * Block until the watched workers need the leader: all of them terminal (or
	 * the first one, in first mode), one of them blocking on a question, a new
	 * post in a watched room, or the timeout. A pending question always wakes
	 * the wait — an unanswered ask is more urgent than continuing to block. A
	 * condition already true at call time returns immediately.
	 */
	async wait(workerIds: string[], timeoutMs: number, options: WaitOptions = {}): Promise<WaitResult> {
		const records = workerIds.map((id) => this.require(id));
		const rooms = [...new Set(options.rooms ?? [])];
		const roomCursors = new Map(rooms.map((room) => [room, (this.rooms.get(room) ?? []).length]));

		const snapshot = (
			reason: WaitResult["reason"],
			wokeBy?: WorkerRecord,
			roomActivity?: WaitResult["roomActivity"],
		): WaitResult => ({
			reason,
			workers: records.map((record) => this.summarize(record)),
			wokeBy: wokeBy ? this.summarize(wokeBy) : undefined,
			roomActivity,
		});

		const evaluate = (): WaitResult | undefined => {
			const asking = records.find((record) => record.state === "waiting" && record.pendingAsk);
			if (asking) return snapshot("ask", asking);
			const terminal = records.filter((record) => isTerminalState(record.state));
			if (terminal.length === records.length) return snapshot("completed");
			if (options.first && terminal.length > 0) return snapshot("first", terminal[0]);
			for (const [room, cursor] of roomCursors) {
				const posts = this.rooms.get(room) ?? [];
				if (posts.length > cursor) return snapshot("room", undefined, { room, posts: posts.slice(cursor) });
			}
			return undefined;
		};

		const immediate = evaluate();
		if (immediate) return immediate;

		return new Promise<WaitResult>((resolve) => {
			let settled = false;
			const settle = (result: WaitResult) => {
				settled = true;
				clearTimeout(timer);
				for (const record of records) {
					record.waiters = record.waiters.filter((waiter) => waiter !== poke);
				}
				for (const room of rooms) {
					const watchers = this.roomWatchers.get(room)?.filter((watcher) => watcher !== poke);
					if (!watchers) continue;
					if (watchers.length === 0) this.roomWatchers.delete(room);
					else this.roomWatchers.set(room, watchers);
				}
				resolve(result);
			};
			const poke = () => {
				if (settled) return;
				const result = evaluate();
				if (result) settle(result);
			};
			const timer = setTimeout(() => {
				if (!settled) settle(snapshot("timeout"));
			}, timeoutMs);
			timer.unref?.();
			for (const record of records) record.waiters.push(poke);
			for (const room of rooms) {
				this.roomWatchers.set(room, [...(this.roomWatchers.get(room) ?? []), poke]);
			}
		});
	}

	/** Resolves when every listed worker is terminal, one blocks on a question, or the timeout fires. */
	async waitFor(workerIds: string[], timeoutMs: number): Promise<WorkerSummary[]> {
		return (await this.wait(workerIds, timeoutMs)).workers;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const records = [...this.workers.values()];
		await Promise.all(
			records.map(async (record) => {
				if (!isTerminalState(record.state)) {
					record.killReason = "Leader shut down.";
					record.driver?.markTerminal();
					try {
						await record.driver?.kill();
					} catch (error) {
						this.appendLog(
							record,
							"error",
							`Could not stop worker: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					try {
						await this.finish(record, "killed", "Leader shut down.");
					} catch (error) {
						this.appendLog(
							record,
							"error",
							`Could not finish shutdown: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				await rm(record.scratchDir, { recursive: true, force: true }).catch(() => {});
			}),
		);
		this.workers.clear();
	}

	/**
	 * Compute backend assignments for proposed workers without spawning them.
	 * Used by the neta_plan tool to present a staffing plan before spawning.
	 * Returns a list of computed assignments in the same order as the requests.
	 *
	 * Operates on a deep copy of the live state so planning never mutates the
	 * manager's cursors. Threads planned writers through the simulation so
	 * diversity rules see the same lastWriterBackend the real spawn sequence
	 * will produce.
	 */
	planAssignments(
		requests: Array<{ role: string; tier: Tier; writer?: boolean; backend?: string; room?: string }>,
	): Array<{ role: string; tier: Tier; backend: string; writer: boolean }> {
		// Deep copy state so planning never mutates live cursors or room assignments
		const simulatedState = {
			cursors: new Map(this.spreadCursors),
			lastWriterBackend: this.lastWriterBackend,
			roomDebaterBackends: new Map(
				[...this.roomDebaterBackends.entries()].map(([room, backends]) => [room, [...backends]]),
			),
		};

		return requests.map((request) => {
			const writer = request.writer ?? false;
			const backendName = this.computeBackendAssignment(
				{
					...request,
					task: "", // Not used for planning
					writer,
				},
				simulatedState,
			);

			// Thread planned writers through the simulation
			if (writer) {
				simulatedState.lastWriterBackend = backendName;
			}

			// Thread planned debaters through room state simulation
			if (request.role === "debater" && request.room) {
				const roomBackends = simulatedState.roomDebaterBackends.get(request.room) ?? [];
				roomBackends.push(backendName);
				simulatedState.roomDebaterBackends.set(request.room, roomBackends);
			}

			return {
				role: request.role,
				tier: request.tier,
				backend: backendName,
				writer,
			};
		});
	}

	// =========================================================================
	// Worker channel (ChannelHandler)
	// =========================================================================

	progress(workerId: string, text: string): ChannelResponse {
		const record = this.workers.get(workerId);
		if (!record) return { ok: false, error: `Unknown worker ${workerId}.` };
		record.lastProgress = { text, at: Date.now() };
		this.appendLog(record, "progress", text);
		return { ok: true };
	}

	authenticateWorker(workerId: string, token: string | undefined): ChannelResponse {
		const record = this.workers.get(workerId);
		if (!record || !token || record.channelToken !== token) {
			return { ok: false, error: `Invalid worker token for ${workerId}.` };
		}
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
		if (record.tier === "apprentice" || record.tier === "journeyman") {
			return Promise.resolve({
				ok: false,
				error: "Apprentice and journeyman workers cannot ask the leader. Stop and finish with a report describing what is missing.",
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
						name: request.name,
						writer: request.writer,
						room: request.room,
						backend: request.backend,
						note: request.note,
					});
					const access = summary.writer ? "writer" : "read-only";
					if (summary.state === "queued") {
						return {
							ok: true,
							text:
								`Queued ${summary.id} (writer) behind ${summary.queuedBehind}; starts automatically when the writer slot frees.\n` +
								"Queued — when it starts, collect it with neta wait before ending your turn; a worker that finishes after your turn ends reaches nobody.",
						};
					}
					return {
						ok: true,
						text:
							`Spawned ${summary.id} (${summary.role}/${summary.tier}, ${access}, backend ${summary.backend}). You get a message when it finishes or asks a question.\n` +
							"Running — collect it with neta wait before ending your turn; a worker that finishes after your turn ends reaches nobody.",
					};
				}
				case "workers": {
					const workers = this.list();
					if (workers.length === 0) return { ok: true, text: "No workers." };
					return { ok: true, text: workers.map((worker) => this.statusLine(worker, 200)).join("\n") };
				}
				case "status":
					return { ok: true, text: this.status() };
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
					return { ok: true, text: this.statusLine(await this.kill(request.workerId), 200) };
			}
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	// =========================================================================
	// Internals
	// =========================================================================

	/**
	 * Deterministic spread policy: round-robin across installed backends, with a
	 * stable order per tier within the session. This cursor persists across
	 * spawns so the same tier + spawn sequence always produces the same backend.
	 */
	private spreadCursors = new Map<Tier, number>();

	/**
	 * Compute which backend to use for a worker. Returns the backend name to
	 * pass to config.resolve(). Assignment logic:
	 * 1. Explicit backend override (from user) takes precedence
	 * 2. Tier's configured backend (from settings)
	 * 3. Room-scoped diversity for debaters: prefer an installed backend not yet
	 *    used by that room's debaters
	 * 4. Writer diversity rule: reviewer/debater roles prefer a different backend
	 *    than the last writer when another backend is installed
	 * 5. Spread policy across installed backends (deterministic round-robin)
	 *
	 * State object allows planning to simulate without mutating live state.
	 */
	private computeBackendAssignment(
		request: SpawnRequest,
		state: {
			cursors: Map<Tier, number>;
			lastWriterBackend: string | undefined;
			roomDebaterBackends: Map<string, string[]>;
		},
	): string {
		// 1. Explicit backend override
		if (request.backend) return request.backend;

		const mapping = this.options.config.tierMapping()[request.tier];

		// 2. Tier's configured backend
		if (mapping?.backend) return mapping.backend;

		// 3. Spread policy with diversity rules
		const installed = this.options.config.installedBackends();
		if (installed.length === 0) {
			throw new Error("No backends are installed. Install at least one backend (claude, codex, or opencode).");
		}

		// Single backend: use it
		if (installed.length === 1) return installed[0];

		// Room-scoped diversity rule for debaters: prefer an installed backend
		// not yet used by this room's debaters. Cycles when all backends are used.
		if (request.role === "debater" && request.room && installed.length > 1) {
			const roomBackends = state.roomDebaterBackends.get(request.room) ?? [];
			const unusedBackends = installed.filter((name) => !roomBackends.includes(name));
			if (unusedBackends.length > 0) {
				// Pick the first unused backend (deterministic)
				const backend = unusedBackends[0];
				// Track this assignment in state
				const updated = [...roomBackends, backend];
				state.roomDebaterBackends.set(request.room, updated);
				return backend;
			}
			// All backends used; cycle round-robin
			const cursor = roomBackends.length;
			const backend = installed[cursor % installed.length];
			const updated = [...roomBackends, backend];
			state.roomDebaterBackends.set(request.room, updated);
			return backend;
		}

		// Writer diversity rule: reviewer/debater roles prefer a different backend
		// than the last writer when another backend is installed
		const isDiversityRole = request.role === "reviewer" || request.role === "debater";
		if (isDiversityRole && state.lastWriterBackend && installed.length > 1) {
			const otherBackends = installed.filter((name) => name !== state.lastWriterBackend);
			if (otherBackends.length > 0) {
				// Round-robin among non-writer backends
				const cursor = state.cursors.get(request.tier) ?? 0;
				const backend = otherBackends[cursor % otherBackends.length];
				state.cursors.set(request.tier, cursor + 1);
				return backend;
			}
		}

		// Round-robin across all installed backends
		const cursor = state.cursors.get(request.tier) ?? 0;
		const backend = installed[cursor % installed.length];
		state.cursors.set(request.tier, cursor + 1);
		return backend;
	}

	private statusLine(summary: WorkerSummary, resultLimit?: number): string {
		const access = summary.writer ? "writer" : "read-only";
		const room = summary.room ? `, room ${summary.room}` : "";
		const model = displayModel(summary);
		const session = model || summary.mode ? `, ${[model, summary.mode].filter(Boolean).join("/")}` : "";
		let line = `${summary.id} [${summary.role}/${summary.tier}, ${access}${room}${session}] ${summary.state} — ${summary.task}`;
		const usage = formatUsage(summary.usage, summary.modelId ?? summary.model);
		if (usage) line += `\n  usage: ${usage}`;
		const lastProgress = formatLastProgress(summary);
		if (lastProgress) line += `\n  ${lastProgress}`;
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
			record.logFirstIndex += dropped;
			record.logCursor = Math.max(record.logCursor, record.logFirstIndex);
		}
	}

	/** One transport shape for immediate and dequeued workers, including crash-recovery registration. */
	private createWorkerTransport(
		record: WorkerRecord,
		backend: ResolvedBackend,
		runtimeEnv: Record<string, string>,
		systemPrompt: string,
	): WorkerTransportDriver {
		const backendPath = backend.env.PATH;
		const runtimePath = runtimeEnv.PATH;
		return this.createTransport({
			workerId: record.id,
			cwd: this.options.cwd,
			env: {
				...runtimeEnv,
				...backend.env,
				...(backendPath && runtimePath ? { PATH: `${runtimePath}${delimiter}${backendPath}` } : {}),
				[NETA_SOCKET_ENV]: this.options.channelAddress,
				[NETA_WORKER_ENV]: record.id,
				[NETA_WORKER_TOKEN_ENV]: record.channelToken,
				[NETA_SCRATCH_ENV]: record.scratchDir,
			},
			command: backend.command,
			args: backend.args,
			model: backend.model,
			writer: record.writer,
			systemPrompt,
			scratchDir: record.scratchDir,
			mcpServers: this.options.workerMcpServers?.(record.id, record.scratchDir, record.channelToken) ?? [],
			events: {
				log: (kind, text) => this.appendLog(record, kind, text),
				usage: (usage) => {
					record.usage = usage;
				},
				vendorSession: (sessionId) => {
					record.vendorSessionId = sessionId;
				},
				session: (session) => {
					record.model = session.model;
					record.modelId = session.modelId;
					record.mode = session.mode;
					record.agentInfo = session.agentInfo;
				},
				processGroup: (pgid) => {
					record.processGroupId = pgid;
					this.options.onWorkerProcessGroup?.(record.id, pgid);
				},
			},
		});
	}

	private setState(record: WorkerRecord, state: WorkerState): void {
		record.state = state;
		// A worker blocking on ask wakes any wait watching it: an unanswered
		// question is more urgent than continuing to block. Unlike finish(), the
		// waiters stay registered — a wait that does not settle keeps listening.
		if (state === "waiting") {
			for (const waiter of [...record.waiters]) waiter();
		}
		if (record.noteId) {
			const link = this.notes.get(record.noteId)?.workers.find((w) => w.workerId === record.id);
			if (link) link.state = state;
		}
	}

	private enqueue(record: WorkerRecord, message: string): void {
		record.queuedPrompts += 1;
		record.queue = record.queue.then(async () => {
			try {
				if (isTerminalState(record.state) || record.finishing || record.killReason) return;
				const outcome = await record.driver.prompt(message);
				if (isTerminalState(record.state) || record.finishing || record.killReason) return;
				if (!outcome.ok) {
					await this.finish(record, "failed", outcome.summary);
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
				// The turn result is immutable now, but a backend can still reawaken a
				// session. Stop its process before we make this worker terminal or hand
				// the writer slot to anyone else.
				await this.finish(record, "done", outcome.summary);
			} finally {
				record.queuedPrompts -= 1;
			}
		});
	}

	/**
	 * ACP's session/prompt request owns an entire prompt turn; neither the SDK
	 * nor any supported bridge exposes a way to inject text into a live turn.
	 * Notices are therefore appended as the worker's next prompt and also logged.
	 */
	private notifyReadOnlyWorkers(writer: WorkerRecord, activity: "started" | "finished", changes?: string): void {
		const notice = formatWriterActivityNotice(this.summarize(writer), activity, changes);
		for (const record of this.workers.values()) {
			if (record.writer || record.state === "queued" || isTerminalState(record.state)) continue;
			this.appendLog(record, "status", notice);
			if (record.state === "starting") {
				record.pendingBrief.push(notice);
			} else {
				this.enqueue(record, notice);
			}
		}
	}

	private withPendingBrief(record: WorkerRecord, task: string): string {
		if (record.pendingBrief.length === 0) return task;
		const messages = record.pendingBrief.join("\n\n");
		record.pendingBrief = [];
		return `${task}\n\n---\n\n# Pending messages\n\n${messages}`;
	}

	private async writerChangeStatus(record: WorkerRecord, state: WorkerState): Promise<string> {
		const [head, dirtyFiles] = await Promise.all([
			Promise.resolve(gitHead(this.options.cwd)),
			gitDirtyFiles(this.options.cwd),
		]);
		const committed = record.headAtStart !== undefined && head !== undefined && head !== record.headAtStart;
		const clean = dirtyFiles.length === 0;
		if (state === "killed") {
			const commitStatus = committed
				? `committed before it was killed (${head?.slice(0, 7)})`
				: "not committed before it was killed";
			const checkoutStatus = clean
				? "no uncommitted changes remain"
				: `${dirtyFiles.length} uncommitted change(s) remain`;
			return `${commitStatus}; ${checkoutStatus}. Neta did not discard shared-checkout changes`;
		}
		if (committed && clean) return `committed (${head?.slice(0, 7)})`;
		if (!clean) return `${dirtyFiles.length} uncommitted change(s) remain`;
		return "no repository changes were committed";
	}

	private finish(record: WorkerRecord, state: WorkerState, result: string): Promise<void> {
		if (record.killReason && state !== "killed") {
			state = "killed";
			result = record.killReason;
		}
		if (record.finishing) return record.finishing;
		// This is the backstop during shutdown: a late ACP write is rejected while
		// the process-group kill below is still waiting for its exit event.
		record.driver?.markTerminal();
		const finishing = (async () => {
			const startedWriter = record.writer && record.state !== "queued";
			if (state !== "killed") {
				await record.driver?.kill();
			}
			if (record.processGroupId !== undefined) {
				this.options.onWorkerProcessGroup?.(record.id, undefined);
				record.processGroupId = undefined;
			}
			if (record.killReason) {
				state = "killed";
				result = record.killReason;
			}
			const dirtyFiles = state === "done" && startedWriter ? await gitDirtyFiles(this.options.cwd) : [];
			if (dirtyFiles.length > 0) result = `${result}\nuncommitted changes: ${dirtyFiles.length} files`;
			const changes = startedWriter ? await this.writerChangeStatus(record, state) : undefined;

			this.setState(record, state);
			record.endedAt = Date.now();
			record.result = result;
			// A finished worker's prose already streamed into the log, so logging the
			// full result here printed the whole final message a second time, raw, in
			// every pane. The state is the news; the text is not. Failures still carry
			// their reason, which did not stream.
			this.appendLog(
				record,
				state === "done" ? "status" : "error",
				state === "done" ? "done" : `${state}: ${result}`,
			);

			if (state === "done") {
				this.options.onEvent({
					type: "done",
					workerId: record.id,
					summary: result,
					dirtyFiles: dirtyFiles.length > 0 ? dirtyFiles : undefined,
				});
			} else if (state === "failed") {
				this.options.onEvent({ type: "failed", workerId: record.id, error: result });
			}

			const wasActiveWriter = this.activeWriter === record.id;
			if (startedWriter) this.notifyReadOnlyWorkers(record, "finished", changes);
			if (wasActiveWriter) this.activeWriter = undefined;

			record.pendingAsk?.resolve({ ok: false, error: `Worker ${state}.` });
			record.pendingAsk = undefined;
			const waiters = record.waiters;
			record.waiters = [];
			for (const waiter of waiters) waiter();

			// Dequeue next writer if this was the active writer
			if (wasActiveWriter) {
				void this.dequeueNextWriter();
			}
		})();
		record.finishing = finishing;
		return finishing;
	}

	// =========================================================================
	// Notes ledger
	// =========================================================================

	createNote(text: string): Note {
		const id = `n${++this.noteCounter}`;
		const note: Note = {
			id,
			text,
			open: true,
			createdAt: Date.now(),
			workers: [],
		};
		this.notes.set(id, note);
		return note;
	}

	closeNote(noteId: string): Note {
		const note = this.notes.get(noteId);
		if (!note) throw new Error(`Unknown note id "${noteId}".`);
		note.open = false;
		note.closedAt = Date.now();
		return note;
	}

	listNotes(): Note[] {
		return [...this.notes.values()];
	}

	getOpenNotes(): Note[] {
		return [...this.notes.values()].filter((note) => note.open);
	}

	private async dequeueNextWriter(): Promise<void> {
		if (this.disposed) return;
		if (this.writerQueue.length === 0) return;
		const nextId = this.writerQueue.shift();
		if (!nextId) return;

		const record = this.workers.get(nextId);
		if (!record || record.state !== "queued") return;

		this.activeWriter = nextId;

		// Prepend staleness guard to task
		const stalenessGuard =
			"Note: you were queued behind another writer that has since finished. Check `git log` and `git status` for the repo's current state before starting.";
		const fullTask = `${stalenessGuard}\n\n---\n\n# Task\n\n${record.task}`;

		// Prepare backend and transport
		const backend = this.options.config.resolve(record.tier, record.backend, true);
		const runtimeEnv = (await this.options.prepareEnv?.()) ?? {};
		if (this.disposed || record.state !== "queued") return;
		const roleText = loadRoleText(record.role, this.options.cwd, this.options.agentDir);

		const systemPrompt = [
			roleText?.trim() ?? "",
			"",
			workingAgreement({ tier: record.tier, writer: true, room: record.room, binary: APP_NAME }),
			"",
			`Your scratch directory (outside the repository) is ${record.scratchDir}. Use it for notes and throwaway files.`,
		].join("\n");

		record.driver = this.createWorkerTransport(record, backend, runtimeEnv, systemPrompt);
		record.headAtStart = gitHead(this.options.cwd);
		this.lastWriterBackend = backend.name;
		this.setState(record, "starting");
		this.appendLog(record, "status", "Dequeued and starting...");

		try {
			await record.driver.start();
		} catch (error) {
			await this.finish(record, "failed", error instanceof Error ? error.message : String(error));
			return;
		}

		this.setState(record, "running");
		this.notifyReadOnlyWorkers(record, "started");

		// Enqueue task with staleness guard and any pending messages delivered together
		const firstPrompt = this.withPendingBrief(record, fullTask);
		this.enqueue(record, firstPrompt);

		this.openWorkerView(record);
	}

	/** A missing pane is visible in the spawn result; it never blocks the worker. */
	private openWorkerView(record: WorkerRecord): void {
		const outcome = this.options.panes?.open(this.summarize(record));
		const reason = outcome && !outcome.opened ? outcome.reason : this.options.headlessReason;
		if (!reason) return;
		record.headlessReason = reason;
		this.appendLog(record, "status", `Worker view: headless — ${reason}`);
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
			queuedBehind: record.state === "queued" ? record.queuedBehind : undefined,
			pendingQuestion: record.pendingAsk?.question,
			lastProgress: record.lastProgress,
			scratchDir: record.scratchDir,
			usage: record.usage,
			vendorSessionId: record.vendorSessionId,
			model: record.model,
			modelId: record.modelId,
			mode: record.mode,
			agentInfo: record.agentInfo,
			headlessReason: record.headlessReason,
		};
	}
}
