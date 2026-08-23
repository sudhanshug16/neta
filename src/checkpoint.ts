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
	type SessionGoal,
	TIERS,
	type Tier,
	type WorkerLogEntry,
	type WorkerState,
	type WorkerUsage,
} from "./types.ts";

export const CHECKPOINT_SCHEMA_VERSION = 5;

/** Schemas this build understands. Anything else is a future file and is never rewritten. */
const READABLE_SCHEMA_VERSIONS = [1, 2, 3, 4, CHECKPOINT_SCHEMA_VERSION];

export interface CheckpointLiveLease {
	managerId: string;
	processStartedAt?: string;
}

/**
 * Proof that the processes of the previous run are gone.
 *
 * Resume is only safe once nothing from the old run can still write to the
 * repository. A graceful shutdown proves it by killing every worker and waiting
 * for the exits; a crash is proven afterwards by the recovery barrier, which
 * reaps the recorded process groups and verifies their death. Without one of
 * those two, `processesStopped` stays false and `neta resume` refuses.
 */
export interface CheckpointShutdown {
	at: number;
	processesStopped: boolean;
	/** Who established the proof: the manager itself, the stale-session sweep, or `neta resume`. */
	by: "graceful" | "sweep" | "recovery";
}

const SHUTDOWN_SOURCES = ["graceful", "sweep", "recovery"] as const;

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
	/** A turn that failed after the report in `finalResult`; kept beside it, never over it. */
	laterFailure?: string;
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
	cwd?: string;
	revivalCount?: number;
	/** True once a native vendor TUI was given exclusive ownership of this conversation. */
	nativeAttached?: boolean;
}

export interface SessionCheckpoint {
	schemaVersion: 5;
	appVersion: string;
	id: string;
	canonicalCwd: string;
	leader: { backend: string; vendorConversationId?: string };
	createdAt: number;
	updatedAt: number;
	liveLease?: CheckpointLiveLease;
	shutdown?: CheckpointShutdown;
	/**
	 * Worker tiers this session was launched with. Absent in every checkpoint
	 * written before startup tier selection existed, and read as the full ladder —
	 * which is what those sessions ran with. It is recorded rather than re-asked
	 * so a resume restores the session it saved instead of today's preference.
	 */
	sessionTiers?: Tier[];
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
	goal?: SessionGoal;
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

function integer(value: unknown, path: string): asserts value is number {
	number(value, path);
	if (!Number.isInteger(value)) throw new CheckpointError(`Corrupt checkpoint: ${path} must be an integer.`);
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
	"blocked",
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
			"laterFailure",
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
			"cwd",
			"revivalCount",
			"nativeAttached",
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
		if (item === "blocked" || item === "done" || item === "failed" || item === "killed" || item === "interrupted")
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
		"laterFailure",
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
		"cwd",
	])
		optional(worker[key], (item) => string(item, `${path}.${key}`));
	optional(worker.revivalCount, (item) => number(item, `${path}.revivalCount`));
	optional(worker.nativeAttached, (item) => boolean(item, `${path}.nativeAttached`));
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

function validateEvidenceRefs(value: unknown, path: string): void {
	strings(value, path);
}

