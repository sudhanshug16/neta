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
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AcpWorkerTransport } from "../acp/transport.ts";
import { workerResumeCommand } from "../attach.ts";
import type { ChannelResponse, LeaderChannelRequest } from "../channel/protocol.ts";
import { NETA_SCRATCH_ENV, NETA_SOCKET_ENV, NETA_WORKER_ENV, NETA_WORKER_TOKEN_ENV } from "../channel/protocol.ts";
import type { ChannelHandler } from "../channel/server.ts";
import {
	type CheckpointLiveLease,
	type CheckpointShutdown,
	type CheckpointWorker,
	type CheckpointWriter,
	type CheckpointWriterQueueEvent,
	type HydratableCheckpoint,
	newCheckpointBase,
	type SessionCheckpoint,
} from "../checkpoint.ts";
import {
	readV6TerminalWorkerRefs,
	readV6WorkerDetails,
	readV6WorkerOutcome,
	readV6WorkerRef,
	type V6CheckpointDelta,
	type V6CheckpointDeltaLane,
	type V6CheckpointState,
	type V6ReadCounters,
	type V6WorkerRef,
} from "../checkpoint-store.ts";
import { APP_NAME } from "../config.ts";
import { loadRoleText, roleNames, workingAgreement } from "../prompts/roles.ts";
import { canonicalizeCwd } from "../session.ts";
import { assertClaudeModelAllowed, type NetaConfig, type ResolvedBackend } from "../settings.ts";
import {
	displayModel,
	formatUsage,
	type GoalDiscovery,
	isTerminalState,
	type Note,
	type RoomLogPage,
	type RoomPost,
	type SessionGoal,
	type SpawnRequest,
	type SteerResult,
	TIERS,
	type Tier,
	type WaitOptions,
	type WaitResult,
	type WorkerEvent,
	type WorkerInspection,
	type WorkerLogEntry,
	type WorkerLogPage,
	type WorkerState,
	type WorkerStatusSnapshot,
	type WorkerSummary,
	type WorkerUsage,
} from "../types.ts";
import { executeRepoCommand, type RepoExecRequest, type RepoExecResult } from "./exec.ts";
import {
	formatInspection,
	formatLastProgress,
	formatStatusSnapshot,
	formatSteerResult,
	formatWorkerDuration,
	formatWriterActivityNotice,
	formatWriterContext,
	formatWriterStatus,
} from "./status.ts";
import type { PromptOutcome, TransportOptions, WorkerMcpServer, WorkerTransportDriver } from "./transport.ts";

const MAX_LOG_ENTRIES = 500;
const CHANNEL_FIELD_LIMIT = 240;
const CHANNEL_RESULT_LIMIT = 3000;
const CHANNEL_ROW_LIMIT = 5;
type ActiveWorkerState = "starting" | "running" | "waiting" | "queued";

function clipChannel(value: string, limit = CHANNEL_FIELD_LIMIT): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 3).trimEnd()}...`;
}

interface GoalMutationInput {
	expectedRevision: number;
	reason?: string;
	evidenceRefs?: readonly string[];
}

interface GoalRevisionInput extends GoalMutationInput {
	workingObjective: string;
}

interface GoalDiscoveryInput {
	id: string;
	workerId?: string;
	finding: string;
	impact: "local" | "goal";
	suggestion?: string;
	evidenceRefs?: readonly string[];
	createdBy?: string;
	expectedRevision?: number;
}

interface GoalResolutionInput extends GoalMutationInput {
	discoveryId: string;
	resolution: "accept" | "reject";
}

interface GoalCompletionInput extends GoalMutationInput {
	override?: boolean;
}

function cloneGoal(goal: SessionGoal | undefined): SessionGoal | undefined {
	if (!goal) return undefined;
	return {
		...goal,
		revisions: goal.revisions.map((revision) => ({ ...revision, evidenceRefs: [...revision.evidenceRefs] })),
		discoveries: goal.discoveries.map((discovery) => ({
			...discovery,
			evidenceRefs: discovery.evidenceRefs ? [...discovery.evidenceRefs] : undefined,
		})),
	};
}

function requireGoalText(value: string, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be non-empty text.`);
	return value;
}

function requireExpectedRevision(value: number): void {
	if (!Number.isInteger(value) || value < 0) throw new Error("expectedRevision must be a non-negative integer.");
}

function copyEvidenceRefs(value: readonly string[] | undefined): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((reference) => typeof reference !== "string" || reference.trim() === ""))
		throw new Error("evidenceRefs must be a list of non-empty text.");
	return [...value];
}

interface WorkerRecord {
	id: string;
	name: string;
	role: string;
	tier: SpawnRequest["tier"];
	backend: string;
	writer: boolean;
	room: string | undefined;
	task: string;
	cwd: string;
	state: WorkerState;
	stateBeforeStop?: ActiveWorkerState;
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
	result?: string;
	/** Latest response to a real task/follow-up, never an automatic system notice. */
	substantiveResponse?: string;
	/** Most recent prompt response, including automatic system notices. */
	lastResponse?: string;
	/** A turn that failed after this worker had already reported; never replaces the report. */
	laterFailure?: string;
	scratchDir?: string;
	/** Capability token for this worker's channel requests. */
	channelToken?: string;
	driver?: WorkerTransportDriver;
	log: WorkerLogEntry[];
	/** Absolute index of the first retained log entry. */
	logFirstIndex: number;
	/** Log entries the leader has already been shown. */
	logCursor: number;
	/** Legacy in-process test hook; no public tool or socket command exposes it. */
	/** Hydrated question text retained without recreating its live resolver callback. */
	pendingQuestion?: string;
	/** The worker's most recent `neta progress`, for a "last:" line in listings. */
	lastProgress?: { text: string; at: number };
	/** Serializes prompts for this worker. */
	queue: Promise<void>;
	/** Prompts queued or running. The worker is only done when the last one ends. */
	queuedPrompts: number;
	/** A `session/prompt` is in flight right now, so there is a turn to cancel. */
	promptInFlight?: boolean;
	/** Turns started so far, so a steer can name the one it aimed at. */
	turnCounter: number;
	/** The turn currently in flight, while `promptInFlight`. */
	currentTurn?: number;
	/** Turns a steer asked the backend to cancel, by turn number. */
	steeredTurns: Set<number>;
	/** Steered turns that did come back cancelled. Retained for concurrent senders. */
	interruptedTurns: Set<number>;
	/** One cancel dispatch per turn; concurrent steering shares it. */
	cancelDispatches: Map<number, Promise<boolean>>;
	/** A cancel write became indeterminate; no later prompt may use this session. */
	unsafeToPrompt?: string;
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
	/** Human pending-brief messages that need an applied-phase log at first prompt. */
	pendingBriefLeaderMessages: string[];
	/** HEAD when a writer began, used to report commit state without guessing. */
	headAtStart?: string;
	/** Detached ACP process group, for startup cleanup after a manager crash. */
	processGroupId?: number;
	/** Why this worker has no visible mux tab. */
	headlessReason?: string;
	revivalCount: number;
	/** Message to deliver after a queued writer reacquires its slot. */
	revivalMessage?: string;
	/** A native TUI was opened for this persisted conversation; ownership is no longer provable. */
	nativeAttached?: boolean;
	/** Exact turn which invoked neta_blocked. */
	blockedTurn?: number;
	/** Goal-impact discovery that stopped the current turn and wakes neta_wait. */
	pendingDiscoveryId?: string;
	revivalFromState?: "blocked" | "done" | "failed";
	revivalPreviousQueuedBehind?: string;
	reviving?: Promise<SteerResult>;
	/** Set after the terminal outcome has been loaded from the v6 store. */
	terminalOutcomeLoaded?: boolean;
	/** Bounded public summary retained after immutable terminal artifacts publish. */
	terminalSummary?: TerminalHotSummary;
	/** Cumulative wall time admitted to run, excluding writer queue delay. */
	activeMs: number;
	/** Cumulative wall time spent in the writer queue. */
	queuedMs: number;
	/** Start of the current active interval. */
	activeStartedAt?: number;
	/** Start of the current writer-queue interval. */
	queuedStartedAt?: number;
}

/** Opens a pane per worker, when a multiplexer is running. */
export interface WorkerPaneHost {
	open(
		worker: WorkerSummary,
	):
		| { opened: true }
		| { opened: false; reason: string }
		| Promise<{ opened: true } | { opened: false; reason: string }>;
	/** Opens the room's merged view; one pane per room, beside its members'. */
	openRoom(
		room: string,
	):
		| { opened: true }
		| { opened: false; reason: string }
		| Promise<{ opened: true } | { opened: false; reason: string }>;
	/** Opens a fresh native backend TUI for an already-terminal worker. */
	attach?(
		worker: WorkerSummary,
		resume: { command: string; args: string[] },
	):
		| {
				opened: true;
		  }
		| { opened: false; reason: string }
		| Promise<{ opened: true } | { opened: false; reason: string }>;
}

export type TransportFactory = (options: TransportOptions) => WorkerTransportDriver;

