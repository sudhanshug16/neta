/** Durable, versioned semantic state for restart-safe Neta sessions. */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { VERSION } from "./config.ts";
import { isSessionLeaseAlive } from "./session.ts";
import {
	type Note,
	type RoomPost,
	TIERS,
	type Tier,
	type WorkerLogEntry,
	type WorkerState,
	type WorkerUsage,
} from "./types.ts";

export const CHECKPOINT_SCHEMA_VERSION = 1;

export interface CheckpointLiveLease {
	managerId: string;
	processStartedAt?: string;
}

export interface CheckpointWriterQueueEvent {
	workerId: string;
	action: "queued" | "started" | "removed";
	at: number;
}

export interface CheckpointWorker {
	id: string;
	name: string;
	role: string;
	tier: Tier;
	backend: string;
	writer: boolean;
	room?: string;
	task: string;
	state: WorkerState;
	stateBeforeStop?: "starting" | "running" | "waiting" | "queued";
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
	finalResult?: string;
	substantiveResponse?: string;
	lastResponse?: string;
	log: WorkerLogEntry[];
	logFirstIndex: number;
	logCursor: number;
	pendingQuestion?: string;
	lastProgress?: { text: string; at: number };
	usage?: WorkerUsage;
	vendorSessionId?: string;
	archived?: boolean;
	model?: string;
	modelId?: string;
	mode?: string;
	agentInfo?: string;
	noteId?: string;
	queuedBehind?: string;
	pendingBrief: string[];
	headAtStart?: string;
	headlessReason?: string;
}

export interface SessionCheckpoint {
	schemaVersion: 1;
	appVersion: string;
	id: string;
	canonicalCwd: string;
	leader: { backend: string; vendorConversationId?: string };
	createdAt: number;
	updatedAt: number;
	liveLease?: CheckpointLiveLease;
	counter: number;
	noteCounter: number;
	workers: CheckpointWorker[];
	activeWriter?: string;
	writerQueue: string[];
	writerQueueHistory: CheckpointWriterQueueEvent[];
	notes: Note[];
	rooms: Array<{ name: string; posts: RoomPost[] }>;
	spreadCursors: Array<{ tier: Tier; cursor: number }>;
	lastWriterBackend?: string;
	roomDebaterBackends: Array<{ room: string; backends: string[] }>;
}

declare const hydrationChecked: unique symbol;
/** A checkpoint whose old live-manager lease was checked and found inactive. */
export type HydratableCheckpoint = SessionCheckpoint & { readonly [hydrationChecked]: true };

export class CheckpointError extends Error {}

function checkpointDir(agentDir: string): string {
	return join(agentDir, "checkpoints");
}

function safeId(id: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
		throw new CheckpointError(`Invalid checkpoint id "${id}".`);
	}
}