function validateGoal(value: unknown, path: string): void {
	const goal = object(value, path);
	exact(
		goal,
		["originalIntent", "workingObjective", "revision", "discoveryPolicy", "status", "revisions", "discoveries"],
		path,
	);
	string(goal.originalIntent, `${path}.originalIntent`);
	string(goal.workingObjective, `${path}.workingObjective`);
	integer(goal.revision, `${path}.revision`);
	if (goal.revision < 0) throw new CheckpointError(`Corrupt checkpoint: ${path}.revision must not be negative.`);
	string(goal.discoveryPolicy, `${path}.discoveryPolicy`);
	if (goal.discoveryPolicy !== "allowed" && goal.discoveryPolicy !== "locked")
		throw new CheckpointError(`Corrupt checkpoint: ${path}.discoveryPolicy is unknown.`);
	string(goal.status, `${path}.status`);
	if (goal.status !== "active" && goal.status !== "complete" && goal.status !== "stopped")
		throw new CheckpointError(`Corrupt checkpoint: ${path}.status is unknown.`);
	if (!Array.isArray(goal.revisions))
		throw new CheckpointError(`Corrupt checkpoint: ${path}.revisions must be an array.`);
	for (const [index, value] of goal.revisions.entries()) {
		const revision = object(value, `${path}.revisions[${index}]`);
		exact(
			revision,
			["revision", "workingObjective", "reason", "evidenceRefs", "timestamp"],
			`${path}.revisions[${index}]`,
		);
		integer(revision.revision, `${path}.revisions[${index}].revision`);
		if (revision.revision < 0)
			throw new CheckpointError(`Corrupt checkpoint: ${path}.revisions[${index}].revision must not be negative.`);
		string(revision.workingObjective, `${path}.revisions[${index}].workingObjective`);
		string(revision.reason, `${path}.revisions[${index}].reason`);
		validateEvidenceRefs(revision.evidenceRefs, `${path}.revisions[${index}].evidenceRefs`);
		number(revision.timestamp, `${path}.revisions[${index}].timestamp`);
	}
	if (!Array.isArray(goal.discoveries))
		throw new CheckpointError(`Corrupt checkpoint: ${path}.discoveries must be an array.`);
	for (const [index, value] of goal.discoveries.entries()) {
		const discovery = object(value, `${path}.discoveries[${index}]`);
		exact(
			discovery,
			[
				"id",
				"workerId",
				"finding",
				"impact",
				"suggestion",
				"evidenceRefs",
				"status",
				"createdAt",
				"createdBy",
				"resolvedAt",
				"resolvedBy",
				"resolutionReason",
			],
			`${path}.discoveries[${index}]`,
		);
		string(discovery.id, `${path}.discoveries[${index}].id`);
		optional(discovery.workerId, (item) => string(item, `${path}.discoveries[${index}].workerId`));
		string(discovery.finding, `${path}.discoveries[${index}].finding`);
		string(discovery.impact, `${path}.discoveries[${index}].impact`);
		if (discovery.impact !== "local" && discovery.impact !== "goal")
			throw new CheckpointError(`Corrupt checkpoint: ${path}.discoveries[${index}].impact is unknown.`);
		optional(discovery.suggestion, (item) => string(item, `${path}.discoveries[${index}].suggestion`));
		optional(discovery.evidenceRefs, (item) =>
			validateEvidenceRefs(item, `${path}.discoveries[${index}].evidenceRefs`),
		);
		string(discovery.status, `${path}.discoveries[${index}].status`);
		if (!["pending", "accepted", "rejected"].includes(discovery.status))
			throw new CheckpointError(`Corrupt checkpoint: ${path}.discoveries[${index}].status is unknown.`);
		number(discovery.createdAt, `${path}.discoveries[${index}].createdAt`);
		optional(discovery.createdBy, (item) => string(item, `${path}.discoveries[${index}].createdBy`));
		optional(discovery.resolvedAt, (item) => number(item, `${path}.discoveries[${index}].resolvedAt`));
		optional(discovery.resolvedBy, (item) => string(item, `${path}.discoveries[${index}].resolvedBy`));
		optional(discovery.resolutionReason, (item) => string(item, `${path}.discoveries[${index}].resolutionReason`));
	}
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
			"shutdown",
			"sessionTiers",
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
			"goal",
		],
		"checkpoint",
	);
	if (typeof root.schemaVersion !== "number" || !READABLE_SCHEMA_VERSIONS.includes(root.schemaVersion)) {
		throw new CheckpointError(
			`Checkpoint schema version ${String(root.schemaVersion)} is not supported by this Neta version (supported versions: 1, 2, 3, 4, or 5). The original file was preserved.`,
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
	optional(root.shutdown, (item) => {
		const shutdown = object(item, "checkpoint.shutdown");
		exact(shutdown, ["at", "processesStopped", "by"], "checkpoint.shutdown");
		number(shutdown.at, "checkpoint.shutdown.at");
		boolean(shutdown.processesStopped, "checkpoint.shutdown.processesStopped");
		string(shutdown.by, "checkpoint.shutdown.by");
		if (!(SHUTDOWN_SOURCES as readonly string[]).includes(shutdown.by))
			throw new CheckpointError("Corrupt checkpoint: checkpoint.shutdown.by is unknown.");
	});
	optional(root.sessionTiers, (item) => {
		strings(item, "checkpoint.sessionTiers");
		for (const [index, tier] of item.entries()) {
			if (!(TIERS as readonly string[]).includes(tier))
				throw new CheckpointError(`Corrupt checkpoint: checkpoint.sessionTiers[${index}] is not a known tier.`);
		}
		// A session that may staff nothing cannot exist; a file claiming one is
		// corrupt, not a session with an unusual setting.
		if (item.length === 0) throw new CheckpointError("Corrupt checkpoint: checkpoint.sessionTiers is empty.");
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
	optional(root.goal, (item) => validateGoal(item, "checkpoint.goal"));
	// Schema 1 predates shutdown proof, and schemas 1 and 2 both predate startup
	// tier selection. A short-lived build accidentally wrote sessionTiers while
	// still claiming schema 2; accepting but ignoring that field keeps every v1/v2
	// checkpoint compatible with the full ladder and makes the v3 boundary honest.
	const sourceSchema = root.schemaVersion;
	const sessionTiers = sourceSchema >= 3 ? (root.sessionTiers as string[] | undefined) : undefined;
	const goal = sourceSchema >= 5 ? (root.goal as SessionGoal | undefined) : undefined;
	const workers = (root.workers as CheckpointWorker[]).map((worker) => ({
		...worker,
		// Schema 4 is the first version whose runtime understands that opening a
		// native TUI permanently prevents safe headless ownership claims.
		nativeAttached: sourceSchema >= 4 ? worker.nativeAttached : undefined,
	}));
	return {
		...root,
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		workers,
		// Stored order is not trusted; readers get the canonical ladder order.
		sessionTiers: sessionTiers ? TIERS.filter((tier) => sessionTiers.includes(tier)) : undefined,
		goal,
	} as unknown as SessionCheckpoint;
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

export function writeCheckpointAtomic(input: SessionCheckpoint, agentDir: string): string {
	const checkpoint = validateCheckpoint(input);
	const dir = checkpointDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = checkpointPath(checkpoint.id, agentDir);
	const release = acquireCheckpointLock(path);
	let temp: string | undefined;
	let handle: number | undefined;
	try {
		const current = existsSync(path) ? readCheckpoint(checkpoint.id, agentDir) : undefined;
		const merged = mergeCheckpointForAtomicWrite(checkpoint, current);
		temp = join(dir, `.${merged.id}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
		handle = openSync(temp, "wx", 0o600);
		writeSync(handle, `${JSON.stringify(merged, null, 2)}\n`, undefined, "utf8");
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
		if (temp !== undefined) rmSync(temp, { force: true });
		release();
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function acquireCheckpointLock(path: string): () => void {
	const lockPath = `${path}.lock`;
	const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
	let handle: number | undefined;
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		try {
			handle = openSync(lockPath, "wx", 0o600);
			writeSync(handle, `${process.pid}\n`, undefined, "utf8");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let ownerPid: number | undefined;
			try {
				const parsed = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
				if (Number.isInteger(parsed) && parsed > 0) ownerPid = parsed;
			} catch {
				// A just-created lock may not have its owner written yet.
			}
			if (ownerPid !== undefined && !processIsAlive(ownerPid)) {
				rmSync(lockPath, { force: true });
				continue;
			}
			Atomics.wait(waitBuffer, 0, 0, 1);
		}
	}
	if (handle === undefined) throw new CheckpointError(`Could not acquire checkpoint lock for ${path}.`);
	return () => {
		closeSync(handle as number);
		rmSync(lockPath, { force: true });
	};
}

function mergeCheckpointForAtomicWrite(
	checkpoint: SessionCheckpoint,
	current: SessionCheckpoint | undefined,
): SessionCheckpoint {
	if (!current) return checkpoint;
	const currentId = current.leader.vendorConversationId;
	const incomingId = checkpoint.leader.vendorConversationId;
	if (currentId && incomingId && currentId !== incomingId) {
		throw new CheckpointError(
			`Checkpoint "${checkpoint.id}" already records leader conversation ${currentId}; refusing to replace it with ${incomingId}.`,
		);
	}
	return {
		...checkpoint,
		// updatedAt is a monotonic write version. An external capture can advance
		// the file between a manager snapshot and its deferred flush.
		updatedAt: Math.max(checkpoint.updatedAt, current.updatedAt),
		leader: {
			...checkpoint.leader,
			vendorConversationId: currentId ?? incomingId,
		},
	};
}

export const CHECKPOINT_TRAILING_DEBOUNCE_MS = 100;
export const CHECKPOINT_HARD_DEADLINE_MS = 1_000;

type CheckpointSnapshotFactory = () => SessionCheckpoint;

export interface CheckpointWriterTimers {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}

const REAL_CHECKPOINT_TIMERS: CheckpointWriterTimers = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Serialized, coalesced writes. Errors are reported but never escape into live orchestration. */
export class CheckpointWriter {
	private pendingImmediate: SessionCheckpoint | undefined;
	private pendingDeferred: CheckpointSnapshotFactory | undefined;
	private pendingDeferredId: string | undefined;
	private writing: Promise<void> | undefined;
	private deferredTimer: unknown;
	private hardDeadlineTimer: unknown;
	lastError: Error | undefined;
	/** Attempted atomic writes, useful for deterministic diagnostics. */
	writeCount = 0;
	private readonly agentDir: string;
	private readonly report: (message: string) => void;
	private readonly timers: CheckpointWriterTimers;

	constructor(
		agentDir: string,
		report: (message: string) => void = (message) => console.error(`[neta] ${message}`),
		timers: CheckpointWriterTimers = REAL_CHECKPOINT_TIMERS,
	) {
		this.agentDir = agentDir;
		this.report = report;
		this.timers = timers;
	}

	schedule(checkpoint: SessionCheckpoint): void {
		this.cancelDeferredTimers();
		this.pendingDeferred = undefined;
		this.pendingDeferredId = undefined;
		this.pendingImmediate = structuredClone(checkpoint);
		this.start();
	}

	/** Queue telemetry without materializing the manager's large checkpoint yet. */
	scheduleDeferred(snapshot: CheckpointSnapshotFactory, checkpointId?: string): void {
		this.pendingDeferred = snapshot;
		this.pendingDeferredId = checkpointId;
		if (this.deferredTimer !== undefined) this.timers.clearTimeout(this.deferredTimer);
		this.deferredTimer = this.timers.setTimeout(() => {
			this.deferredTimer = undefined;
			if (this.hardDeadlineTimer !== undefined) this.timers.clearTimeout(this.hardDeadlineTimer);
			this.hardDeadlineTimer = undefined;
			this.start();
		}, CHECKPOINT_TRAILING_DEBOUNCE_MS);
		if (this.hardDeadlineTimer === undefined) {
			this.hardDeadlineTimer = this.timers.setTimeout(() => {
				this.hardDeadlineTimer = undefined;
				if (this.deferredTimer !== undefined) this.timers.clearTimeout(this.deferredTimer);
				this.deferredTimer = undefined;
				this.start();
			}, CHECKPOINT_HARD_DEADLINE_MS);
		}
	}

	private cancelDeferredTimers(): void {
		if (this.deferredTimer !== undefined) this.timers.clearTimeout(this.deferredTimer);
		if (this.hardDeadlineTimer !== undefined) this.timers.clearTimeout(this.hardDeadlineTimer);
		this.deferredTimer = undefined;
		this.hardDeadlineTimer = undefined;
	}

	private start(): void {
		if (this.writing) return;
		this.writing = Promise.resolve()
			.then(() => {
				while (this.pendingImmediate || this.pendingDeferred) {
					const immediate = this.pendingImmediate;
					this.pendingImmediate = undefined;
					const deferred = this.pendingDeferred;
					this.pendingDeferred = undefined;
					const checkpointId = immediate?.id ?? this.pendingDeferredId ?? "unknown";
					this.pendingDeferredId = undefined;
					try {
						const checkpoint = immediate ?? deferred?.();
						if (!checkpoint) continue;
						this.writeCount += 1;
						writeCheckpointAtomic(checkpoint, this.agentDir);
						this.lastError = undefined;
					} catch (error) {
						this.lastError = error instanceof Error ? error : new Error(String(error));
						this.report(`checkpoint ${checkpointId} was not saved: ${this.lastError.message}`);
					}
				}
			})
			.finally(() => {
				this.writing = undefined;
				if (this.pendingImmediate || this.pendingDeferred) this.start();
			});
	}

	async flush(): Promise<void> {
		this.cancelDeferredTimers();
		while (this.writing || this.pendingImmediate || this.pendingDeferred) {
			this.start();
			const writing = this.writing;
			if (writing) await writing;
		}
	}

	async dispose(): Promise<void> {
		await this.flush();
	}

	/**
	 * Write the first checkpoint of a run durably, and let failure escape.
	 *
	 * Every later write is best-effort on purpose: a full disk must not take down
	 * a session that is already orchestrating work. The first one is different.
	 * It is what records the live lease — which manager owns this session, and
	 * which worker groups belong to it — and the control plane registers itself
	 * and releases the launch lock on the strength of it. Reporting a failure and
	 * carrying on there would publish a manager whose ownership nothing durable
	 * records, and hand the next `neta resume` a checkpoint it believes is free
	 * while the old processes may still be running.
	 */
	async writeDurable(checkpoint: SessionCheckpoint): Promise<void> {
		// This snapshot supersedes anything queued behind it; a queued write that
		// is already in flight still finishes first, so the file is never written
		// out of order.
		this.cancelDeferredTimers();
		this.pendingImmediate = undefined;
		this.pendingDeferred = undefined;
		this.pendingDeferredId = undefined;
		await this.writing;
		writeCheckpointAtomic(checkpoint, this.agentDir);
		this.lastError = undefined;
	}
}

export function newCheckpointBase(options: {
	id: string;
	canonicalCwd: string;
	leaderBackend: string;
	leaderVendorConversationId?: string;
	liveLease?: CheckpointLiveLease;
	shutdown?: CheckpointShutdown;
	createdAt?: number;
}): Pick<
	SessionCheckpoint,
	| "schemaVersion"
	| "appVersion"
	| "id"
	| "canonicalCwd"
	| "leader"
	| "createdAt"
	| "updatedAt"
	| "liveLease"
	| "shutdown"
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
		shutdown: options.shutdown,
	};
}

/** An empty checkpoint, so a session's identity is durable before its vendor CLI starts. */
export function emptySessionCheckpoint(options: {
	id: string;
	canonicalCwd: string;
	leaderBackend: string;
	leaderVendorConversationId?: string;
	createdAt?: number;
	/** Tiers the startup preflight settled on. Omitted means the full ladder. */
	sessionTiers?: readonly Tier[];
}): SessionCheckpoint {
	return {
		...newCheckpointBase(options),
		...(options.sessionTiers ? { sessionTiers: TIERS.filter((tier) => options.sessionTiers?.includes(tier)) } : {}),
		counter: 0,
		noteCounter: 0,
		workers: [],
		writerQueue: [],
		writerQueueHistory: [],
		notes: [],
		rooms: [],
		spreadCursors: [],
		roomDebaterBackends: [],
		goal: undefined,
	};
}

/**
 * Read, change, and rewrite one checkpoint atomically.
 *
 * Every mutation outside the owning manager goes through here, so a corrupt or
 * future-schema file is read, rejected, and left exactly as it was. A mutator
 * that returns undefined declines the write.
 */
export function updateCheckpoint(
	id: string,
	agentDir: string,
	mutate: (checkpoint: SessionCheckpoint) => SessionCheckpoint | undefined,
): SessionCheckpoint | undefined {
	const next = mutate(readCheckpoint(id, agentDir));
	if (!next) return undefined;
	writeCheckpointAtomic({ ...next, updatedAt: Date.now() }, agentDir);
	return next;
}

/**
 * Record that the run owning this checkpoint is over and its processes are gone.
 * Only the manager named by the live lease may be proven stopped, so a sweep can
 * never retire a successor's lease.
 */
export function recordCheckpointStopped(
	id: string,
	agentDir: string,
	by: CheckpointShutdown["by"],
	managerId?: string,
): SessionCheckpoint | undefined {
	return updateCheckpoint(id, agentDir, (checkpoint) => {
		if (managerId && checkpoint.liveLease && checkpoint.liveLease.managerId !== managerId) return undefined;
		return { ...checkpoint, liveLease: undefined, shutdown: { at: Date.now(), processesStopped: true, by } };
	});
}

/**
 * Persist the leader's exact vendor conversation id.
 *
 * Codex reports its id through a SessionStart hook, which runs in its own short
 * process, so this write happens outside the control plane. It is refused when
 * the checkpoint already carries a different id: a captured conversation id is
 * the one thing resume cannot guess, and silently replacing it would point a
 * later resume at the wrong conversation.
 */
export function recordLeaderVendorConversationId(
	id: string,
	agentDir: string,
	vendorConversationId: string,
): SessionCheckpoint | undefined {
	return updateCheckpoint(id, agentDir, (checkpoint) => {
		const existing = checkpoint.leader.vendorConversationId;
		if (existing === vendorConversationId) return undefined;
		if (existing) {
			throw new CheckpointError(
				`Checkpoint "${id}" already records leader conversation ${existing}; refusing to replace it with ${vendorConversationId}.`,
			);
		}
		return { ...checkpoint, leader: { ...checkpoint.leader, vendorConversationId } };
	});
}

/**
 * The stable per-session directory a leader's generated vendor state lives in.
 *
 * Codex records the absolute path of a session's rollout file in its own thread
 * index. When Neta built the Codex home under the per-run temporary directory,
 * that recorded path stopped existing the moment the session ended, and
 * `codex resume <id>` failed even though the transcript itself was safe in the
 * real Codex home. This path is owned by Neta, keyed by the logical session, and
 * outlives every run of it.
 */
export function leaderSessionDir(id: string, agentDir: string): string {
	safeId(id);
	return join(agentDir, "leader-sessions", id);
}

export function ensureLeaderSessionDir(id: string, agentDir: string): string {
	const dir = leaderSessionDir(id, agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

/**
 * Where a vendor's session-start hook or plugin records the id it assigned.
 * Shared with the adapters, because some vendors write it themselves.
 */
export function vendorSessionCapturePath(sessionDir: string): string {
	return join(sessionDir, "vendor-session.json");
}

/** A capture that could not be written; surfaced by the control plane, never swallowed. */
export function vendorSessionCaptureErrorPath(sessionDir: string): string {
	return join(sessionDir, "vendor-session.error");
}

function vendorCapturePath(id: string, agentDir: string): string {
	return vendorSessionCapturePath(leaderSessionDir(id, agentDir));
}

/** Written by the vendor's own session-start hook, read by the control plane. */
export function writeVendorSessionCapture(id: string, agentDir: string, vendorConversationId: string): string {
	ensureLeaderSessionDir(id, agentDir);
	const path = vendorCapturePath(id, agentDir);
	const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = openSync(temp, "wx", 0o600);
	try {
		writeSync(handle, `${JSON.stringify({ vendorConversationId, at: Date.now() })}\n`, undefined, "utf8");
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	renameSync(temp, path);
	return path;
}

export function readVendorSessionCapture(id: string, agentDir: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(vendorCapturePath(id, agentDir), "utf8")) as {
			vendorConversationId?: unknown;
		};
		return typeof parsed.vendorConversationId === "string" && parsed.vendorConversationId
			? parsed.vendorConversationId
			: undefined;
	} catch {
		return undefined;
	}
}

/** What a vendor's capture reported going wrong, if anything did. */
export function readVendorSessionCaptureError(id: string, agentDir: string): string | undefined {
	try {
		const text = readFileSync(vendorSessionCaptureErrorPath(leaderSessionDir(id, agentDir)), "utf8").trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}