export interface WorkerManagerOptions {
	cwd: string;
	agentDir: string;
	config: NetaConfig;
	/**
	 * Worker tiers this session may staff, chosen once at startup. Omitted means
	 * every tier — an older launcher, a hand-registered `neta mcp`, or a test that
	 * does not care must never silently lose the ability to delegate.
	 */
	sessionTiers?: Tier[];
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
	workerMcpServers?: (workerId: string, scratchDir: string, token: string, team?: string) => WorkerMcpServer[];
	/** Opens a pane per worker. Omitted means headless. */
	panes?: WorkerPaneHost;
	/** The explicit reason every worker runs headless when there is no pane host. */
	headlessReason?: string;
	/** Persists a detached worker group while it can outlive the manager. */
	onWorkerProcessGroup?: (workerId: string, pgid: number | undefined) => void;
	/** Test seam for the public steering deadline. */
	steerTimeoutMs?: number;
	/** Session-scoped directory for full neta_exec audit output. */
	execOutputDir?: string;
	/** Test seam: swap in a fake transport without touching real CLIs. */
	createTransport?: TransportFactory;
	/** Durable semantic checkpoint. Live channel and process data never enters it. */
	checkpoint?: {
		id: string;
		leaderBackend: string;
		leaderVendorConversationId?: string;
		liveLease?: CheckpointLiveLease;
		writer: CheckpointWriter;
		createdAt?: number;
	};
	/** v6 store location and optional test-only read instrumentation. */
	checkpointStorePath?: string;
	checkpointReadCounters?: V6ReadCounters;
	/** Test seam for deterministic worker elapsed-time accounting. */
	now?: () => number;
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

/**
 * How long a steer waits for the backend to take the new prompt.
 *
 * An agent honors `session/cancel` by finishing whatever update it is mid-way
 * through and then resolving the prompt, which is fast but not instant. Past
 * this the call reports the truth — queued, not yet seen — rather than blocking
 * the leader's tool call any longer.
 */
const STEER_TIMEOUT_MS = 15_000;

function missingUnixChannel(address: string): boolean {
	return process.platform !== "win32" && !address.startsWith("\\\\.\\pipe\\") && !existsSync(address);
}

/**
 * The hard cap on an inspection. Not a default a caller can raise: the point of
 * a bounded window is that its size is knowable before it is asked for.
 */
export const INSPECT_MAX_ENTRIES = 40;
export const INSPECT_MAX_CHARS = 6000;
/** Terminal records retain only this bounded JSON-sized hot summary in memory. */
export const TERMINAL_HOT_STATE_MAX_BYTES = 4096;

interface TerminalHotSummary {
	id: string;
	name: string;
	role: string;
	tier: Tier;
	backend: string;
	writer: boolean;
	room?: string;
	taskPreview: string;
	resultPreview?: string;
	laterFailurePreview?: string;
	pendingQuestionPreview?: string;
	lastProgress?: { text: string; at: number };
	state: WorkerState;
	startedAt: number;
	endedAt?: number;
	activeMs?: number;
	queuedMs?: number;
	activeStartedAt?: number;
	queuedStartedAt?: number;
	stateBeforeStop?: ActiveWorkerState;
}

function terminalTextPreview(value: string | undefined): string | undefined {
	return value === undefined ? undefined : clipChannel(value, 512);
}

function terminalHotSummary(input: {
	id: string;
	name: string;
	role: string;
	tier: Tier;
	backend: string;
	writer: boolean;
	room?: string;
	task: string;
	result?: string;
	laterFailure?: string;
	pendingQuestion?: string;
	lastProgress?: { text: string; at: number };
	state: WorkerState;
	startedAt: number;
	endedAt?: number;
	activeMs?: number;
	queuedMs?: number;
	activeStartedAt?: number;
	queuedStartedAt?: number;
	stateBeforeStop?: ActiveWorkerState;
}): TerminalHotSummary {
	return {
		id: clipChannel(input.id, 128),
		name: clipChannel(input.name, 128),
		role: clipChannel(input.role, 128),
		tier: input.tier,
		backend: clipChannel(input.backend, 128),
		writer: input.writer,
		room: terminalTextPreview(input.room),
		taskPreview: terminalTextPreview(input.task) ?? "",
		resultPreview: terminalTextPreview(input.result),
		laterFailurePreview: terminalTextPreview(input.laterFailure),
		pendingQuestionPreview: terminalTextPreview(input.pendingQuestion),
		lastProgress: input.lastProgress
			? { text: clipChannel(input.lastProgress.text, 512), at: input.lastProgress.at }
			: undefined,
		state: input.state,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		activeMs: input.activeMs,
		queuedMs: input.queuedMs,
		activeStartedAt: input.activeStartedAt,
		queuedStartedAt: input.queuedStartedAt,
		stateBeforeStop: input.stateBeforeStop,
	};
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
	private readonly clock: () => number;
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
	/** Rooms whose merged-view pane is already open, so each opens once. */
	private readonly roomPanesOpened = new Set<string>();
	/** Authorizes leader channel commands. Given only to the leader's own process. */
	readonly leaderToken: string;
	/** Open-notes ledger. */
	private readonly notes = new Map<string, Note>();
	private noteCounter = 0;
	/** FIFO queue of writer worker IDs waiting for the slot. */
	private readonly writerQueue: string[] = [];
	private readonly writerQueueHistory: CheckpointWriterQueueEvent[] = [];
	/** Shutdown has begun; no queued writer may acquire the slot. */
	private disposed = false;
	private readonly execControllers = new Set<AbortController>();
	private readonly execPromises = new Set<Promise<RepoExecResult>>();
	/** In-memory only: a resume starts a fresh manager and legitimately restarts this at 0. */
	private execCallCount = 0;
	/** Hydrated writers remain held until recovery proves their old processes are dead. */
	private recoveryWriterSlotHeld = false;
	/** Set only when this run ended with every worker process confirmed gone. */
	private shutdownProof: CheckpointShutdown | undefined;
	private readonly checkpointCreatedAt: number;
	private checkpointCwd: string;
	/** Tiers this session may staff, in canonical order. Fixed for the session's life. */
	private readonly tiers: Tier[];
	private goal: SessionGoal | undefined;
	private readonly terminalRefs = new Map<string, V6WorkerRef>();
	/** Native clients opened by this manager; hydrated ownership is deliberately not local proof. */
	private readonly nativeAttachmentsOpened = new Set<string>();

	constructor(options: WorkerManagerOptions) {
		this.options = options;
		this.tiers = options.sessionTiers ? TIERS.filter((tier) => options.sessionTiers?.includes(tier)) : [...TIERS];
		if (this.tiers.length === 0) {
			throw new Error("A Neta session must be able to staff at least one worker tier.");
		}
		this.leaderToken = options.leaderToken ?? randomBytes(16).toString("hex");
		this.clock = options.now ?? Date.now;
		this.createTransport =
			options.createTransport ?? ((transportOptions) => new AcpWorkerTransport(transportOptions));
		this.checkpointCreatedAt = options.checkpoint?.createdAt ?? this.now();
		this.checkpointCwd = options.checkpoint ? canonicalizeCwd(options.cwd) : options.cwd;
	}

	private now(): number {
		return this.clock();
	}

	/** Build an inert manager from safe semantic state. No transports, prompts, panes or scratch directories are created. */
	static hydrate(options: WorkerManagerOptions, checkpoint: HydratableCheckpoint): WorkerManager {
		if (options.checkpoint && options.checkpoint.id !== checkpoint.id) {
			throw new Error(`Checkpoint id mismatch: expected ${options.checkpoint.id}, got ${checkpoint.id}.`);
		}
		const manager = new WorkerManager({
			...options,
			cwd: checkpoint.canonicalCwd,
			// The session's own answer wins over whatever this process was told.
			// A checkpoint from before session tiers existed records none, which
			// means the session ran on the full ladder.
			sessionTiers: checkpoint.sessionTiers ?? [...TIERS],
			checkpoint: options.checkpoint
				? {
						...options.checkpoint,
						createdAt: checkpoint.createdAt,
						// The recorded conversation id is the one thing a resumed session
						// cannot re-derive; carry it even when the caller did not pass it.
						leaderVendorConversationId:
							options.checkpoint.leaderVendorConversationId ?? checkpoint.leader.vendorConversationId,
					}
				: undefined,
		});
		if (options.checkpointStorePath) {
			for (const [workerId, reference] of readV6TerminalWorkerRefs(
				options.checkpointStorePath,
				options.checkpointReadCounters,
			))
				manager.terminalRefs.set(workerId, reference);
		}
		manager.goal = cloneGoal(checkpoint.goal);
		manager.counter = checkpoint.counter;
		manager.noteCounter = checkpoint.noteCounter;
		manager.activeWriter = checkpoint.activeWriter;
		manager.writerQueue.push(...checkpoint.writerQueue);
		manager.writerQueueHistory.push(...checkpoint.writerQueueHistory.map((event) => ({ ...event })));
		manager.lastWriterBackend = checkpoint.lastWriterBackend;
		for (const { tier, cursor } of checkpoint.spreadCursors) manager.spreadCursors.set(tier, cursor);
		for (const { room, backends } of checkpoint.roomDebaterBackends)
			manager.roomDebaterBackends.set(room, [...backends]);
		for (const note of checkpoint.notes)
			manager.notes.set(note.id, { ...note, workers: note.workers.map((worker) => ({ ...worker })) });
		for (const room of checkpoint.rooms)
			manager.rooms.set(
				room.name,
				room.posts.map((post) => ({ ...post })),
			);
		const recoveredAt = manager.now();
		for (const worker of checkpoint.workers) {
			const wasActive = !isTerminalState(worker.state);
			const state = wasActive ? "interrupted" : worker.state;
			const stateBeforeStop = wasActive ? (worker.state as ActiveWorkerState) : worker.stateBeforeStop;
			const timing = {
				activeMs: worker.activeMs ?? 0,
				queuedMs: worker.queuedMs ?? 0,
				activeStartedAt: worker.activeStartedAt,
				queuedStartedAt: worker.queuedStartedAt,
			};
			if (wasActive) {
				if (timing.activeStartedAt !== undefined) {
					timing.activeMs += Math.max(0, recoveredAt - timing.activeStartedAt);
					timing.activeStartedAt = undefined;
				}
				if (timing.queuedStartedAt !== undefined) {
					timing.queuedMs += Math.max(0, recoveredAt - timing.queuedStartedAt);
					timing.queuedStartedAt = undefined;
				}
			}
			const record: WorkerRecord = {
				id: worker.id,
				name: worker.name,
				role: worker.role,
				tier: worker.tier,
				backend: worker.backend,
				writer: worker.writer,
				room: worker.room,
				task: worker.task,
				cwd: worker.cwd ?? checkpoint.canonicalCwd,
				state,
				stateBeforeStop,
				startedAt: worker.startedAt,
				updatedAt: wasActive ? recoveredAt : worker.updatedAt,
				endedAt: wasActive ? recoveredAt : worker.endedAt,
				result:
					worker.finalResult ??
					(wasActive ? `Interrupted during recovery (was ${worker.state}); review before continuing.` : undefined),
				substantiveResponse: worker.substantiveResponse,
				lastResponse: worker.lastResponse,
				laterFailure: worker.laterFailure,
				log: worker.log.map((entry) => ({ ...entry })),
				logFirstIndex: worker.logFirstIndex,
				logCursor: worker.logCursor,
				pendingQuestion: worker.pendingQuestion,
				lastProgress: worker.lastProgress ? { ...worker.lastProgress } : undefined,
				queue: Promise.resolve(),
				queuedPrompts: 0,
				turnCounter: 0,
				steeredTurns: new Set<number>(),
				interruptedTurns: new Set<number>(),
				cancelDispatches: new Map<number, Promise<boolean>>(),
				waiters: [],
				usage: worker.usage ? { ...worker.usage } : undefined,
				vendorSessionId: worker.vendorSessionId,
				archived: worker.archived,
				model: worker.model,
				modelId: worker.modelId,
				mode: worker.mode,
				agentInfo: worker.agentInfo,
				noteId: worker.noteId,
				queuedBehind: worker.queuedBehind,
				pendingBrief: [...worker.pendingBrief],
				pendingBriefLeaderMessages: [],
				headAtStart: worker.headAtStart,
				headlessReason: worker.headlessReason,
				revivalCount: worker.revivalCount ?? 0,
				nativeAttached: worker.nativeAttached,
				...timing,
				terminalOutcomeLoaded: !options.checkpointStorePath || !isTerminalState(worker.state),
			};
			if (options.checkpointStorePath && !wasActive && isTerminalState(worker.state)) {
				manager.evictTerminalRecord(
					record,
					terminalHotSummary({
						...worker,
						result: worker.finalResult,
						state,
						endedAt: worker.endedAt,
					}),
				);
			}
			manager.workers.set(worker.id, record);
			if (wasActive) manager.checkpointChanged(record);
			if (wasActive) {
				const link = worker.noteId
					? manager.notes.get(worker.noteId)?.workers.find((item) => item.workerId === worker.id)
					: undefined;
				if (link) link.state = "interrupted";
			}
		}
		manager.recoveryWriterSlotHeld = checkpoint.workers.some(
			(worker) => worker.writer && !isTerminalState(worker.state),
		);
		manager.checkpointChanged();
		return manager;
	}

	/** Rebind to a different working directory or settings. */
	configure(options: { cwd: string; agentDir: string; config: NetaConfig }): void {
		this.options = { ...this.options, ...options };
		if (this.options.checkpoint) this.checkpointCwd = canonicalizeCwd(options.cwd);
		this.checkpointChanged();
	}

	/** Current working directory. */
	get cwd(): string {
		return this.options.cwd;
	}

	/** Current user-level Neta settings directory. */
	get agentDir(): string {
		return this.options.agentDir;
	}

	get logicalSessionId(): string | undefined {
		return this.options.checkpoint?.id;
	}

	/** Phase 2 records the leader vendor's exact resumable conversation id here. */
	setLeaderVendorConversationId(vendorConversationId: string): void {
		const checkpoint = this.options.checkpoint;
		if (!checkpoint) throw new Error("This manager has no durable checkpoint configured.");
		checkpoint.leaderVendorConversationId = vendorConversationId;
		this.checkpointChanged();
	}

	/** Secret-free semantic state suitable for durable storage and phase-2 inspection. */
	checkpointSnapshot(): SessionCheckpoint {
		const checkpoint = this.options.checkpoint;
		if (!checkpoint) throw new Error("This manager has no durable checkpoint configured.");
		return {
			...newCheckpointBase({
				id: checkpoint.id,
				canonicalCwd: this.checkpointCwd,
				leaderBackend: checkpoint.leaderBackend,
				leaderVendorConversationId: checkpoint.leaderVendorConversationId,
				liveLease: this.shutdownProof ? undefined : checkpoint.liveLease,
				shutdown: this.shutdownProof,
				createdAt: this.checkpointCreatedAt,
			}),
			updatedAt: Date.now(),
			sessionTiers: [...this.tiers],
			counter: this.counter,
			noteCounter: this.noteCounter,
			workers: [...this.workers.values()].map((record) => this.checkpointWorkerSnapshot(record)),
			activeWriter: this.activeWriter,
			writerQueue: [...this.writerQueue],
			writerQueueHistory: this.writerQueueHistory.map((event) => ({ ...event })),
			notes: [...this.notes.values()].map((note) => ({
				...note,
				workers: note.workers.map((worker) => ({ ...worker })),
			})),
			rooms: [...this.rooms].map(([name, posts]) => ({ name, posts: posts.map((post) => ({ ...post })) })),
			spreadCursors: [...this.spreadCursors].map(([tier, cursor]) => ({ tier, cursor })),
			lastWriterBackend: this.lastWriterBackend,
			roomDebaterBackends: [...this.roomDebaterBackends].map(([room, backends]) => ({
				room,
				backends: [...backends],
			})),
			goal: cloneGoal(this.goal),
		};
	}

	/** Typed bounded persistence input. It never contains the manager's worker map. */
	checkpointDelta(record?: WorkerRecord, lane: V6CheckpointDeltaLane = "structural"): V6CheckpointDelta {
		const checkpoint = this.options.checkpoint;
		if (!checkpoint) throw new Error("This manager has no durable checkpoint configured.");
		if (record) record.updatedAt = Date.now();
		const includeEvictedTerminalOutcome = record?.terminalSummary !== undefined && isTerminalState(record.state);
		if (includeEvictedTerminalOutcome) this.loadTerminalOutcome(record);
		const worker = record
			? { worker: this.checkpointWorkerSnapshot(record, includeEvictedTerminalOutcome), terminal: isTerminalState(record.state) }
			: undefined;
		if (includeEvictedTerminalOutcome) this.releaseTerminalOutcome(record);
		if (lane === "worker") {
			return {
				id: checkpoint.id,
				lane,
				workers: worker ? [worker] : [],
			};
		}
		return {
			id: checkpoint.id,
			lane,
			state: this.checkpointStateSnapshot(),
			workers: worker ? [worker] : [],
		};
	}

	private checkpointStateSnapshot(): V6CheckpointState {
		const checkpoint = this.options.checkpoint;
		if (!checkpoint) throw new Error("This manager has no durable checkpoint configured.");
		return {
			...newCheckpointBase({
				id: checkpoint.id,
				canonicalCwd: this.checkpointCwd,
				leaderBackend: checkpoint.leaderBackend,
				leaderVendorConversationId: checkpoint.leaderVendorConversationId,
				liveLease: this.shutdownProof ? undefined : checkpoint.liveLease,
				shutdown: this.shutdownProof,
				createdAt: this.checkpointCreatedAt,
			}),
			updatedAt: Date.now(),
			sessionTiers: [...this.tiers],
			counter: this.counter,
			noteCounter: this.noteCounter,
			activeWriter: this.activeWriter,
			writerQueue: [...this.writerQueue],
			writerQueueHistory: this.writerQueueHistory.map((event) => ({ ...event })),
			notes: [...this.notes.values()].map((note) => ({
				...note,
				workers: note.workers.map((worker) => ({ ...worker })),
			})),
			rooms: [...this.rooms].map(([name, posts]) => ({ name, posts: posts.map((post) => ({ ...post })) })),
			spreadCursors: [...this.spreadCursors].map(([tier, cursor]) => ({ tier, cursor })),
			lastWriterBackend: this.lastWriterBackend,
			roomDebaterBackends: [...this.roomDebaterBackends].map(([room, backends]) => ({
				room,
				backends: [...backends],
			})),
			goal: cloneGoal(this.goal),
		};
	}

	private checkpointWorkerSnapshot(record: WorkerRecord, includeTerminalOutcome = false): CheckpointWorker {
		const terminalSummary = record.terminalSummary;
		const terminal = terminalSummary !== undefined;
		return {
			id: record.id,
			name: record.name,
			role: record.role,
			tier: record.tier,
			backend: record.backend,
			writer: record.writer,
			room: record.room,
			task: terminalSummary?.taskPreview ?? record.task,
			cwd: record.cwd,
			state: record.state,
			stateBeforeStop: record.stateBeforeStop,
			startedAt: record.startedAt,
			updatedAt: record.updatedAt,
			endedAt: record.endedAt,
			activeMs: record.activeMs,
			queuedMs: record.queuedMs,
			activeStartedAt: record.activeStartedAt,
			queuedStartedAt: record.queuedStartedAt,
			finalResult: terminal && !includeTerminalOutcome ? undefined : record.result,
			substantiveResponse: terminal && !includeTerminalOutcome ? undefined : record.substantiveResponse,
			lastResponse: terminal && !includeTerminalOutcome ? undefined : record.lastResponse,
			laterFailure: terminal && !includeTerminalOutcome ? undefined : record.laterFailure,
			log: terminal && !includeTerminalOutcome ? [] : record.log.map((entry) => ({ ...entry })),
			logFirstIndex: record.logFirstIndex,
			logCursor: record.logCursor,
			pendingQuestion: terminal && !includeTerminalOutcome ? undefined : record.pendingQuestion,
			lastProgress: record.lastProgress ? { ...record.lastProgress } : undefined,
			usage: record.usage ? { ...record.usage } : undefined,
			vendorSessionId: record.vendorSessionId,
			archived: record.archived,
			model: record.model,
			modelId: record.modelId,
			mode: record.mode,
			agentInfo: record.agentInfo,
			noteId: record.noteId,
			queuedBehind: record.queuedBehind,
			pendingBrief: [...record.pendingBrief],
			headAtStart: record.headAtStart,
			headlessReason: record.headlessReason,
			revivalCount: record.revivalCount,
			nativeAttached: record.nativeAttached,
		};
	}

	/** Wait until every checkpoint mutation scheduled before this call is durable. */
	async flushCheckpoint(): Promise<void> {
		await this.options.checkpoint?.writer.flush();
	}

	/** Phase 2 calls this only after stale worker process groups have been reaped. */
	releaseRecoveredWriterSlot(priorProcessesStopped: true): void {
		if (!priorProcessesStopped)
			throw new Error("Prior worker process death must be proven before releasing the writer slot.");
		if (!this.recoveryWriterSlotHeld) return;
		const at = Date.now();
		for (const workerId of this.writerQueue) this.writerQueueHistory.push({ workerId, action: "removed", at });
		this.writerQueue.length = 0;
		this.activeWriter = undefined;
		this.recoveryWriterSlotHeld = false;
		this.checkpointChanged();
	}

	// =========================================================================
	// Leader-facing API
	// =========================================================================

	/** Worker tiers this session may staff, in canonical order. */
	get sessionTiers(): Tier[] {
		return [...this.tiers];
	}

	/** True when this session was started with the full ladder. */
	get allTiersAvailable(): boolean {
		return this.tiers.length === TIERS.length;
	}

	/** Return a defensive copy of the current session goal. */
	goalSnapshot(): SessionGoal | undefined {
		return cloneGoal(this.goal);
	}

	private nextDiscoveryId(): string {
		const discoveries = this.goal?.discoveries ?? [];
		let number = discoveries.length + 1;
		while (discoveries.some((discovery) => discovery.id === `d${number}`)) number += 1;
		return `d${number}`;
	}

	private formatCompactGoal(goal: SessionGoal): string {
		const pending = goal.discoveries
			.filter((discovery) => discovery.impact === "goal" && discovery.status === "pending")
			.map((discovery) => discovery.id);
		return [
			"Current session goal:",
			`  immutable intent: ${goal.originalIntent}`,
			`  working objective: ${goal.workingObjective}`,
			`  revision: ${goal.revision} | discovery policy: ${goal.discoveryPolicy} | status: ${goal.status}`,
			`  pending goal discoveries: ${pending.length ? pending.join(", ") : "none"}`,
		].join("\n");
	}

	private goalPromptContext(): string | undefined {
		return this.goal ? this.formatCompactGoal(this.goal) : undefined;
	}

	private withGoalContext(message: string): string {
		const context = this.goalPromptContext();
		return context ? `${context}\n\n---\n\n# Leader instruction\n\n${message}` : message;
	}

	/** Initialize the write-once session intent. */
	initGoal(originalIntent: string): SessionGoal {
		if (this.goal) throw new Error("Session goal is already initialized; originalIntent is write-once.");
		const intent = requireGoalText(originalIntent, "originalIntent");
		const timestamp = Date.now();
		this.goal = {
			originalIntent: intent,
			workingObjective: intent,
			revision: 0,
			discoveryPolicy: "allowed",
			status: "active",
			revisions: [{ revision: 0, workingObjective: intent, reason: "initialized", evidenceRefs: [], timestamp }],
			discoveries: [],
		};
		this.checkpointChanged();
		return this.goalSnapshot() as SessionGoal;
	}

	private mutateGoal(
		input: GoalMutationInput | { expectedRevision?: number; reason?: string; evidenceRefs?: readonly string[] },
		reasonFallback: string,
		change: (goal: SessionGoal) => void,
	): SessionGoal {
		if (!this.goal) throw new Error("Session goal is not initialized.");
		if (this.goal.status !== "active")
			throw new Error(`Session goal is terminal (${this.goal.status}) and cannot be mutated.`);
		if (input.expectedRevision === undefined) throw new Error("expectedRevision is required.");
		requireExpectedRevision(input.expectedRevision);
		if (input.expectedRevision !== this.goal.revision)
			throw new Error(`Stale goal revision: expected ${input.expectedRevision}, current ${this.goal.revision}.`);
		const next = cloneGoal(this.goal) as SessionGoal;
		change(next);
		next.revision += 1;
		next.revisions.push({
			revision: next.revision,
			workingObjective: next.workingObjective,
			reason: input.reason?.trim() || reasonFallback,
			evidenceRefs: copyEvidenceRefs(input.evidenceRefs),
			timestamp: Date.now(),
		});
		this.goal = next;
		this.checkpointChanged();
		return this.goalSnapshot() as SessionGoal;
	}

	reviseGoal(input: GoalRevisionInput): SessionGoal {
		const objective = requireGoalText(input.workingObjective, "workingObjective");
		return this.mutateGoal(input, "objective revised", (goal) => {
			goal.workingObjective = objective;
		});
	}

	setDiscoveryPolicy(input: {
		expectedRevision: number;
		discoveryPolicy: "allowed" | "locked";
		reason?: string;
		evidenceRefs?: readonly string[];
	}): SessionGoal {
		return this.mutateGoal(input, `discovery policy set to ${input.discoveryPolicy}`, (goal) => {
			if (input.discoveryPolicy !== "allowed" && input.discoveryPolicy !== "locked")
				throw new Error("discoveryPolicy must be allowed or locked.");
			goal.discoveryPolicy = input.discoveryPolicy;
		});
	}

	recordDiscovery(input: GoalDiscoveryInput): SessionGoal {
		if (!this.goal) throw new Error("Session goal is not initialized.");
		if (this.goal.status !== "active")
			throw new Error(`Session goal is terminal (${this.goal.status}) and cannot be mutated.`);
		if (input.impact === "goal" && this.goal.discoveryPolicy === "locked")
			throw new Error("Discovery policy is locked; goal-impact discoveries are not accepted.");
		if (input.expectedRevision !== undefined) {
			requireExpectedRevision(input.expectedRevision);
			if (input.expectedRevision !== this.goal.revision)
				throw new Error(`Stale goal revision: expected ${input.expectedRevision}, current ${this.goal.revision}.`);
		}
		const id = requireGoalText(input.id, "discovery id");
		const finding = requireGoalText(input.finding, "finding");
		if (this.goal.discoveries.some((discovery) => discovery.id === id))
			throw new Error(`Discovery "${id}" already exists.`);
		if (input.impact !== "local" && input.impact !== "goal") throw new Error("impact must be local or goal.");
		const evidenceRefs = input.evidenceRefs === undefined ? undefined : copyEvidenceRefs(input.evidenceRefs);
		const next = cloneGoal(this.goal) as SessionGoal;
		const discovery: GoalDiscovery = {
			id,
			workerId: input.workerId,
			finding,
			impact: input.impact,
			suggestion: input.suggestion,
			evidenceRefs,
			status: input.impact === "local" ? "accepted" : "pending",
			createdAt: Date.now(),
			createdBy: input.createdBy,
		};
		next.discoveries.push(discovery);
		next.revision += 1;
		next.revisions.push({
			revision: next.revision,
			workingObjective: next.workingObjective,
			reason: `discovery recorded: ${id}`,
			evidenceRefs: evidenceRefs ? [...evidenceRefs] : [],
			timestamp: Date.now(),
		});
		this.goal = next;
		this.checkpointChanged();
		return this.goalSnapshot() as SessionGoal;
	}

	resolveDiscovery(input: GoalResolutionInput): SessionGoal {
		if (input.resolution !== "accept" && input.resolution !== "reject")
			throw new Error("resolution must be accept or reject.");
		return this.mutateGoal(input, `discovery ${input.resolution}ed`, (goal) => {
			const discovery = goal.discoveries.find((candidate) => candidate.id === input.discoveryId);
			if (!discovery) throw new Error(`Discovery "${input.discoveryId}" does not exist.`);
			if (discovery.status !== "pending")
				throw new Error(`Discovery "${input.discoveryId}" is already ${discovery.status}.`);
			discovery.status = input.resolution === "accept" ? "accepted" : "rejected";
			discovery.resolvedAt = Date.now();
			discovery.resolvedBy = "leader";
			discovery.resolutionReason = input.reason?.trim() || undefined;
		});
	}

	completeGoal(input: GoalCompletionInput): SessionGoal {
		const pending =
			this.goal?.discoveries.filter((discovery) => discovery.impact === "goal" && discovery.status === "pending") ??
			[];
		if (pending.length > 0 && input.override !== true)
			throw new Error(
				`Cannot complete session goal with pending goal discoveries: ${pending.map((discovery) => discovery.id).join(", ")}.`,
			);
		if (pending.length > 0 && !input.reason?.trim())
			throw new Error("Completing with pending goal discoveries requires a non-empty reason and override=true.");
		return this.mutateGoal(input, "goal completed", (goal) => {
			goal.status = "complete";
		});
	}

	stopGoal(input: GoalMutationInput): SessionGoal {
		return this.mutateGoal(input, "goal stopped", (goal) => {
			goal.status = "stopped";
		});
	}

	/**
	 * The one gate on tier availability.
	 *
	 * Every door into spawning — the leader's MCP tool, the group tool, the Unix
	 * socket, the `neta` CLI — ends up in `spawn`, and `spawn` calls this before
	 * it touches anything. Restricting the tool schema and the prompt is how the
	 * leader learns which tiers exist; this is what makes it true. A schema is a
	 * hint a caller can ignore, and the socket door never sees the schema at all.
	 */
	assertTierAvailable(tier: Tier): void {
		if (this.tiers.includes(tier)) return;
		const missing = TIERS.filter((candidate) => !this.tiers.includes(candidate));
		throw new Error(
			`Tier "${tier}" is not available in this session. Available: ${this.tiers.join(", ")}` +
				`${missing.length > 0 ? ` (not selected at startup: ${missing.join(", ")})` : ""}. ` +
				`Restaff this work on an available tier, or start a new session and select it.`,
		);
	}

	/**
	 * Check a whole batch before any of it happens.
	 *
	 * A batch that validated per member would seed the team and start the
	 * first two workers before refusing the third, leaving the leader to clean up
	 * a half-built room. Reporting every unavailable tier at once also beats
	 * making the leader discover them one spawn at a time.
	 */
	assertTiersAvailable(tiers: readonly Tier[]): void {
		const unavailable = [...new Set(tiers)].filter((tier) => !this.tiers.includes(tier));
		if (unavailable.length === 0) return;
		this.assertTierAvailable(unavailable[0]);
	}

	/** Validate a complete delegate batch without mutating assignment cursors or session state. */
	validateDelegation(requests: readonly SpawnRequest[]): void {
		this.assertTiersAvailable(requests.map((request) => request.tier));
		for (const request of requests) {
			if (!loadRoleText(request.role, this.options.cwd, this.options.agentDir)) {
				throw new Error(`Unknown role "${request.role}". Available roles: ${roleNames().join(", ")}.`);
			}
			if (request.note && !this.notes.has(request.note)) throw new Error(`Unknown note id "${request.note}".`);
		}
		const assignments = this.planAssignments([...requests]);
		for (const [index, assignment] of assignments.entries()) {
			const backend = this.options.config.resolve(assignment.tier, assignment.backend, assignment.writer);
			assertClaudeModelAllowed(backend.claudeLineage, backend.model, `delegate ${assignment.tier} assignment`);
			if (requests[index].writer && this.recoveryWriterSlotHeld) {
				throw new Error("Recovered writer slot is held until prior worker process death is proven.");
			}
		}
	}

	async spawn(request: SpawnRequest): Promise<WorkerSummary> {
		// First, before the writer-slot reservation, the batch archive sweep, the
		// worker counter, or the scratch directory: a refused spawn must leave the
		// session exactly as it found it.
		this.assertTierAvailable(request.tier);
		const writer = request.writer ?? false;
		if (writer && this.recoveryWriterSlotHeld) {
			throw new Error("Recovered writer slot is held until prior worker process death is proven.");
		}

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
		const backendName = this.computeBackendAssignment(request, {
			cursors: this.spreadCursors,
			lastWriterBackend: this.lastWriterBackend,
			roomDebaterBackends: this.roomDebaterBackends,
		});
		const backend = this.options.config.resolve(request.tier, backendName, writer);
		assertClaudeModelAllowed(backend.claudeLineage, backend.model, `runtime ${request.tier} assignment`);
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
		// Archive only after assignment, backend policy, environment preparation,
		// and scratch-directory startup validation all succeeded. Each terminal
		// record is persisted as a worker delta even though its hot state is evicted.
		const existing = [...this.workers.values()];
		if (existing.length > 0 && existing.every((record) => isTerminalState(record.state))) {
			for (const record of existing) {
				record.archived = true;
				record.updatedAt = Date.now();
				this.checkpointChanged(record, "immediate", "worker");
			}
			// Room views close with the batch they belonged to; a room joined again
			// later gets a fresh pane.
			this.roomPanesOpened.clear();
		}
		const shouldQueue = writer && this.activeWriter !== id;
		if (writer && !this.activeWriter) this.activeWriter = id;
		const recordNow = this.now();

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
			cwd: this.options.cwd,
			state: shouldQueue ? "queued" : "starting",
			startedAt: recordNow,
			updatedAt: recordNow,
			scratchDir,
			channelToken: randomBytes(16).toString("hex"),
			log: [],
			logFirstIndex: 0,
			logCursor: 0,
			queue: Promise.resolve(),
			queuedPrompts: 0,
			turnCounter: 0,
			steeredTurns: new Set<number>(),
			interruptedTurns: new Set<number>(),
			cancelDispatches: new Map<number, Promise<boolean>>(),
			waiters: [],
			driver: undefined as unknown as WorkerTransportDriver,
			noteId: request.note,
			pendingBrief: [],
			pendingBriefLeaderMessages: [],
			revivalCount: 0,
			activeMs: 0,
			queuedMs: 0,
			...(shouldQueue ? { queuedStartedAt: recordNow } : { activeStartedAt: recordNow }),
		};

		this.workers.set(id, record);
		this.checkpointChanged(record);
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
			this.writerQueueHistory.push({ workerId: id, action: "queued", at: recordNow });
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
			for (const message of record.pendingBriefLeaderMessages) {
				this.appendLog(
					record,
					"error",
					`Leader message was not delivered because the worker failed to start: ${message}`,
				);
			}
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
		const goalContext = this.goalPromptContext();
		const assignedTask = goalContext ? `${goalContext}\n\n---\n\n# Assigned task\n\n${request.task}` : request.task;
		const task = writerContext ? `${writerContext}\n\n---\n\n${assignedTask}` : assignedTask;
		const firstPrompt = this.withPendingBrief(record, task);
		this.enqueue(record, firstPrompt.message, false, firstPrompt.leaderMessages);
		await this.openWorkerView(record);
		this.checkpointChanged();
		return this.summarize(record);
	}