export function checkpointPath(id: string, agentDir: string): string {
	safeId(id);
	return join(checkpointDir(agentDir), `${id}.json`);
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CheckpointError(`Corrupt checkpoint: ${path} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
	if (unexpected) throw new CheckpointError(`Corrupt checkpoint: unexpected field ${path}.${unexpected}.`);
}

function string(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string") throw new CheckpointError(`Corrupt checkpoint: ${path} must be a string.`);
}

function number(value: unknown, path: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new CheckpointError(`Corrupt checkpoint: ${path} must be a finite number.`);
	}
}

function boolean(value: unknown, path: string): asserts value is boolean {
	if (typeof value !== "boolean") throw new CheckpointError(`Corrupt checkpoint: ${path} must be a boolean.`);
}

function optional(value: unknown, validate: (value: unknown) => void): void {
	if (value !== undefined) validate(value);
}

function strings(value: unknown, path: string): asserts value is string[] {
	if (!Array.isArray(value)) throw new CheckpointError(`Corrupt checkpoint: ${path} must be an array.`);
	value.forEach((entry, index) => {
		string(entry, `${path}[${index}]`);
	});
}

const WORKER_STATES: readonly WorkerState[] = [
	"starting",
	"running",
	"waiting",
	"queued",
	"done",
	"failed",
	"killed",
	"interrupted",
];

function workerState(value: unknown, path: string): asserts value is WorkerState {
	if (typeof value !== "string" || !WORKER_STATES.includes(value as WorkerState)) {
		throw new CheckpointError(`Corrupt checkpoint: ${path} is not a known worker state.`);
	}
}

function validateLog(value: unknown, path: string): void {
	if (!Array.isArray(value)) throw new CheckpointError(`Corrupt checkpoint: ${path} must be an array.`);
	for (const [index, entryValue] of value.entries()) {
		const entry = object(entryValue, `${path}[${index}]`);
		exact(entry, ["at", "kind", "text", "from", "label"], `${path}[${index}]`);
		number(entry.at, `${path}[${index}].at`);
		string(entry.kind, `${path}[${index}].kind`);
		if (!["progress", "say", "status", "tool", "text", "thought", "diff", "error"].includes(entry.kind)) {
			throw new CheckpointError(`Corrupt checkpoint: ${path}[${index}].kind is unknown.`);
		}
		string(entry.text, `${path}[${index}].text`);
		optional(entry.from, (item) => string(item, `${path}[${index}].from`));
		optional(entry.label, (item) => string(item, `${path}[${index}].label`));
	}
}

function validateUsage(value: unknown, path: string): void {
	const usage = object(value, path);
	exact(
		usage,
		["inputTokens", "outputTokens", "totalTokens", "contextUsed", "contextSize", "costAmount", "costCurrency"],
		path,
	);
	for (const key of ["inputTokens", "outputTokens", "totalTokens", "contextUsed", "contextSize", "costAmount"])
		optional(usage[key], (item) => number(item, `${path}.${key}`));
	optional(usage.costCurrency, (item) => string(item, `${path}.costCurrency`));
}

function validateWorker(value: unknown, path: string): void {
	const worker = object(value, path);
	exact(
		worker,
		[
			"id",
			"name",
			"role",
			"tier",
			"backend",
			"writer",
			"room",
			"task",
			"state",
			"stateBeforeStop",
			"startedAt",
			"updatedAt",
			"endedAt",
			"finalResult",
			"substantiveResponse",
			"lastResponse",
			"log",
			"logFirstIndex",
			"logCursor",
			"pendingQuestion",
			"lastProgress",
			"usage",
			"vendorSessionId",
			"archived",
			"model",
			"modelId",
			"mode",
			"agentInfo",
			"noteId",
			"queuedBehind",
			"pendingBrief",
			"headAtStart",
			"headlessReason",
		],
		path,
	);
	for (const key of ["id", "name", "role", "backend", "task"]) string(worker[key], `${path}.${key}`);
	string(worker.tier, `${path}.tier`);
	if (!(TIERS as readonly string[]).includes(worker.tier))
		throw new CheckpointError(`Corrupt checkpoint: ${path}.tier is unknown.`);
	boolean(worker.writer, `${path}.writer`);
	workerState(worker.state, `${path}.state`);
	optional(worker.stateBeforeStop, (item) => {
		workerState(item, `${path}.stateBeforeStop`);
		if (item === "done" || item === "failed" || item === "killed" || item === "interrupted")
			throw new CheckpointError(`Corrupt checkpoint: ${path}.stateBeforeStop must be nonterminal.`);
	});
	for (const key of ["startedAt", "updatedAt", "logFirstIndex", "logCursor"]) number(worker[key], `${path}.${key}`);
	optional(worker.endedAt, (item) => number(item, `${path}.endedAt`));
	validateLog(worker.log, `${path}.log`);
	strings(worker.pendingBrief, `${path}.pendingBrief`);
	for (const key of [
		"room",
		"finalResult",
		"substantiveResponse",
		"lastResponse",
		"pendingQuestion",
		"vendorSessionId",
		"model",
		"modelId",
		"mode",
		"agentInfo",
		"noteId",
		"queuedBehind",
		"headAtStart",
		"headlessReason",
	])
		optional(worker[key], (item) => string(item, `${path}.${key}`));
	optional(worker.archived, (item) => boolean(item, `${path}.archived`));
	optional(worker.lastProgress, (item) => {
		const progress = object(item, `${path}.lastProgress`);
		exact(progress, ["text", "at"], `${path}.lastProgress`);
		string(progress.text, `${path}.lastProgress.text`);
		number(progress.at, `${path}.lastProgress.at`);
	});
	optional(worker.usage, (item) => validateUsage(item, `${path}.usage`));
}

function validateNote(value: unknown, path: string): void {
	const note = object(value, path);
	exact(note, ["id", "text", "open", "createdAt", "closedAt", "workers"], path);
	string(note.id, `${path}.id`);
	string(note.text, `${path}.text`);
	boolean(note.open, `${path}.open`);
	number(note.createdAt, `${path}.createdAt`);
	optional(note.closedAt, (item) => number(item, `${path}.closedAt`));
	if (!Array.isArray(note.workers)) throw new CheckpointError(`Corrupt checkpoint: ${path}.workers must be an array.`);
	for (const [index, linkValue] of note.workers.entries()) {
		const link = object(linkValue, `${path}.workers[${index}]`);
		exact(link, ["workerId", "state"], `${path}.workers[${index}]`);
		string(link.workerId, `${path}.workers[${index}].workerId`);
		workerState(link.state, `${path}.workers[${index}].state`);
	}
}

function validatePost(value: unknown, path: string): void {
	const post = object(value, path);
	exact(post, ["at", "from", "label", "text"], path);
	number(post.at, `${path}.at`);
	string(post.from, `${path}.from`);
	string(post.label, `${path}.label`);
	string(post.text, `${path}.text`);
}

export function validateCheckpoint(value: unknown): SessionCheckpoint {
	const root = object(value, "checkpoint");
	exact(
		root,
		[
			"schemaVersion",
			"appVersion",
			"id",
			"canonicalCwd",
			"leader",
			"createdAt",
			"updatedAt",
			"liveLease",
			"counter",
			"noteCounter",
			"workers",
			"activeWriter",
			"writerQueue",
			"writerQueueHistory",
			"notes",
			"rooms",
			"spreadCursors",
			"lastWriterBackend",
			"roomDebaterBackends",
		],
		"checkpoint",
	);
	if (root.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
		throw new CheckpointError(
			`Checkpoint schema version ${String(root.schemaVersion)} is not supported by this Neta version (expected ${CHECKPOINT_SCHEMA_VERSION}). The original file was preserved.`,
		);
	}
	for (const key of ["appVersion", "id", "canonicalCwd"]) string(root[key], `checkpoint.${key}`);
	for (const key of ["createdAt", "updatedAt", "counter", "noteCounter"]) number(root[key], `checkpoint.${key}`);
	const leader = object(root.leader, "checkpoint.leader");
	exact(leader, ["backend", "vendorConversationId"], "checkpoint.leader");
	string(leader.backend, "checkpoint.leader.backend");
	optional(leader.vendorConversationId, (item) => string(item, "checkpoint.leader.vendorConversationId"));
	optional(root.liveLease, (item) => {
		const lease = object(item, "checkpoint.liveLease");
		exact(lease, ["managerId", "processStartedAt"], "checkpoint.liveLease");
		string(lease.managerId, "checkpoint.liveLease.managerId");
		optional(lease.processStartedAt, (entry) => string(entry, "checkpoint.liveLease.processStartedAt"));
	});
	if (!Array.isArray(root.workers))
		throw new CheckpointError("Corrupt checkpoint: checkpoint.workers must be an array.");
	root.workers.forEach((worker, index) => {
		validateWorker(worker, `checkpoint.workers[${index}]`);
	});
	optional(root.activeWriter, (item) => string(item, "checkpoint.activeWriter"));
	strings(root.writerQueue, "checkpoint.writerQueue");
	if (!Array.isArray(root.writerQueueHistory))
		throw new CheckpointError("Corrupt checkpoint: checkpoint.writerQueueHistory must be an array.");
	for (const [index, eventValue] of root.writerQueueHistory.entries()) {
		const event = object(eventValue, `checkpoint.writerQueueHistory[${index}]`);
		exact(event, ["workerId", "action", "at"], `checkpoint.writerQueueHistory[${index}]`);
		string(event.workerId, `checkpoint.writerQueueHistory[${index}].workerId`);
		string(event.action, `checkpoint.writerQueueHistory[${index}].action`);
		if (!["queued", "started", "removed"].includes(event.action))
			throw new CheckpointError(`Corrupt checkpoint: writer queue action is unknown.`);
		number(event.at, `checkpoint.writerQueueHistory[${index}].at`);
	}
	if (!Array.isArray(root.notes)) throw new CheckpointError("Corrupt checkpoint: checkpoint.notes must be an array.");
	root.notes.forEach((note, index) => {
		validateNote(note, `checkpoint.notes[${index}]`);
	});
	if (!Array.isArray(root.rooms)) throw new CheckpointError("Corrupt checkpoint: checkpoint.rooms must be an array.");
	for (const [index, roomValue] of root.rooms.entries()) {
		const room = object(roomValue, `checkpoint.rooms[${index}]`);
		exact(room, ["name", "posts"], `checkpoint.rooms[${index}]`);
		string(room.name, `checkpoint.rooms[${index}].name`);
		if (!Array.isArray(room.posts))
			throw new CheckpointError(`Corrupt checkpoint: checkpoint.rooms[${index}].posts must be an array.`);
		room.posts.forEach((post, postIndex) => {
			validatePost(post, `checkpoint.rooms[${index}].posts[${postIndex}]`);
		});
	}
	if (!Array.isArray(root.spreadCursors))
		throw new CheckpointError("Corrupt checkpoint: checkpoint.spreadCursors must be an array.");
	for (const [index, cursorValue] of root.spreadCursors.entries()) {
		const cursor = object(cursorValue, `checkpoint.spreadCursors[${index}]`);
		exact(cursor, ["tier", "cursor"], `checkpoint.spreadCursors[${index}]`);
		string(cursor.tier, `checkpoint.spreadCursors[${index}].tier`);
		if (!(TIERS as readonly string[]).includes(cursor.tier))
			throw new CheckpointError(`Corrupt checkpoint: checkpoint.spreadCursors[${index}].tier is unknown.`);
		number(cursor.cursor, `checkpoint.spreadCursors[${index}].cursor`);
	}
	optional(root.lastWriterBackend, (item) => string(item, "checkpoint.lastWriterBackend"));
	if (!Array.isArray(root.roomDebaterBackends))
		throw new CheckpointError("Corrupt checkpoint: checkpoint.roomDebaterBackends must be an array.");
	for (const [index, roomValue] of root.roomDebaterBackends.entries()) {
		const room = object(roomValue, `checkpoint.roomDebaterBackends[${index}]`);
		exact(room, ["room", "backends"], `checkpoint.roomDebaterBackends[${index}]`);
		string(room.room, `checkpoint.roomDebaterBackends[${index}].room`);
		strings(room.backends, `checkpoint.roomDebaterBackends[${index}].backends`);
	}
	return root as unknown as SessionCheckpoint;
}

export function readCheckpoint(id: string, agentDir: string): SessionCheckpoint {
	const path = checkpointPath(id, agentDir);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new CheckpointError(`Checkpoint "${id}" does not exist.`);
		throw new CheckpointError(`Checkpoint "${id}" is corrupt JSON. The original file was preserved.`);
	}
	const checkpoint = validateCheckpoint(parsed);
	if (checkpoint.id !== id)
		throw new CheckpointError(
			`Checkpoint file "${id}" contains id "${checkpoint.id}". The original file was preserved.`,
		);
	return checkpoint;
}

export interface CheckpointListEntry {
	id: string;
	path: string;
	checkpoint?: SessionCheckpoint;
	error?: string;
}

/** Durable checkpoints, newest valid checkpoint first; invalid files remain visible with an actionable error. */
export function listCheckpoints(agentDir: string): CheckpointListEntry[] {
	const dir = checkpointDir(agentDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name): CheckpointListEntry => {
			const id = name.slice(0, -".json".length);
			const path = join(dir, name);
			try {
				return { id, path, checkpoint: readCheckpoint(id, agentDir) };
			} catch (error) {
				return { id, path, error: error instanceof Error ? error.message : String(error) };
			}
		})
		.sort((left, right) => (right.checkpoint?.updatedAt ?? 0) - (left.checkpoint?.updatedAt ?? 0));
}

export function readCheckpointForHydration(id: string, agentDir: string): HydratableCheckpoint {
	const checkpoint = readCheckpoint(id, agentDir);
	if (checkpoint.liveLease && isSessionLeaseAlive(checkpoint.liveLease, agentDir)) {
		throw new CheckpointError(
			`Checkpoint "${id}" is still owned by live manager ${checkpoint.liveLease.managerId}; refusing unsafe hydration.`,
		);
	}
	return checkpoint as HydratableCheckpoint;
}

export function writeCheckpointAtomic(checkpoint: SessionCheckpoint, agentDir: string): string {
	validateCheckpoint(checkpoint);
	const dir = checkpointDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = checkpointPath(checkpoint.id, agentDir);
	if (existsSync(path)) readCheckpoint(checkpoint.id, agentDir);
	const temp = join(dir, `.${checkpoint.id}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	let handle: number | undefined;
	try {
		handle = openSync(temp, "wx", 0o600);
		writeSync(handle, `${JSON.stringify(checkpoint, null, 2)}\n`, undefined, "utf8");
		fsyncSync(handle);
		closeSync(handle);
		handle = undefined;
		renameSync(temp, path);
		chmodSync(path, 0o600);
		const directoryHandle = openSync(dir, "r");
		try {
			fsyncSync(directoryHandle);
		} finally {
			closeSync(directoryHandle);
		}
		return path;
	} finally {
		if (handle !== undefined) closeSync(handle);
		rmSync(temp, { force: true });
	}
}

/** Serialized, coalesced writes. Errors are reported but never escape into live orchestration. */
export class CheckpointWriter {
	private pending: SessionCheckpoint | undefined;
	private writing: Promise<void> | undefined;
	lastError: Error | undefined;
	private readonly agentDir: string;
	private readonly report: (message: string) => void;

	constructor(agentDir: string, report: (message: string) => void = (message) => console.error(`[neta] ${message}`)) {
		this.agentDir = agentDir;
		this.report = report;
	}

	schedule(checkpoint: SessionCheckpoint): void {
		this.pending = structuredClone(checkpoint);
		this.start();
	}

	private start(): void {
		if (this.writing) return;
		this.writing = Promise.resolve()
			.then(() => {
				while (this.pending) {
					const checkpoint = this.pending;
					this.pending = undefined;
					try {
						writeCheckpointAtomic(checkpoint, this.agentDir);
						this.lastError = undefined;
					} catch (error) {
						this.lastError = error instanceof Error ? error : new Error(String(error));
						this.report(`checkpoint ${checkpoint.id} was not saved: ${this.lastError.message}`);
					}
				}
			})
			.finally(() => {
				this.writing = undefined;
				if (this.pending) this.start();
			});
	}

	async flush(): Promise<void> {
		while (this.writing || this.pending) {
			this.start();
			await this.writing;
		}
	}
}

export function newCheckpointBase(options: {
	id: string;
	canonicalCwd: string;
	leaderBackend: string;
	leaderVendorConversationId?: string;
	liveLease?: CheckpointLiveLease;
	createdAt?: number;
}): Pick<
	SessionCheckpoint,
	"schemaVersion" | "appVersion" | "id" | "canonicalCwd" | "leader" | "createdAt" | "updatedAt" | "liveLease"
> {
	const now = options.createdAt ?? Date.now();
	return {
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		appVersion: VERSION,
		id: options.id,
		canonicalCwd: options.canonicalCwd,
		leader: { backend: options.leaderBackend, vendorConversationId: options.leaderVendorConversationId },
		createdAt: now,
		updatedAt: now,
		liveLease: options.liveLease,
	};
}