	/**
	 * Steer a running worker: end its current turn now and make this message its
	 * next prompt, in the same session.
	 *
	 * ACP gives no way to inject text into a running prompt turn — `session/prompt`
	 * owns the turn until it resolves, and there is no "append to the turn"
	 * request in 1.3.0. Cancel-then-prompt is the protocol's supported equivalent
	 * and the strongest steering primitive available: the session, its history,
	 * its model selection and its writer slot all survive, and only the turn ends.
	 *
	 * What it cannot do is undo work. Tool calls the worker already completed —
	 * files written, commands run — stay done, which is why the result says the
	 * turn was interrupted rather than that nothing happened.
	 *
	 * The returned delivery is what actually happened, established by watching the
	 * queue rather than assumed: the message is only reported as delivered once it
	 * has been handed to the backend.
	 */
	async steer(workerId: string, message: string, options: { timeoutMs?: number } = {}): Promise<SteerResult> {
		const record = this.require(workerId);
		message = this.withGoalContext(message);
		if (record.state === "killed" || record.state === "interrupted") {
			throw new Error(
				`Worker ${workerId} is ${record.state}; its conversation cannot be resumed safely. Inspect/attach it or delegate a fresh worker.`,
			);
		}
		if (record.state === "blocked" || record.state === "done" || record.state === "failed") {
			return this.revive(record, message);
		}
		this.assertSendable(record, workerId);

		// Not started yet: a follow-up must not become prompt one and displace the
		// task to prompt two. It rides with the brief instead, and no turn exists
		// to interrupt.
		if (record.state === "queued" || record.state === "starting") {
			this.send(workerId, message);
			return { worker: this.summarize(record), delivery: "pending-brief" };
		}

		// The exact turn this steer is aimed at, captured before anything is
		// queued. `session/cancel` names a session, not a turn, so the accounting
		// has to: if the turn we meant to stop ends on its own and the next one
		// begins before our notification reaches the agent, the cancel lands on a
		// turn nobody aimed at, and must not be booked as this steer's success.
		const targetTurn = record.promptInFlight === true ? record.currentTurn : undefined;
		let resolveDelivered: () => void = () => {};
		const delivered = new Promise<void>((resolve) => {
			resolveDelivered = resolve;
		});
		let releaseBoundary: (safe: boolean) => void = () => {};
		const cancelBoundary = new Promise<boolean>((resolve) => {
			releaseBoundary = resolve;
		});
		// Queued before the cancel, deliberately. The in-flight turn checks the
		// queue depth when it ends, and finding this message there is what stops it
		// from finishing the worker — so if the cancel and a natural end race, the
		// worker survives either way.
		if (
			!this.enqueue(record, message, false, [message], resolveDelivered, async () => {
				// If the old turn ends while its cancel notification is still being
				// written, hold this prompt at the boundary. A session-wide cancel must
				// never be able to overtake and hit the instruction it was meant to
				// deliver.
				return cancelBoundary;
			})
		) {
			throw new Error(`Worker ${workerId} is finishing. Spawn a new worker instead.`);
		}
		this.appendLog(record, "status", `Leader queued for next turn: ${message}`);
		this.checkpointChanged(record);

		const timeoutMs = options.timeoutMs ?? this.options.steerTimeoutMs ?? STEER_TIMEOUT_MS;
		const deadline = Date.now() + timeoutMs;

		const queued = (note?: string): SteerResult => ({
			worker: this.summarize(record),
			delivery: "next-turn",
			note,
		});

		if (targetTurn === undefined) {
			releaseBoundary(true);
			// No turn to interrupt, so this is an ordinary next-turn delivery. It is
			// still only reported as delivered once the backend has taken it.
			return (await this.settle(delivered, Math.max(0, deadline - Date.now())))
				? queued()
				: {
						worker: this.summarize(record),
						delivery: "cancel-pending",
						note: `${workerId} has not taken the message yet; it is first in that worker's queue.`,
					};
		}

		record.steeredTurns.add(targetTurn);
		const cancelDispatch = this.cancelTurn(record, targetTurn);
		const dispatch = await this.settleResult(cancelDispatch, Math.max(0, deadline - Date.now()));
		if (dispatch.status === "timeout" || dispatch.status === "rejected") {
			record.steeredTurns.delete(targetTurn);
			releaseBoundary(false);
			const reason =
				dispatch.status === "timeout"
					? `cancel dispatch did not finish within ${timeoutMs}ms`
					: `cancel dispatch failed (${dispatch.error instanceof Error ? dispatch.error.message : String(dispatch.error)})`;
			record.unsafeToPrompt = reason;
			this.appendLog(
				record,
				"error",
				`Steering failed: ${reason}. The message was not delivered; kill and respawn this worker before sending more.`,
			);
			this.checkpointChanged(record);
			return {
				worker: this.summarize(record),
				delivery: "cancel-failed",
				note: `${workerId}'s session is unsafe for later prompts because a late session-wide cancel could hit them. Kill and respawn it.`,
			};
		}
		const asked = dispatch.value;
		if (!asked) {
			record.steeredTurns.delete(targetTurn);
			releaseBoundary(true);
			return queued(`${workerId} had no live session to interrupt; the message is queued for its next turn.`);
		}
		releaseBoundary(true);

		const arrived = await this.settle(delivered, Math.max(0, deadline - Date.now()));
		if (!arrived) {
			// Nothing is lost: the message is still first in the queue. But the
			// worker has not seen it, and saying otherwise would be a lie the leader
			// would act on.
			return {
				worker: this.summarize(record),
				delivery: "cancel-pending",
				note: `${workerId} has not taken the message yet; it is first in that worker's queue.`,
			};
		}
		// True only if the turn this steer aimed at is the one that came back
		// cancelled — not merely that some turn did.
		const interrupted = record.interruptedTurns.has(targetTurn);
		if (!interrupted) this.appendLog(record, "status", "The prior turn ended before the interrupt landed.");
		return {
			worker: this.summarize(record),
			delivery: interrupted ? "interrupted" : "turn-ended",
			note: interrupted
				? "Tool calls that worker had already completed were not undone."
				: "That turn had already ended before the interrupt landed, so nothing was cut short.",
		};
	}

	/** Resume a terminal worker in a fresh ACP process without creating a new conversation. */
	private async revive(record: WorkerRecord, message: string): Promise<SteerResult> {
		if (record.finishing) await record.finishing;
		record.finishing = undefined;
		if (record.reviving) throw new Error(`Worker ${record.id} is already being resumed.`);
		if (record.nativeAttached) {
			throw new Error(
				`Worker ${record.id} was opened in a native client; exclusive ownership of its session cannot be proven. Close it and delegate a fresh worker.`,
			);
		}
		if (!record.vendorSessionId) {
			throw new Error(`Worker ${record.id} has no recorded vendor session id; delegate a fresh worker.`);
		}
		if (record.writer && this.activeWriter && this.activeWriter !== record.id) {
			record.revivalFromState = record.state as "blocked" | "done" | "failed";
			record.revivalPreviousQueuedBehind = record.queuedBehind;
			record.revivalMessage = message;
			record.state = "queued";
			record.activeStartedAt = undefined;
			const queuedAt = this.now();
			record.queuedStartedAt = queuedAt;
			record.queuedBehind = this.activeWriter;
			this.writerQueue.push(record.id);
			this.writerQueueHistory.push({ workerId: record.id, action: "queued", at: queuedAt });
			this.appendLog(
				record,
				"status",
				`Resume queued behind ${this.activeWriter}; the original task will not rerun.`,
			);
			this.checkpointChanged(record);
			return {
				worker: this.summarize(record),
				delivery: "pending-brief",
				note: "Exact-session resume is queued for the writer slot.",
			};
		}

		const revival = this.resumeRecord(record, message);
		record.reviving = revival;
		try {
			return await revival;
		} finally {
			record.reviving = undefined;
		}
	}

	private async resumeRecord(record: WorkerRecord, message: string): Promise<SteerResult> {
		this.beginActive(record);
		const priorState = record.revivalFromState ?? (record.state as "blocked" | "done" | "failed");
		const prior = {
			state: priorState,
			endedAt: record.endedAt,
			result: record.result,
			pendingQuestion: record.pendingQuestion,
			archived: record.archived,
			unsafeToPrompt: record.unsafeToPrompt,
			queuedBehind: record.revivalPreviousQueuedBehind,
		};
		const reservedWriter = record.writer && !this.activeWriter;
		if (reservedWriter) this.activeWriter = record.id;
		try {
			record.scratchDir ??= await mkdtemp(join(tmpdir(), `neta-${record.id}-resume-`));
			record.channelToken ??= randomBytes(16).toString("hex");
			const configuredBackend = this.options.config.resolve(record.tier, record.backend, record.writer);
			const backend = { ...configuredBackend, model: record.modelId ?? configuredBackend.model };
			assertClaudeModelAllowed(backend.claudeLineage, backend.model, `resume ${record.tier} assignment`);
			const runtimeEnv = (await this.options.prepareEnv?.()) ?? {};
			const roleText = loadRoleText(record.role, record.cwd, this.options.agentDir);
			if (!roleText) throw new Error(`Unknown role "${record.role}".`);
			const systemPrompt = [
				roleText.trim(),
				"",
				workingAgreement({ tier: record.tier, writer: record.writer, room: record.room, binary: APP_NAME }),
				"",
				`Your scratch directory (outside the repository) is ${record.scratchDir}. Use it for notes and throwaway files.`,
			].join("\n");
			record.driver = this.createWorkerTransport(record, backend, runtimeEnv, systemPrompt, record.vendorSessionId);
			await record.driver.start();
			// A successful revival returns this record to live state. The old bounded
			// terminal summary must not mask its new active interval in public views.
			record.terminalSummary = undefined;
		} catch (error) {
			this.freezeTiming(record);
			await record.driver?.kill().catch(() => {});
			if (record.processGroupId !== undefined) {
				this.options.onWorkerProcessGroup?.(record.id, undefined);
				record.processGroupId = undefined;
			}
			record.driver = undefined;
			record.state = prior.state;
			record.endedAt = prior.endedAt;
			record.result = prior.result;
			record.pendingQuestion = prior.pendingQuestion;
			record.archived = prior.archived;
			record.unsafeToPrompt = prior.unsafeToPrompt;
			record.queuedBehind = prior.queuedBehind;
			record.revivalFromState = undefined;
			record.revivalPreviousQueuedBehind = undefined;
			record.revivalMessage = undefined;
			if (reservedWriter && this.activeWriter === record.id) {
				this.activeWriter = undefined;
				void this.dequeueNextWriter();
			}
			this.checkpointChanged(record);
			throw error;
		}

		record.finishing = undefined;
		record.killReason = undefined;
		record.endedAt = undefined;
		record.archived = false;
		record.unsafeToPrompt = undefined;
		record.pendingQuestion = undefined;
		record.pendingDiscoveryId = undefined;
		record.blockedTurn = undefined;
		record.revivalFromState = undefined;
		record.revivalPreviousQueuedBehind = undefined;
		record.revivalMessage = undefined;
		record.queuedBehind = undefined;
		record.revivalCount += 1;
		record.headlessReason = "resumed headlessly in a fresh ACP process";
		record.queue = Promise.resolve();
		record.queuedPrompts = 0;
		this.setState(record, "running");
		this.appendLog(
			record,
			"status",
			`Resumed exact session ${record.vendorSessionId} (revival ${record.revivalCount}).`,
		);
		if (record.writer) this.notifyReadOnlyWorkers(record, "started");
		const resumedPrompt = this.withPendingBrief(record, message);
		if (!this.enqueue(record, resumedPrompt.message, false, [message, ...resumedPrompt.leaderMessages]))
			throw new Error(`Worker ${record.id} could not accept resumed prompt.`);
		return {
			worker: this.summarize(record),
			delivery: "next-turn",
			note: "Resumed the exact recorded ACP conversation headlessly.",
		};
	}

	/** Dispatch at most one session-wide cancel for a particular prompt turn. */
	private cancelTurn(record: WorkerRecord, turn: number): Promise<boolean> {
		const existing = record.cancelDispatches.get(turn);
		if (existing) return existing;
		const dispatch = Promise.resolve().then(() => record.driver?.cancel() ?? false);
		record.cancelDispatches.set(turn, dispatch);
		return dispatch;
	}

	/** Resolve true if the promise settles first, false if the deadline wins. */
	private settle(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			void promise.then(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	/** Settle one value within a deadline while consuming late resolve/reject paths. */
	private settleResult<T>(
		promise: Promise<T>,
		timeoutMs: number,
	): Promise<{ status: "resolved"; value: T } | { status: "rejected"; error: unknown } | { status: "timeout" }> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
			void promise.then(
				(value) => {
					clearTimeout(timer);
					resolve({ status: "resolved", value });
				},
				(error: unknown) => {
					clearTimeout(timer);
					resolve({ status: "rejected", error });
				},
			);
		});
	}

	private assertSendable(record: WorkerRecord, workerId: string): void {
		if (isTerminalState(record.state)) {
			throw new Error(`Worker ${workerId} already finished (${record.state}). Spawn a new worker instead.`);
		}
		if (record.finishing) {
			throw new Error(`Worker ${workerId} is finishing. Spawn a new worker instead.`);
		}
		if (record.unsafeToPrompt) {
			throw new Error(
				`Worker ${workerId} cannot accept another prompt: ${record.unsafeToPrompt}. Kill and respawn it.`,
			);
		}
	}

	/**
	 * Queue a message as the worker's next turn, without interrupting anything.
	 *
	 * This is the pane's path and the path for Neta's own automatic notices. The
	 * leader steers instead; see `steer`.
	 */
	send(workerId: string, message: string): WorkerSummary {
		const record = this.require(workerId);
		this.assertSendable(record, workerId);
		if (record.state === "queued" || record.state === "starting") {
			// A transport in "starting" has not received its real brief yet. Hold
			// pane/leader input behind that brief just like a queued writer, or the
			// follow-up can become prompt one and displace the task to prompt two.
			record.pendingBrief.push(message);
			record.pendingBriefLeaderMessages.push(message);
			this.appendLog(record, "status", `Leader queued for next turn: ${message}`);
		} else {
			if (!this.enqueue(record, message, false, [message])) {
				throw new Error(`Worker ${workerId} is finishing. Spawn a new worker instead.`);
			}
			this.appendLog(record, "status", `Leader queued for next turn: ${message}`);
		}
		this.checkpointChanged(record);
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
				if (index >= 0) {
					this.writerQueue.splice(index, 1);
					this.writerQueueHistory.push({ workerId, action: "removed", at: this.now() });
				}
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
		const record = this.require(workerId);
		this.loadTerminalOutcome(record);
		const summary = this.summarize(record);
		this.releaseTerminalOutcome(record);
		return summary;
	}

	private loadTerminalOutcome(record: WorkerRecord): void {
		if (!isTerminalState(record.state) || record.terminalOutcomeLoaded) return;
		record.terminalOutcomeLoaded = true;
		const reference = this.terminalRefs.get(record.id);
		if (!reference || !this.options.checkpointStorePath) return;
		const outcome = readV6WorkerOutcome(
			this.options.checkpointStorePath,
			reference,
			this.options.checkpointReadCounters,
		);
		if (typeof outcome.task === "string") record.task = outcome.task;
		if (typeof outcome.finalResult === "string") record.result = outcome.finalResult;
		if (typeof outcome.substantiveResponse === "string") record.substantiveResponse = outcome.substantiveResponse;
		if (typeof outcome.lastResponse === "string") record.lastResponse = outcome.lastResponse;
		if (typeof outcome.laterFailure === "string") record.laterFailure = outcome.laterFailure;
		if (typeof outcome.pendingQuestion === "string") record.pendingQuestion = outcome.pendingQuestion;
	}

	private evictTerminalRecord(record: WorkerRecord, summary: TerminalHotSummary): void {
		record.terminalSummary = summary;
		record.task = summary.taskPreview;
		record.result = undefined;
		record.substantiveResponse = undefined;
		record.lastResponse = undefined;
		record.laterFailure = undefined;
		record.pendingQuestion = undefined;
		record.lastProgress = summary.lastProgress;
		const retainedLogEntries = record.log.length;
		record.log = [];
		record.logFirstIndex += retainedLogEntries;
		record.logCursor = record.logFirstIndex;
		record.driver = undefined;
		record.processGroupId = undefined;
		record.channelToken = undefined;
		record.scratchDir = undefined;
		record.queue = Promise.resolve();
		record.pendingBrief = [];
		record.pendingBriefLeaderMessages = [];
		record.steeredTurns.clear();
		record.interruptedTurns.clear();
		record.cancelDispatches.clear();
		record.killReason = undefined;
		record.unsafeToPrompt = undefined;
		record.revivalMessage = undefined;
		record.revivalFromState = undefined;
		record.revivalPreviousQueuedBehind = undefined;
		record.terminalOutcomeLoaded = false;
	}

	/** Test-facing proof that terminal hot state is bounded without exposing records. */
	terminalHotStateBytes(workerId: string): number {
		const record = this.require(workerId);
		return record.terminalSummary ? Buffer.byteLength(JSON.stringify(record.terminalSummary), "utf8") : 0;
	}

	/** Test-facing count of evicted terminal records. */
	terminalHotStateCount(): number {
		return [...this.workers.values()].filter((record) => record.terminalSummary !== undefined).length;
	}

	private releaseTerminalOutcome(record: WorkerRecord): void {
		const summary = record.terminalSummary;
		if (!summary || !record.terminalOutcomeLoaded) return;
		record.task = summary.taskPreview;
		record.result = summary.resultPreview;
		record.substantiveResponse = undefined;
		record.lastResponse = undefined;
		record.laterFailure = summary.laterFailurePreview;
		record.pendingQuestion = summary.pendingQuestionPreview;
		record.lastProgress = summary.lastProgress;
		record.terminalOutcomeLoaded = false;
	}

	private loadTerminalDetails(record: WorkerRecord): WorkerLogEntry[] {
		const reference = this.terminalRefs.get(record.id);
		if (!reference || !this.options.checkpointStorePath) return [];
		try {
			const terminal = reference.terminalDetailSegments.length > 0;
			return readV6WorkerDetails(
				this.options.checkpointStorePath,
				reference,
				this.options.checkpointReadCounters,
				terminal,
			) as WorkerLogEntry[];
		} catch {
			// Terminal detail is optional by contract; summary/result remain usable.
			return [];
		}
	}

	/** Open a fresh native backend TUI without changing any worker lifecycle state. */
	async reopenWorkerTui(workerId: string): Promise<WorkerSummary> {
		const record = this.require(workerId);
		if (record.state === "queued") {
			throw new Error(`Worker ${workerId} is queued and has not started; there is no backend session to attach.`);
		}
		if (!isTerminalState(record.state)) {
			throw new Error(
				`Worker ${workerId} is still active (${record.state}); refusing to open a second client on the same session.`,
			);
		}
		if (record.nativeAttached && !this.nativeAttachmentsOpened.has(workerId)) {
			throw new Error(
				`Worker ${workerId} was opened in a native client; exclusive ownership of its session cannot be proven. Close it and delegate a fresh worker.`,
			);
		}
		const summary = this.summarize(record);
		// A worker with no tab is exactly the case a reader most needs a way into,
		// so none of these refusals is a dead end: each one names what still works
		// without a multiplexer.
		let resume: { command: string; args: string[] };
		try {
			resume = workerResumeCommand(this.options.config, summary);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)} ` +
					`Read it in place with \`${APP_NAME} inspect ${workerId}\` instead.`,
			);
		}
		if (!this.options.panes?.attach) {
			throw new Error(
				`Cannot open ${workerId}: this Neta session has no live pane host ` +
					`(${record.headlessReason ?? this.options.headlessReason ?? "headless mode"}). ` +
					`${this.headlessAlternatives(workerId)}`,
			);
		}
		const outcome = await this.options.panes.attach(summary, resume);
		if (!outcome.opened) {
			throw new Error(
				`Could not open ${workerId}'s native TUI: ${outcome.reason}. ${this.headlessAlternatives(workerId)}`,
			);
		}
		record.nativeAttached = true;
		this.nativeAttachmentsOpened.add(workerId);
		this.checkpointChanged(record, "immediate", "worker");
		return summary;
	}

	/** What still works when there is no multiplexer tab to open. */
	private headlessAlternatives(workerId: string): string {
		return (
			`Read it in place with \`${APP_NAME} inspect ${workerId}\` (bounded recent input and output), ` +
			`or take over a terminal with \`${APP_NAME} attach ${workerId}\`.`
		);
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
			goal: cloneGoal(this.goal),
		};
	}

	/** Render the shared status snapshot for the socket channel. */
	status(): string {
		return formatStatusSnapshot(this.statusSnapshot(), this.now());
	}

	/** Writers-only status available to read-only workers through their channel. */
	writerStatus(workerId: string): ChannelResponse {
		this.require(workerId);
		return { ok: true, text: formatWriterStatus(this.statusSnapshot(), this.now()) };
	}

	/** Compact goal status available to workers without exposing goal history. */
	goalStatus(workerId: string): ChannelResponse {
		this.require(workerId);
		const goal = this.goal;
		if (!goal) return { ok: true, text: "No session goal initialized." };
		return { ok: true, text: this.formatCompactGoal(goal) };
	}

	/** Record a worker discovery and, for goal impact, stop the active ACP turn. */
	discover(
		workerId: string,
		impact: "local" | "goal",
		finding: string,
		suggestion: string | undefined,
	): ChannelResponse {
		const record = this.workers.get(workerId);
		if (!record) return { ok: false, error: `Unknown worker ${workerId}.` };
		if (!this.goal) return { ok: false, error: "No session goal initialized; initialize one with neta_goal first." };
		if (impact === "goal" && this.goal.discoveryPolicy === "locked") {
			return { ok: false, error: "Discovery policy is locked; goal-impact discoveries are not accepted." };
		}
		if (!record.promptInFlight || record.currentTurn === undefined) {
			return { ok: false, error: "neta_discover must be called from the worker's active ACP turn." };
		}
		const goal = this.recordDiscovery({
			id: this.nextDiscoveryId(),
			workerId,
			finding,
			impact,
			suggestion,
			createdBy: workerId,
		});
		const discovery = goal.discoveries[goal.discoveries.length - 1];
		if (!discovery) return { ok: false, error: "Discovery was not recorded." };
		if (impact === "local") {
			return {
				ok: true,
				text: `Discovery ${discovery.id} recorded at goal revision ${goal.revision}; continue this turn.`,
				data: { discoveryId: discovery.id, revision: goal.revision },
			};
		}

		const turn = record.currentTurn;
		record.pendingDiscoveryId = discovery.id;
		record.pendingQuestion = `Goal-impact discovery ${discovery.id} requires leader resolution: ${discovery.finding}`;
		record.blockedTurn = turn;
		this.appendLog(record, "status", `Discovery ${discovery.id} requires leader resolution: ${discovery.finding}`);
		this.checkpointChanged(record);
		queueMicrotask(() => {
			void (async () => {
				try {
					await this.cancelTurn(record, turn);
				} catch (error) {
					this.appendLog(
						record,
						"error",
						`Could not cancel discovery turn: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				await this.settle(record.queue, 1_000);
				if (record.blockedTurn === turn && !isTerminalState(record.state) && !record.finishing) {
					await this.finish(
						record,
						"blocked",
						record.pendingQuestion ?? "Goal-impact discovery needs resolution.",
					);
				}
			})();
		});
		return {
			ok: true,
			text: `Discovery ${discovery.id} recorded at goal revision ${goal.revision}; this turn will stop for leader resolution.`,
			data: { discoveryId: discovery.id, revision: goal.revision },
		};
	}

	/** New log lines since the last drain, oldest first. */
	drainLog(workerId: string): WorkerLogEntry[] {
		const record = this.require(workerId);
		const from = Math.max(record.logCursor, record.logFirstIndex);
		const entries = record.log.slice(from - record.logFirstIndex);
		record.logCursor = record.logFirstIndex + record.log.length;
		this.checkpointChanged(record, "deferred", "worker");
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

	/**
	 * A bounded window onto one worker's recent input and output.
	 *
	 * The expand-in-place path for a worker row, and the only one that works when
	 * a worker has no pane — a multiplexer that refused to open a tab, or a
	 * session running headless on purpose. It reads through the same
	 * non-consuming view the pane watcher uses, so looking never steals lines the
	 * leader has not seen, and it is capped hard rather than by the caller's
	 * discretion: an uncapped dump of a chatty worker is what buries a leader's
	 * context, and a terminal row that expands to ten thousand lines is not an
	 * expansion, it is a different problem.
	 */
	inspect(workerId: string, options: { maxEntries?: number; maxChars?: number } = {}): WorkerInspection {
		const record = this.require(workerId);
		this.loadTerminalOutcome(record);
		const maxEntries = Math.max(1, Math.min(options.maxEntries ?? INSPECT_MAX_ENTRIES, INSPECT_MAX_ENTRIES));
		const maxChars = Math.max(80, Math.min(options.maxChars ?? INSPECT_MAX_CHARS, INSPECT_MAX_CHARS));

		const all =
			isTerminalState(record.state) && record.log.length === 0 ? this.loadTerminalDetails(record) : record.log;
		const shown = all.slice(Math.max(0, all.length - maxEntries));
		// Trimmed history counts too: a worker whose oldest lines have already
		// aged out of the retained log has more missing than this slice dropped.
		const droppedEntries = all.length - shown.length + record.logFirstIndex;

		// The character budget is spent newest-first, so the tail of the
		// conversation — the part a reader opened this for — survives intact.
		let remaining = maxChars;
		let droppedChars = 0;
		const kept: WorkerLogEntry[] = [];
		for (let index = shown.length - 1; index >= 0; index--) {
			const entry = shown[index];
			if (remaining <= 0) {
				droppedChars += entry.text.length;
				continue;
			}
			if (entry.text.length <= remaining) {
				remaining -= entry.text.length;
				kept.push(entry);
				continue;
			}
			// This is a recent window, including within one large entry. Keep its
			// tail rather than showing the beginning and silently dropping the newest
			// text the worker produced.
			const clipped = entry.text.slice(-remaining);
			droppedChars += entry.text.length - remaining;
			remaining = 0;
			kept.push({ ...entry, text: clipped });
		}
		kept.reverse();

		const inspection = {
			worker: this.summarize(record),
			entries: kept,
			droppedEntries: droppedEntries + (kept.length < shown.length ? shown.length - kept.length : 0),
			droppedChars,
			headlessReason: record.headlessReason ?? this.options.headlessReason,
		};
		this.releaseTerminalOutcome(record);
		return inspection;
	}

	roomTranscript(room: string, tail?: number): RoomPost[] {
		const posts = this.rooms.get(room) ?? [];
		return tail && tail > 0 ? posts.slice(-tail) : posts;
	}

	/**
	 * A room's posts after `since`, for the room watch view. Like tailLog,
	 * reading never consumes: members and leader still see the whole transcript.
	 */
	tailRoom(room: string, since = 0): RoomLogPage {
		const posts = this.rooms.get(room);
		if (!posts) {
			const known = [...this.rooms.keys()].join(", ") || "none";
			throw new Error(`Unknown room "${room}". Rooms: ${known}.`);
		}
		const members = [...this.workers.values()].filter((record) => record.room === room);
		return {
			posts: posts.slice(Math.max(0, since)),
			cursor: posts.length,
			members: members.map((record) => this.summarize(record)),
			done: members.length > 0 && members.every((record) => isTerminalState(record.state)),
			archived: members.length > 0 && members.every((record) => record.archived === true),
		};
	}

	postToRoom(room: string, from: string, label: string, text: string): void {
		this.ensureRoom(room).push({ at: Date.now(), from, label, text });
		this.checkpointChanged();
		for (const watcher of [...(this.roomWatchers.get(room) ?? [])]) watcher();
	}

	/**
	 * Block until the watched workers need the leader: all of them terminal (or
	 * the first one, in first mode), one of them blocking on a question, a new
	 * post in a watched room, or the timeout. A pending blocker always wakes
	 * the wait. A condition already true at call time returns immediately.
	 */
	async wait(workerIds: string[], timeoutMs: number, options: WaitOptions = {}): Promise<WaitResult> {
		const records = workerIds.map((id) => this.require(id));
		const rooms = [...new Set(options.rooms ?? [])];
		const roomCursors = new Map(rooms.map((room) => [room, (this.rooms.get(room) ?? []).length]));

		const snapshot = (
			reason: WaitResult["reason"],
			wokeBy?: WorkerRecord,
			roomActivity?: WaitResult["roomActivity"],
			discovery?: GoalDiscovery,
		): WaitResult => {
			for (const record of records) {
				if (isTerminalState(record.state)) this.loadTerminalOutcome(record);
			}
			if (wokeBy && isTerminalState(wokeBy.state)) this.loadTerminalOutcome(wokeBy);
			const result = {
				reason,
				workers: records.map((record) => this.summarize(record)),
				wokeBy: wokeBy ? this.summarize(wokeBy) : undefined,
				roomActivity,
				discovery,
			};
			for (const record of records) this.releaseTerminalOutcome(record);
			if (wokeBy && !records.includes(wokeBy)) this.releaseTerminalOutcome(wokeBy);
			return result;
		};

		const evaluate = (): WaitResult | undefined => {
			const discoveryWorker = records.find(
				(record) => record.state === "blocked" && record.pendingDiscoveryId !== undefined,
			);
			if (discoveryWorker) {
				const discovery = this.goal?.discoveries.find(
					(candidate) => candidate.id === discoveryWorker.pendingDiscoveryId,
				);
				if (discovery) return snapshot("discovery", discoveryWorker, undefined, discovery);
			}
			const blocked = records.find((record) => record.state === "blocked" && record.pendingQuestion);
			if (blocked) return snapshot("blocked", blocked);
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

	/** Run one caller-specified command without delegating an agent. Unrestricted; only its output is bounded. */
	async exec(request: RepoExecRequest): Promise<RepoExecResult> {
		if (this.disposed) throw new Error("This Neta session is shutting down.");
		if (!this.options.execOutputDir) throw new Error("neta_exec has no session audit directory.");
		const controller = new AbortController();
		this.execControllers.add(controller);
		const execution = executeRepoCommand(
			this.options.cwd,
			this.options.execOutputDir,
			request,
			controller.signal,
			() => {
				this.execCallCount += 1;
				return this.execCallCount;
			},
		);
		this.execPromises.add(execution);
		try {
			return await execution;
		} finally {
			this.execPromises.delete(execution);
			this.execControllers.delete(controller);
		}
	}

	/**
	 * Stop everything this manager owns.
	 *
	 * `confirmProcessesStopped` is what turns an ordinary shutdown into a
	 * resumable one: it runs after every worker has been killed and returns true
	 * only when each recorded process group is confirmed gone. Recording that
	 * proof here, before the worker records are dropped, is what lets a later
	 * `neta resume` skip the recovery barrier instead of refusing.
	 */
	async dispose(options: { confirmProcessesStopped?: () => boolean } = {}): Promise<void> {
		this.disposed = true;
		for (const controller of this.execControllers) controller.abort();
		await Promise.allSettled([...this.execPromises]);
		const records = [...this.workers.values()];
		await Promise.all(
			records.map(async (record) => {
				if (!isTerminalState(record.state)) {
					record.stateBeforeStop = record.state as ActiveWorkerState;
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
						await this.finish(record, "interrupted", "Leader shut down; review this worker before continuing.");
					} catch (error) {
						this.appendLog(
							record,
							"error",
							`Could not finish shutdown: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				if (record.scratchDir) await rm(record.scratchDir, { recursive: true, force: true }).catch(() => {});
			}),
		);
		if (options.confirmProcessesStopped?.() === true) {
			this.shutdownProof = { at: Date.now(), processesStopped: true, by: "graceful" };
		}
		this.checkpointChanged();
		await this.flushCheckpoint();
		this.workers.clear();
	}

	/**
	 * Compute backend assignments on a copy of assignment state so a delegate
	 * batch can be validated before it creates a worker or team transcript.
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
		// A delegate batch is all-or-nothing at the validation boundary.
		this.assertTiersAvailable(requests.map((request) => request.tier));
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
		this.appendTelemetryLog(record, "progress", text);
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
		// The name is what tells two debaters of the same role and tier apart, so
		// the label carries it — in the room transcript and in the worker's own log.
		const label =
			record.name === record.role
				? `${record.role}/${record.tier}`
				: `${record.name} · ${record.role}/${record.tier}`;
		this.postToRoom(record.room, workerId, label, text);
		this.appendLog(record, "say", text, { from: workerId, label });
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

	blocked(workerId: string, text: string): ChannelResponse {
		const record = this.workers.get(workerId);
		if (!record) return { ok: false, error: `Unknown worker ${workerId}.` };
		if (!record.promptInFlight || record.currentTurn === undefined) {
			return { ok: false, error: "neta_blocked must be called from the worker's active ACP turn." };
		}
		if (record.blockedTurn !== undefined) return { ok: false, error: "This worker already reported a blocker." };
		record.pendingQuestion = text;
		record.pendingDiscoveryId = undefined;
		record.blockedTurn = record.currentTurn;
		this.appendLog(record, "status", `Blocked: ${text}`);
		this.checkpointChanged(record);
		const turn = record.currentTurn;
		queueMicrotask(() => {
			void (async () => {
				try {
					await this.cancelTurn(record, turn);
				} catch (error) {
					this.appendLog(
						record,
						"error",
						`Could not cancel blocked turn: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				// Some bridges acknowledge cancel without ending the turn. Blocking is
				// still terminal: force-stop after a short grace period so a writer slot
				// cannot remain held forever.
				await this.settle(record.queue, 1_000);
				if (record.blockedTurn === turn && !isTerminalState(record.state) && !record.finishing) {
					await this.finish(record, "blocked", record.pendingQuestion ?? text);
				}
			})();
		});
		return { ok: true, text: "Blocker recorded. This turn will stop now; the leader resumes it with neta_send." };
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
				case "workers": {
					const workers = this.list();
					if (workers.length === 0) return { ok: true, text: "No workers." };
					return { ok: true, text: workers.map((worker) => this.statusLine(worker, 200)).join("\n") };
				}
				case "status":
					return { ok: true, text: this.status() };
				case "tail": {
					const page = this.tailLog(request.workerId, request.since);
					return {
						ok: true,
						text: page.entries.map((entry) => `[${entry.kind}] ${entry.text}`).join("\n"),
						data: page,
					};
				}
				case "room-tail": {
					const page = this.tailRoom(request.room, request.since);
					return {
						ok: true,
						text: page.posts.map((post) => `[${post.label}] ${post.text}`).join("\n"),
						data: page,
					};
				}
				case "inspect": {
					const inspection = this.inspect(request.workerId);
					return { ok: true, text: formatInspection(inspection, this.now()).join("\n"), data: inspection };
				}
				case "wait": {
					const summaries = await this.waitFor(request.workerIds, request.timeoutMs ?? 600_000);
					const shown = summaries.slice(0, CHANNEL_ROW_LIMIT);
					const omitted = summaries.length - shown.length;
					return {
						ok: true,
						text:
							shown.map((summary) => this.statusLine(summary, CHANNEL_RESULT_LIMIT, true)).join("\n\n") +
							(omitted > 0
								? `\n\n... ${omitted} worker rows omitted; use neta_status with view="workers" for more.`
								: ""),
					};
				}
				case "send":
				case "pane-input": {
					// CLI send and typed watch-pane input are exactly the same central
					// operation as the MCP tool. Keeping one primitive prevents the pane
					// from silently falling back to old queue-only behavior.
					const steered = await this.steer(request.workerId, request.text);
					return {
						ok: true,
						text: `${formatSteerResult(steered)}\n${this.statusLine(steered.worker, CHANNEL_RESULT_LIMIT, true)}`,
						data: { delivery: steered.delivery, note: steered.note },
					};
				}
				case "kill":
					return {
						ok: true,
						text: this.statusLine(await this.kill(request.workerId), CHANNEL_RESULT_LIMIT, true),
					};
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

	private statusLine(summary: WorkerSummary, resultLimit?: number, boundedFields = false): string {
		const access = summary.writer ? "writer" : "read-only";
		const room = summary.room ? `, room ${boundedFields ? clipChannel(summary.room) : summary.room}` : "";
		const model = displayModel(summary);
		const session =
			model || summary.mode
				? `, ${[model ? (boundedFields ? clipChannel(model) : model) : undefined, summary.mode ? (boundedFields ? clipChannel(summary.mode) : summary.mode) : undefined].filter(Boolean).join("/")}`
				: "";
		const task = boundedFields ? clipChannel(summary.task) : summary.task;
		let line = `${summary.id} [${boundedFields ? clipChannel(summary.role) : summary.role}/${summary.tier}, ${access}${room}${session}] ${summary.state} — ${task} | ${formatWorkerDuration(summary, this.now())}`;
		const usage = formatUsage(summary.usage, summary.modelId ?? summary.model);
		if (usage) line += `\n  usage: ${boundedFields ? clipChannel(usage) : usage}`;
		const lastProgress = formatLastProgress(summary);
		if (lastProgress) line += `\n  ${lastProgress}`;
		if (summary.pendingQuestion)
			line += `\n  asks: ${boundedFields ? clipChannel(summary.pendingQuestion) : summary.pendingQuestion}`;
		if (summary.result) {
			const limit = boundedFields ? CHANNEL_RESULT_LIMIT : resultLimit;
			const result = boundedFields
				? clipChannel(summary.result, CHANNEL_RESULT_LIMIT)
				: limit && summary.result.length > limit
					? `${summary.result.slice(0, limit)}…`
					: summary.result;
			line += `\n  ${result}`;
		}
		// After the result, because the result is the worker's answer and this is a
		// caveat on it: reading them the other way round buries the handoff.
		if (summary.laterFailure)
			line += `\n  after its report: ${boundedFields ? clipChannel(summary.laterFailure, CHANNEL_RESULT_LIMIT) : summary.laterFailure}`;
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

	private appendLog(
		record: WorkerRecord,
		kind: WorkerLogEntry["kind"],
		text: string,
		attribution?: { from: string; label: string },
	): void {
		record.log.push({ at: Date.now(), kind, text, ...attribution });
		if (record.log.length > MAX_LOG_ENTRIES) {
			const dropped = record.log.length - MAX_LOG_ENTRIES;
			record.log.splice(0, dropped);
			record.logFirstIndex += dropped;
			record.logCursor = Math.max(record.logCursor, record.logFirstIndex);
		}
		this.checkpointChanged(record);
	}

	private appendTelemetryLog(
		record: WorkerRecord,
		kind: WorkerLogEntry["kind"],
		text: string,
		attribution?: { from: string; label: string },
	): void {
		record.log.push({ at: Date.now(), kind, text, ...attribution });
		if (record.log.length > MAX_LOG_ENTRIES) {
			const dropped = record.log.length - MAX_LOG_ENTRIES;
			record.log.splice(0, dropped);
			record.logFirstIndex += dropped;
			record.logCursor = Math.max(record.logCursor, record.logFirstIndex);
		}
		this.checkpointChanged(record, "deferred", "worker");
	}

	private checkpointChanged(
		record?: WorkerRecord,
		scheduleLane: "immediate" | "deferred" = "immediate",
		mutationLane: V6CheckpointDeltaLane = "structural",
	): void {
		const checkpoint = this.options.checkpoint;
		if (!checkpoint) return;
		if (!checkpoint.writer.isV6 && !this.options.checkpointStorePath) {
			if (scheduleLane === "deferred")
				checkpoint.writer.scheduleDeferred(() => this.checkpointSnapshot(), checkpoint.id);
			else checkpoint.writer.schedule(this.checkpointSnapshot());
			return;
		}
		if (scheduleLane === "deferred")
			checkpoint.writer.scheduleDeferredDelta(() => this.checkpointDelta(record, mutationLane), checkpoint.id);
		else checkpoint.writer.scheduleDelta(this.checkpointDelta(record, mutationLane));
	}

	/** One transport shape for immediate and dequeued workers, including crash-recovery registration. */
	private createWorkerTransport(
		record: WorkerRecord,
		backend: ResolvedBackend,
		runtimeEnv: Record<string, string>,
		systemPrompt: string,
		resumeSessionId?: string,
	): WorkerTransportDriver {
		if (!record.scratchDir) throw new Error(`Worker ${record.id} has no live scratch directory.`);
		if (!record.channelToken) throw new Error(`Worker ${record.id} has no live channel token.`);
		// Last guard before ACP process creation. Settings validation is defense in depth;
		// this is the boundary that guarantees a forbidden model cannot reach a provider.
		assertClaudeModelAllowed(backend.claudeLineage, backend.model, `runtime worker ${record.id}`);
		const backendPath = backend.env.PATH;
		const runtimePath = runtimeEnv.PATH;
		return this.createTransport({
			workerId: record.id,
			cwd: record.cwd,
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
			// Every Claude tier, not just the architect's Opus 1M Max. Anthropic's
			// own default can be a model Neta's policy forbids, and a warn-and-carry-on
			// selection would spend the turn on it. Confirm the tier's exact model
			// with the backend or send no task prompt at all.
			requireExactModel: backend.claudeLineage,
			writer: record.writer,
			systemPrompt,
			scratchDir: record.scratchDir,
			mcpServers:
				this.options.workerMcpServers?.(record.id, record.scratchDir, record.channelToken, record.room) ?? [],
			resumeSessionId,
			initialUsage: resumeSessionId ? record.usage : undefined,
			events: {
				log: (kind, text) => this.appendTelemetryLog(record, kind, text),
				usage: (usage) => {
					record.usage = usage;
					this.checkpointChanged(record, "deferred", "worker");
				},
				vendorSession: (sessionId) => {
					record.vendorSessionId = sessionId;
					this.checkpointChanged(record, "immediate", "worker");
				},
				session: (session) => {
					record.model = session.model;
					record.modelId = session.modelId;
					record.mode = session.mode;
					record.agentInfo = session.agentInfo;
					this.checkpointChanged(record, "immediate", "worker");
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
		record.updatedAt = this.now();
		if (record.noteId) {
			const link = this.notes.get(record.noteId)?.workers.find((w) => w.workerId === record.id);
			if (link) link.state = state;
		}
		this.checkpointChanged(record, "immediate", "structural");
	}

	private beginActive(record: WorkerRecord, at = this.now()): void {
		if (record.activeStartedAt !== undefined) return;
		if (record.queuedStartedAt !== undefined) {
			record.queuedMs += Math.max(0, at - record.queuedStartedAt);
			record.queuedStartedAt = undefined;
		}
		record.activeStartedAt = at;
	}

	private freezeTiming(record: WorkerRecord, at = this.now()): void {
		if (record.activeStartedAt !== undefined) {
			record.activeMs += Math.max(0, at - record.activeStartedAt);
			record.activeStartedAt = undefined;
		}
		if (record.queuedStartedAt !== undefined) {
			record.queuedMs += Math.max(0, at - record.queuedStartedAt);
			record.queuedStartedAt = undefined;
		}
	}

	private enqueue(
		record: WorkerRecord,
		message: string,
		automatic = false,
		leaderMessages: string[] = [],
		/** Called at the moment this prompt is handed to the backend, not before. */
		onDelivered?: () => void,
		/** A turn-boundary barrier, used to keep a cancel ahead of its replacement prompt. */
		beforePrompt?: () => Promise<boolean>,
	): boolean {
		if (isTerminalState(record.state) || record.finishing || record.killReason) return false;
		record.queuedPrompts += 1;
		this.checkpointChanged(record);
		record.queue = record.queue.then(async () => {
			try {
				if (isTerminalState(record.state) || record.finishing || record.killReason) return;
				const driver = record.driver;
				if (!driver) throw new Error(`Worker ${record.id} has no live transport.`);
				if (beforePrompt && !(await beforePrompt())) return;
				for (const leaderMessage of leaderMessages) {
					this.appendLog(record, "status", `Leader delivering now as next turn: ${leaderMessage}`);
				}
				const turn = ++record.turnCounter;
				record.currentTurn = turn;
				record.promptInFlight = true;
				let outcome: PromptOutcome;
				try {
					const prompting = driver.prompt(message);
					onDelivered?.();
					outcome = await prompting;
				} finally {
					record.promptInFlight = false;
					record.currentTurn = undefined;
				}
				const steered = record.steeredTurns.delete(turn);
				record.cancelDispatches.delete(turn);
				if (record.blockedTurn === turn) {
					record.lastResponse = outcome.summary;
					await this.finish(record, "blocked", record.pendingQuestion ?? "Worker is blocked.");
					return;
				}
				if (isTerminalState(record.state) || record.finishing || record.killReason) return;
				// A turn Neta cancelled on purpose, to put a new instruction in front
				// of this worker. It is not a failure: the worker is healthy, its
				// session is intact, its writer slot is unchanged, and the message that
				// caused the cancel is the next thing in this same queue. Whatever the
				// worker managed to say before stopping is kept as its last response,
				// but never promoted to its report.
				//
				// Only the turn a steer actually aimed at qualifies. A cancel that
				// arrived late and stopped some later turn falls through to the
				// ordinary early-stop handling below, which is visible to the leader —
				// far better than silently leaving a worker running with nothing queued.
				if (outcome.cancelled && steered) {
					record.interruptedTurns.add(turn);
					// Bound retained accounting while leaving enough history for every
					// concurrent caller waiting on this turn's replacement prompt.
					for (const old of record.interruptedTurns) {
						if (old < turn - 100) record.interruptedTurns.delete(old);
					}
					record.lastResponse = outcome.summary;
					this.appendLog(record, "status", "Turn interrupted to deliver the leader's message.");
					this.checkpointChanged(record);
					return;
				}
				if (!outcome.ok) {
					// A later turn failing must not delete the handoff this worker
					// already produced. Neta's own writer notices are appended as
					// prompts, so a worker that did its job and then hit a backend
					// error on an automatic notice used to come back as a bare error
					// message, with the real report reachable only by draining the log.
					const preserved = record.substantiveResponse;
					const failure = `${automatic ? "automatic notice" : "follow-up"} failed after the report above: ${outcome.summary}`;
					if (!preserved) {
						await this.finish(record, "failed", outcome.summary);
						return;
					}
					// The task itself finished; only Neta's own notice failed. A failed
					// follow-up the leader sent is a failed turn, and stays one.
					await this.finish(record, automatic ? "done" : "failed", preserved, { failure });
					return;
				}
				record.lastResponse = outcome.summary;
				if (!automatic) record.substantiveResponse = outcome.summary;
				this.checkpointChanged(record, "immediate", "worker");
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
				await this.finish(
					record,
					"done",
					automatic ? (record.substantiveResponse ?? outcome.summary) : outcome.summary,
				);
			} finally {
				record.queuedPrompts -= 1;
				this.checkpointChanged(record, "immediate", "worker");
			}
		});
		return true;
	}

	/**
	 * ACP's session/prompt request owns an entire prompt turn; neither the SDK
	 * nor installed Codex/Claude bridges' private steering features are used here.
	 * Neta intentionally uses cross-provider FIFO next-turn prompts, never
	 * injecting a follow-up into an active turn and cancelling one only when
	 * killing the worker. Notices are also logged.
	 */
	private notifyReadOnlyWorkers(writer: WorkerRecord, activity: "started" | "finished", changes?: string): void {
		const notice = formatWriterActivityNotice(this.summarize(writer), activity, changes);
		for (const record of this.workers.values()) {
			if (record.writer || record.state === "queued" || isTerminalState(record.state) || record.finishing) continue;
			if (record.state === "starting") {
				record.pendingBrief.push(notice);
				this.appendLog(record, "status", notice);
			} else {
				// In this non-starting enqueue path, acceptance and logging are one
				// synchronous decision. If finish has begun, enqueue rejects and the pane
				// never promises a discarded notice.
				if (this.enqueue(record, notice, true)) this.appendLog(record, "status", notice);
			}
		}
	}

	private withPendingBrief(record: WorkerRecord, task: string): { message: string; leaderMessages: string[] } {
		if (record.pendingBrief.length === 0) return { message: task, leaderMessages: [] };
		const messages = record.pendingBrief.join("\n\n");
		const leaderMessages = record.pendingBriefLeaderMessages;
		record.pendingBrief = [];
		record.pendingBriefLeaderMessages = [];
		return { message: `${task}\n\n---\n\n# Pending messages\n\n${messages}`, leaderMessages };
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

	/**
	 * Make a worker terminal with the result the leader should read.
	 *
	 * `failure` is for the case where the result and the reason to worry are two
	 * different things: the worker's report stands, and something after it went
	 * wrong. It is reported alongside the result rather than replacing it.
	 */
	private finish(
		record: WorkerRecord,
		state: WorkerState,
		result: string,
		options: { failure?: string } = {},
	): Promise<void> {
		if (record.killReason && state !== "killed") {
			state = "killed";
			result = record.killReason;
		}
		this.freezeTiming(record);
		if (record.finishing) return record.finishing;
		// This is the backstop during shutdown: a late ACP write is rejected while
		// the process-group kill below is still waiting for its exit event.
		record.driver?.markTerminal();
		const finishing = (async () => {
			const startedWriter = record.writer && record.state !== "queued";
			if (state !== "killed" && state !== "interrupted") {
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
			record.lastResponse ??= result;
			if (options.failure) record.laterFailure = options.failure;
			this.checkpointChanged(record);
			// A finished worker's prose already streamed into the log, so logging the
			// full result here printed the whole final message a second time, raw, in
			// every pane. The state is the news; the text is not. Failures still carry
			// their reason, which did not stream.
			this.appendLog(
				record,
				state === "done" || state === "blocked" ? "status" : "error",
				state === "done"
					? "done"
					: state === "blocked"
						? `blocked: ${record.pendingQuestion ?? result}`
						: `${state}: ${options.failure ?? result}`,
			);
			// A preserved report ends "done"; the thing that went wrong after it
			// still has to be visible in the log, not only on the summary.
			if (options.failure && state === "done") this.appendLog(record, "error", options.failure);
			this.checkpointChanged(record);
			// Terminal publication is the linearization point: the complete result and
			// its immutable detail segment must be durable before any event wakes wait.
			record.terminalOutcomeLoaded = true;
			await this.flushCheckpoint();
			const persistenceError = this.options.checkpoint?.writer.lastError;
			if (persistenceError) {
				throw new Error(`Terminal result for ${record.id} was not durably published: ${persistenceError.message}`);
			}
			if (this.options.checkpointStorePath) {
				const publishedRef = readV6WorkerRef(
					this.options.checkpointStorePath,
					record.id,
					this.options.checkpointReadCounters,
				);
				if (publishedRef) this.terminalRefs.set(record.id, publishedRef);
			}

			const event: WorkerEvent | undefined =
				state === "done"
					? {
							type: "done",
							workerId: record.id,
							summary: result,
							dirtyFiles: dirtyFiles.length > 0 ? dirtyFiles : undefined,
						}
					: state === "failed"
						? { type: "failed", workerId: record.id, error: options.failure ?? result }
						: state === "blocked"
							? (() => {
									const discovery = record.pendingDiscoveryId
										? this.goal?.discoveries.find((candidate) => candidate.id === record.pendingDiscoveryId)
										: undefined;
									return discovery
										? { type: "discovery", workerId: record.id, discovery }
										: { type: "blocked", workerId: record.id, question: record.pendingQuestion ?? result };
								})()
							: undefined;
			if (this.options.checkpointStorePath && isTerminalState(state)) {
				this.evictTerminalRecord(
					record,
					terminalHotSummary({
						id: record.id,
						name: record.name,
						role: record.role,
						tier: record.tier,
						backend: record.backend,
						writer: record.writer,
						room: record.room,
						task: record.task,
						result,
						laterFailure: record.laterFailure,
						pendingQuestion: record.pendingQuestion,
						lastProgress: record.lastProgress,
						state,
						startedAt: record.startedAt,
						endedAt: record.endedAt,
						activeMs: record.activeMs,
						queuedMs: record.queuedMs,
						activeStartedAt: record.activeStartedAt,
						queuedStartedAt: record.queuedStartedAt,
						stateBeforeStop: record.stateBeforeStop,
					}),
				);
			}
			if (event) this.options.onEvent(event);

			const wasActiveWriter = this.activeWriter === record.id;
			if (startedWriter) this.notifyReadOnlyWorkers(record, "finished", changes);
			if (wasActiveWriter) this.activeWriter = undefined;
			this.checkpointChanged(record);

			if (state !== "interrupted" && state !== "blocked") record.pendingQuestion = undefined;
			this.checkpointChanged(record);
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
		this.checkpointChanged();
		return note;
	}

	closeNote(noteId: string): Note {
		const note = this.notes.get(noteId);
		if (!note) throw new Error(`Unknown note id "${noteId}".`);
		note.open = false;
		note.closedAt = Date.now();
		this.checkpointChanged();
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
		const dequeuedAt = this.now();
		this.writerQueueHistory.push({ workerId: nextId, action: "started", at: dequeuedAt });
		this.beginActive(record, dequeuedAt);
		this.checkpointChanged(record);

		this.activeWriter = nextId;
		if (record.revivalMessage !== undefined) {
			const message = record.revivalMessage;
			try {
				await this.resumeRecord(record, message);
			} catch (error) {
				this.appendLog(
					record,
					"error",
					`Exact-session resume failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				if (this.activeWriter === record.id) this.activeWriter = undefined;
				this.checkpointChanged(record);
				void this.dequeueNextWriter();
			}
			return;
		}

		// Prepend staleness guard to task
		const stalenessGuard =
			"Note: you were queued behind another writer that has since finished. Check `git log` and `git status` for the repo's current state before starting.";
		const goalContext = this.goalPromptContext();
		const assignedTask = goalContext
			? `${goalContext}\n\n---\n\n# Task\n\n${record.task}`
			: `# Task\n\n${record.task}`;
		const fullTask = `${stalenessGuard}\n\n---\n\n${assignedTask}`;

		try {
			// Resolve again at dequeue: settings may have changed while this writer
			// waited. Every preparation failure becomes the worker's honest result.
			const backend = this.options.config.resolve(record.tier, record.backend, true);
			assertClaudeModelAllowed(backend.claudeLineage, backend.model, `runtime ${record.tier} assignment`);
			const runtimeEnv = (await this.options.prepareEnv?.()) ?? {};
			if (this.disposed || record.state !== "queued") return;
			const roleText = loadRoleText(record.role, this.options.cwd, this.options.agentDir);
			const systemPrompt = [
				roleText?.trim() ?? "",
				"",
				workingAgreement({ tier: record.tier, writer: true, room: record.room, binary: APP_NAME }),
				"",
				`Your scratch directory (outside the repository) is ${record.scratchDir ?? "unavailable"}. Use it for notes and throwaway files.`,
			].join("\n");

			record.driver = this.createWorkerTransport(record, backend, runtimeEnv, systemPrompt);
			record.headAtStart = gitHead(this.options.cwd);
			this.lastWriterBackend = backend.name;
			this.setState(record, "starting");
			this.appendLog(record, "status", "Dequeued and starting...");
			await record.driver.start();
		} catch (error) {
			await this.finish(record, "failed", error instanceof Error ? error.message : String(error));
			return;
		}

		this.setState(record, "running");
		this.notifyReadOnlyWorkers(record, "started");

		// Enqueue task with staleness guard and any pending messages delivered together
		const firstPrompt = this.withPendingBrief(record, fullTask);
		this.enqueue(record, firstPrompt.message, false, firstPrompt.leaderMessages);

		await this.openWorkerView(record);
	}

	/** A missing pane is visible in the delegate result; it never blocks the worker. */
	private async openWorkerView(record: WorkerRecord): Promise<void> {
		if (this.options.panes && missingUnixChannel(this.options.channelAddress)) {
			const reason =
				`manager Unix socket ${this.options.channelAddress} is missing; ` +
				"restart the Neta session before opening worker views";
			record.headlessReason = reason;
			this.appendLog(record, "status", `Worker view: headless — ${reason}`);
			return;
		}
		const outcome = await this.options.panes?.open(this.summarize(record));
		const reason = outcome ? (outcome.opened ? undefined : outcome.reason) : this.options.headlessReason;
		if (reason) {
			record.headlessReason = reason;
			this.appendLog(record, "status", `Worker view: headless — ${reason}`);
		}
		// The room's own merged view opens once, beside its first member's pane.
		// It closes itself the way a worker pane does: the watch process holds
		// after the last member finishes and exits when the batch is archived.
		if (record.room && this.options.panes && !this.roomPanesOpened.has(record.room)) {
			this.roomPanesOpened.add(record.room);
			const roomOutcome = await this.options.panes.openRoom(record.room);
			if (!roomOutcome.opened) {
				this.appendLog(record, "status", `Room view: headless — ${roomOutcome.reason}`);
			}
		}
	}

	private summarize(record: WorkerRecord): WorkerSummary {
		const terminal = record.terminalSummary;
		return {
			id: terminal?.id ?? record.id,
			name: terminal?.name ?? record.name,
			role: terminal?.role ?? record.role,
			tier: terminal?.tier ?? record.tier,
			backend: terminal?.backend ?? record.backend,
			writer: terminal?.writer ?? record.writer,
			room: terminal?.room ?? record.room,
			state: record.state,
			task: terminal?.taskPreview ?? record.task,
			startedAt: terminal?.startedAt ?? record.startedAt,
			endedAt: terminal?.endedAt ?? record.endedAt,
			activeMs: terminal?.activeMs ?? record.activeMs,
			queuedMs: terminal?.queuedMs ?? record.queuedMs,
			activeStartedAt: terminal?.activeStartedAt ?? record.activeStartedAt,
			queuedStartedAt: terminal?.queuedStartedAt ?? record.queuedStartedAt,
			stateBeforeStop: terminal?.stateBeforeStop ?? record.stateBeforeStop,
			result: record.result ?? terminal?.resultPreview,
			laterFailure: record.laterFailure ?? terminal?.laterFailurePreview,
			queuedBehind: record.state === "queued" ? record.queuedBehind : undefined,
			pendingQuestion: record.pendingQuestion ?? terminal?.pendingQuestionPreview,
			promptBlockedReason: record.unsafeToPrompt,
			lastProgress: record.lastProgress,
			scratchDir: record.scratchDir,
			usage: record.usage,
			vendorSessionId: record.vendorSessionId,
			model: record.model,
			modelId: record.modelId,
			mode: record.mode,
			agentInfo: record.agentInfo,
			headlessReason: record.headlessReason,
			revivalCount: record.revivalCount,
		};
	}
}
