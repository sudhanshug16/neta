/**
 * Content-addressed, delta-oriented storage for durable session state.
 *
 * The v6 root is intentionally small: it contains structural state, current
 * active worker refs, and a fixed set of terminal-index shard hashes. Terminal
 * records are never copied into the root.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { CheckpointWorker, HydratableCheckpoint, SessionCheckpoint } from "./checkpoint.ts";
import { readCheckpoint, validateCheckpoint } from "./checkpoint.ts";
import { isSessionLeaseAlive } from "./session.ts";
import { isTerminalState, type WorkerState } from "./types.ts";

export const CHECKPOINT_STORE_FORMAT_VERSION = 6 as const;
export const V6_FORMAT_VERSION = CHECKPOINT_STORE_FORMAT_VERSION;
export const V6_MANIFEST_FILE = "manifest.json";
export const TERMINAL_INDEX_SHARD_COUNT = 64 as const;

type BlobKind = "active" | "terminal" | "outcome";

export interface V6BlobRef {
	kind: BlobKind;
	sha256: string;
}

export interface V6DetailSegmentRef {
	sequence: number;
	byteLength: number;
	sha256: string;
	optional?: boolean;
	/** Delta-written segments use their content hash as the path. */
	path?: string;
}

export interface V6WorkerRef {
	id: string;
	active: V6BlobRef;
	terminal?: V6BlobRef;
	outcome?: V6BlobRef;
	detailSegments: V6DetailSegmentRef[];
	terminalDetailSegments: V6DetailSegmentRef[];
}

export interface V6TerminalSummary {
	id: string;
	name: string;
	role: string;
	tier: CheckpointWorker["tier"];
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
	stateBeforeStop?: "starting" | "running" | "waiting" | "queued";
}

export interface V6TerminalIndexEntry {
	id: string;
	ref: V6WorkerRef & { terminal: V6BlobRef; outcome: V6BlobRef };
	summary: V6TerminalSummary;
}

export interface V6ActiveWorkerRef extends V6WorkerRef {
	terminal?: undefined;
	outcome?: undefined;
}

/** The only JSON file that gives a v6 store meaning. */
export interface V6Manifest {
	formatVersion: 6;
	id: string;
	state: string;
	activeWorkers: V6ActiveWorkerRef[];
	terminalIndexShards: string[];
	checksum: string;
	/** Compatibility view for callers written against the first v6 draft. */
	readonly workers: V6WorkerRef[];
}

export type V6CheckpointState = Omit<SessionCheckpoint, "workers">;

export interface V6WorkerDelta {
	worker: CheckpointWorker;
	/** A terminal delta publishes the immutable terminal artifacts and index entry. */
	terminal: boolean;
}

export interface V6CheckpointDelta {
	id: string;
	state?: V6CheckpointState;
	workers: V6WorkerDelta[];
}

export interface V6ReadWarning {
	workerId: string;
	sequence: number;
	message: string;
}

export interface V6ReadCounters {
	manifestReads?: number;
	stateReads?: number;
	blobReads?: number;
	detailReads?: number;
	terminalArtifactReads?: number;
	terminalDetailReads?: number;
	shardReads?: number;
}

export interface V6WriteCounters {
	serializedBytes?: number;
	writtenBytes?: number;
	manifestWrites?: number;
	activeArtifactWrites?: number;
	terminalArtifactWrites?: number;
	activeDetailWrites?: number;
	terminalDetailWrites?: number;
	terminalShardWrites?: number;
	terminalIndexEntriesVisited?: number;
	activeWorkerIterations?: number;
}

export interface V6FaultHooks {
	/** Called immediately before each fs operation named by the event. */
	fail?: (event: V6FaultEvent) => void;
	counters?: V6WriteCounters;
}

export type V6FaultEvent =
	| { type: "artifact-write"; path: string }
	| { type: "artifact-fsync"; path: string }
	| { type: "manifest-write"; path: string }
	| { type: "manifest-fsync"; path: string }
	| { type: "manifest-rename"; from: string; to: string }
	| { type: "manifest-parent-fsync"; path: string }
	| { type: "store-rename"; from: string; to: string };

export interface V6MigrationResult {
	storePath: string;
	published: boolean;
	alreadyMigrated: boolean;
}

export class CheckpointStoreError extends Error {}

function fail(hooks: V6FaultHooks | undefined, event: V6FaultEvent): void {
	hooks?.fail?.(event);
}

function safePart(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new CheckpointStoreError(`Invalid ${label} "${value}".`);
}

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): Uint8Array {
	return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function parseJson(bytes: Buffer, path: string): unknown {
	try {
		return JSON.parse(bytes.toString("utf8")) as unknown;
	} catch {
		throw new CheckpointStoreError(`Corrupt v6 artifact ${path}: invalid JSON.`);
	}
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new CheckpointStoreError(`Corrupt v6 ${path}: expected an object.`);
	return value as Record<string, unknown>;
}

function string(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string") throw new CheckpointStoreError(`Corrupt v6 ${path}: expected a string.`);
}

function integer(value: unknown, path: string): asserts value is number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new CheckpointStoreError(`Corrupt v6 ${path}: expected a non-negative integer.`);
}

function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
	const unexpected = Object.keys(value).find((key) => !fields.includes(key));
	if (unexpected) throw new CheckpointStoreError(`Corrupt v6 ${path}: unexpected field ${unexpected}.`);
}

function validateHash(value: unknown, path: string): asserts value is string {
	string(value, path);
	if (!/^[a-f0-9]{64}$/.test(value)) throw new CheckpointStoreError(`Corrupt v6 ${path}: invalid SHA-256.`);
}

function validateBlobRef(value: unknown, path: string): V6BlobRef {
	const ref = object(value, path);
	exact(ref, ["kind", "sha256"], path);
	string(ref.kind, `${path}.kind`);
	if (!(["active", "terminal", "outcome"] as readonly string[]).includes(ref.kind))
		throw new CheckpointStoreError(`Corrupt v6 ${path}.kind: unknown blob kind.`);
	validateHash(ref.sha256, `${path}.sha256`);
	return { kind: ref.kind as BlobKind, sha256: ref.sha256 };
}

function validateSegment(value: unknown, path: string): V6DetailSegmentRef {
	const segment = object(value, path);
	exact(segment, ["sequence", "byteLength", "sha256", "optional", "path"], path);
	integer(segment.sequence, `${path}.sequence`);
	integer(segment.byteLength, `${path}.byteLength`);
	validateHash(segment.sha256, `${path}.sha256`);
	if (segment.optional !== undefined && typeof segment.optional !== "boolean")
		throw new CheckpointStoreError(`Corrupt v6 ${path}.optional: expected a boolean.`);
	if (segment.path !== undefined) {
		string(segment.path, `${path}.path`);
		if (!/^[a-f0-9]{64}\.json$/.test(segment.path))
			throw new CheckpointStoreError(`Corrupt v6 ${path}.path: invalid content-addressed path.`);
	}
	return {
		sequence: segment.sequence,
		byteLength: segment.byteLength,
		sha256: segment.sha256,
		...(segment.optional === undefined ? {} : { optional: segment.optional }),
		...(segment.path === undefined ? {} : { path: segment.path }),
	};
}

function validateWorkerRef(value: unknown, path: string, terminal: boolean): V6WorkerRef {
	const worker = object(value, path);
	exact(worker, ["id", "active", "terminal", "outcome", "detailSegments", "terminalDetailSegments"], path);
	string(worker.id, `${path}.id`);
	safePart(worker.id, "worker id");
	if (!Array.isArray(worker.detailSegments) || !Array.isArray(worker.terminalDetailSegments))
		throw new CheckpointStoreError(`Corrupt v6 ${path}: detail segments must be arrays.`);
	const details = worker.detailSegments.map((entry, index) =>
		validateSegment(entry, `${path}.detailSegments[${index}]`),
	);
	const terminalDetails = worker.terminalDetailSegments.map((entry, index) =>
		validateSegment(entry, `${path}.terminalDetailSegments[${index}]`),
	);
	for (const [segments, label] of [
		[details, "detailSegments"],
		[terminalDetails, "terminalDetailSegments"],
	] as const) {
		segments.forEach((segment, sequence) => {
			if (segment.sequence !== sequence)
				throw new CheckpointStoreError(`Corrupt v6 ${path}.${label}: sequence is not contiguous.`);
		});
	}
	const active = validateBlobRef(worker.active, `${path}.active`);
	if (active.kind !== "active") throw new CheckpointStoreError(`Corrupt v6 ${path}.active: wrong blob kind.`);
	const terminalRef = worker.terminal === undefined ? undefined : validateBlobRef(worker.terminal, `${path}.terminal`);
	const outcome = worker.outcome === undefined ? undefined : validateBlobRef(worker.outcome, `${path}.outcome`);
	if (terminal && (!terminalRef || terminalRef.kind !== "terminal" || !outcome || outcome.kind !== "outcome"))
		throw new CheckpointStoreError(`Corrupt v6 ${path}: terminal refs are incomplete.`);
	if (!terminal && (terminalRef || outcome))
		throw new CheckpointStoreError(`Corrupt v6 ${path}: active ref has terminal blobs.`);
	return {
		id: worker.id,
		active,
		...(terminalRef ? { terminal: terminalRef } : {}),
		...(outcome ? { outcome } : {}),
		detailSegments: details,
		terminalDetailSegments: terminalDetails,
	};
}

function validateSummary(value: unknown, path: string): V6TerminalSummary {
	const summary = object(value, path);
	exact(
		summary,
		[
			"id",
			"name",
			"role",
			"tier",
			"backend",
			"writer",
			"room",
			"taskPreview",
			"resultPreview",
			"laterFailurePreview",
			"pendingQuestionPreview",
			"lastProgress",
			"state",
			"startedAt",
			"endedAt",
			"stateBeforeStop",
		],
		path,
	);
	for (const key of ["id", "name", "role", "tier", "backend", "taskPreview", "state"] as const)
		string(summary[key], `${path}.${key}`);
	if (typeof summary.writer !== "boolean")
		throw new CheckpointStoreError(`Corrupt v6 ${path}.writer: expected a boolean.`);
	for (const key of ["room", "resultPreview", "laterFailurePreview", "pendingQuestionPreview"] as const)
		if (summary[key] !== undefined) string(summary[key], `${path}.${key}`);
	if (summary.lastProgress !== undefined) {
		const progress = object(summary.lastProgress, `${path}.lastProgress`);
		exact(progress, ["text", "at"], `${path}.lastProgress`);
		string(progress.text, `${path}.lastProgress.text`);
		numberFinite(progress.at, `${path}.lastProgress.at`);
	}
	numberFinite(summary.startedAt, `${path}.startedAt`);
	if (summary.endedAt !== undefined) numberFinite(summary.endedAt, `${path}.endedAt`);
	if (summary.stateBeforeStop !== undefined) string(summary.stateBeforeStop, `${path}.stateBeforeStop`);
	return summary as unknown as V6TerminalSummary;
}

function numberFinite(value: unknown, path: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new CheckpointStoreError(`Corrupt v6 ${path}: expected a number.`);
}

interface V6TerminalIndexShard {
	formatVersion: 6;
	bucket: number;
	entries: V6TerminalIndexEntry[];
	checksum: string;
}

function validateShard(value: unknown, expectedBucket: number): V6TerminalIndexShard {
	const shard = object(value, `terminal shard ${expectedBucket}`);
	exact(shard, ["formatVersion", "bucket", "entries", "checksum"], `terminal shard ${expectedBucket}`);
	if (shard.formatVersion !== 6 || shard.bucket !== expectedBucket)
		throw new CheckpointStoreError(`Corrupt v6 terminal shard ${expectedBucket}: header mismatch.`);
	validateHash(shard.checksum, `terminal shard ${expectedBucket}.checksum`);
	const rawUnsigned = { formatVersion: 6 as const, bucket: expectedBucket, entries: shard.entries };
	if (hash(canonical(rawUnsigned)) !== shard.checksum)
		throw new CheckpointStoreError(`Corrupt v6 terminal shard ${expectedBucket}: checksum mismatch.`);
	if (!Array.isArray(shard.entries))
		throw new CheckpointStoreError(`Corrupt v6 terminal shard ${expectedBucket}: entries.`);
	const entries = shard.entries.map((entry, index) => {
		const item = object(entry, `terminal shard ${expectedBucket}.entries[${index}]`);
		exact(item, ["id", "ref", "summary"], `terminal shard ${expectedBucket}.entries[${index}]`);
		string(item.id, `terminal shard ${expectedBucket}.entries[${index}].id`);
		const ref = validateWorkerRef(
			item.ref,
			`terminal shard ${expectedBucket}.entries[${index}].ref`,
			true,
		) as V6TerminalIndexEntry["ref"];
		const summary = validateSummary(item.summary, `terminal shard ${expectedBucket}.entries[${index}].summary`);
		if (summary.id !== item.id || ref.id !== item.id)
			throw new CheckpointStoreError(`Corrupt v6 terminal shard ${expectedBucket}: id mismatch.`);
		return { id: item.id, ref, summary };
	});
	if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
		throw new CheckpointStoreError(`Corrupt v6 terminal shard ${expectedBucket}: duplicate worker id.`);
	return { formatVersion: 6, bucket: expectedBucket, entries, checksum: shard.checksum };
}

export function validateV6Manifest(value: unknown): V6Manifest {
	const manifest = object(value, "manifest");
	exact(
		manifest,
		["formatVersion", "id", "state", "activeWorkers", "terminalIndexShards", "checksum", "workers"],
		"manifest",
	);
	if (manifest.formatVersion !== 6)
		throw new CheckpointStoreError(`Unsupported v6 format version ${String(manifest.formatVersion)}.`);
	string(manifest.id, "manifest.id");
	safePart(manifest.id, "checkpoint id");
	validateHash(manifest.state, "manifest.state");
	if (!Array.isArray(manifest.activeWorkers)) throw new CheckpointStoreError("Corrupt v6 manifest.activeWorkers.");
	const activeWorkers = manifest.activeWorkers.map(
		(entry, index) => validateWorkerRef(entry, `manifest.activeWorkers[${index}]`, false) as V6ActiveWorkerRef,
	);
	if (new Set(activeWorkers.map((worker) => worker.id)).size !== activeWorkers.length)
		throw new CheckpointStoreError("Corrupt v6 manifest: duplicate active worker id.");
	if (
		!Array.isArray(manifest.terminalIndexShards) ||
		manifest.terminalIndexShards.length !== TERMINAL_INDEX_SHARD_COUNT
	)
		throw new CheckpointStoreError(
			`Corrupt v6 manifest: expected ${TERMINAL_INDEX_SHARD_COUNT} terminal shard hashes.`,
		);
	for (const [index, shard] of manifest.terminalIndexShards.entries())
		validateHash(shard, `manifest.terminalIndexShards[${index}]`);
	validateHash(manifest.checksum, "manifest.checksum");
	const unsigned = { formatVersion: 6 as const, id: manifest.id, state: manifest.state, activeWorkers };
	const completeUnsigned = { ...unsigned, terminalIndexShards: manifest.terminalIndexShards };
	if (hash(canonical(completeUnsigned)) !== manifest.checksum)
		throw new CheckpointStoreError("Corrupt v6 manifest: checksum mismatch.");
	return { ...completeUnsigned, checksum: manifest.checksum, workers: activeWorkers };
}

export function v6CheckpointStorePath(id: string, agentDir: string): string {
	safePart(id, "checkpoint id");
	return join(agentDir, "checkpoints-v6", id);
}

export const checkpointStorePath = v6CheckpointStorePath;

export function v6ManifestPath(storePath: string): string {
	return join(storePath, V6_MANIFEST_FILE);
}

function blobPath(storePath: string, sha256: string): string {
	return join(storePath, "blobs", `${sha256}.json`);
}
function shardPath(storePath: string, sha256: string): string {
	return join(storePath, "shards", `${sha256}.json`);
}
function legacySegmentPath(storePath: string, workerId: string, sequence: number, terminal: boolean): string {
	return join(storePath, "segments", workerId, `${terminal ? "terminal-" : ""}${sequence}.json`);
}
function contentSegmentPath(storePath: string, sha256: string): string {
	return join(storePath, "segments", `${sha256}.json`);
}

function fsyncDirectory(
	path: string,
	type: "manifest-parent-fsync" | "artifact-fsync",
	hooks: V6FaultHooks | undefined,
): void {
	fail(hooks, { type, path });
	const handle = openSync(path, "r");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

function writeNew(
	path: string,
	bytes: Uint8Array,
	event: "artifact-write" | "manifest-write",
	hooks: V6FaultHooks | undefined,
): void {
	fail(hooks, { type: event, path });
	const counters = hooks?.counters;
	if (counters) {
		counters.serializedBytes = (counters.serializedBytes ?? 0) + bytes.byteLength;
		counters.writtenBytes = (counters.writtenBytes ?? 0) + bytes.byteLength;
		if (event === "manifest-write") counters.manifestWrites = (counters.manifestWrites ?? 0) + 1;
	}
	const handle = openSync(path, "wx", 0o600);
	try {
		writeSync(handle, bytes);
		fail(hooks, { type: event === "artifact-write" ? "artifact-fsync" : "manifest-fsync", path });
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

function writeImmutable(path: string, bytes: Uint8Array, hooks: V6FaultHooks | undefined): boolean {
	try {
		const current = readFileSync(path);
		if (!current.equals(Buffer.from(bytes))) throw new CheckpointStoreError(`Immutable artifact changed at ${path}.`);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	writeNew(path, bytes, "artifact-write", hooks);
	return true;
}

function readArtifact(storePath: string, sha256: string, counters?: V6ReadCounters, terminal = false): unknown {
	if (counters) {
		counters.blobReads = (counters.blobReads ?? 0) + 1;
		if (terminal) counters.terminalArtifactReads = (counters.terminalArtifactReads ?? 0) + 1;
	}
	const path = blobPath(storePath, sha256);
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch {
		throw new CheckpointStoreError(`Missing referenced v6 blob ${sha256}.`);
	}
	if (hash(bytes) !== sha256) throw new CheckpointStoreError(`Corrupt referenced v6 blob ${sha256}.`);
	return parseJson(bytes, path);
}

function readBlob(
	storePath: string,
	reference: V6BlobRef | undefined,
	expectedKind: BlobKind,
	workerId: string,
	counters?: V6ReadCounters,
): Record<string, unknown> {
	if (!reference || reference.kind !== expectedKind)
		throw new CheckpointStoreError(`Corrupt v6 manifest worker ${workerId}: missing ${expectedKind} blob reference.`);
	return object(
		readArtifact(storePath, reference.sha256, counters, expectedKind !== "active"),
		`${workerId} ${expectedKind} blob`,
	);
}

function segmentFile(storePath: string, workerId: string, segment: V6DetailSegmentRef, terminal: boolean): string {
	return segment.path
		? join(storePath, "segments", segment.path)
		: legacySegmentPath(storePath, workerId, segment.sequence, terminal);
}

function readSegment(
	storePath: string,
	workerId: string,
	segment: V6DetailSegmentRef,
	terminal: boolean,
	counters?: V6ReadCounters,
): unknown[] {
	if (counters) {
		counters.detailReads = (counters.detailReads ?? 0) + 1;
		if (terminal) counters.terminalDetailReads = (counters.terminalDetailReads ?? 0) + 1;
	}
	const path = segmentFile(storePath, workerId, segment, terminal);
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch {
		throw new CheckpointStoreError(`Missing referenced v6 detail segment ${workerId}/${segment.sequence}.`);
	}
	if (bytes.byteLength !== segment.byteLength || hash(bytes) !== segment.sha256)
		throw new CheckpointStoreError(`Corrupt referenced v6 detail segment ${workerId}/${segment.sequence}.`);
	const parsed = parseJson(bytes, path);
	if (!Array.isArray(parsed)) throw new CheckpointStoreError(`Corrupt v6 detail segment ${path}: expected an array.`);
	return parsed;
}

function artifact(value: unknown): { bytes: Uint8Array; sha256: string } {
	const bytes = canonical(value);
	return { bytes, sha256: hash(bytes) };
}

function activeWorker(worker: CheckpointWorker): Record<string, unknown> {
	const {
		stateBeforeStop: _stateBeforeStop,
		endedAt: _endedAt,
		finalResult: _finalResult,
		substantiveResponse: _substantiveResponse,
		lastResponse: _lastResponse,
		laterFailure: _laterFailure,
		log: _log,
		pendingQuestion: _pendingQuestion,
		...active
	} = worker;
	return active;
}

function terminalWorker(worker: CheckpointWorker): Record<string, unknown> {
	return {
		state: worker.state,
		...(worker.finalResult === undefined ? {} : { finalResult: worker.finalResult }),
		...(worker.laterFailure === undefined ? {} : { laterFailure: worker.laterFailure }),
		...(worker.lastResponse === undefined ? {} : { lastResponse: worker.lastResponse }),
		...(worker.stateBeforeStop === undefined ? {} : { stateBeforeStop: worker.stateBeforeStop }),
		...(worker.endedAt === undefined ? {} : { endedAt: worker.endedAt }),
		...(worker.pendingQuestion === undefined ? {} : { pendingQuestion: worker.pendingQuestion }),
	};
}

function outcomeWorker(worker: CheckpointWorker): Record<string, unknown> {
	return {
		...(worker.task === undefined ? {} : { task: worker.task }),
		...(worker.finalResult === undefined ? {} : { finalResult: worker.finalResult }),
		...(worker.substantiveResponse === undefined ? {} : { substantiveResponse: worker.substantiveResponse }),
		...(worker.lastResponse === undefined ? {} : { lastResponse: worker.lastResponse }),
		...(worker.laterFailure === undefined ? {} : { laterFailure: worker.laterFailure }),
		...(worker.pendingQuestion === undefined ? {} : { pendingQuestion: worker.pendingQuestion }),
	};
}

function stateWithoutWorkers(checkpoint: SessionCheckpoint): V6CheckpointState {
	const { workers: _workers, ...state } = checkpoint;
	return state;
}

function clipped(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= 512 ? flat : `${flat.slice(0, 509).trimEnd()}...`;
}

function terminalSummary(worker: CheckpointWorker): V6TerminalSummary {
	return {
		id: clipped(worker.id) ?? "",
		name: clipped(worker.name) ?? "",
		role: clipped(worker.role) ?? "",
		tier: worker.tier,
		backend: clipped(worker.backend) ?? "",
		writer: worker.writer,
		room: clipped(worker.room),
		taskPreview: clipped(worker.task) ?? "",
		resultPreview: clipped(worker.finalResult),
		laterFailurePreview: clipped(worker.laterFailure),
		pendingQuestionPreview: clipped(worker.pendingQuestion),
		lastProgress: worker.lastProgress
			? { text: clipped(worker.lastProgress.text) ?? "", at: worker.lastProgress.at }
			: undefined,
		state: worker.state,
		startedAt: worker.startedAt,
		endedAt: worker.endedAt,
		stateBeforeStop: worker.stateBeforeStop,
	};
}

function writeSegment(
	storePath: string,
	workerId: string,
	sequence: number,
	entries: unknown[],
	terminal: boolean,
	hooks: V6FaultHooks | undefined,
	optional = false,
	contentAddressed = false,
): V6DetailSegmentRef {
	const built = artifact(entries);
	const path = contentAddressed
		? contentSegmentPath(storePath, built.sha256)
		: legacySegmentPath(storePath, workerId, sequence, terminal);
	const wrote = writeImmutable(path, built.bytes, hooks);
	if (wrote && hooks?.counters) {
		if (terminal) hooks.counters.terminalDetailWrites = (hooks.counters.terminalDetailWrites ?? 0) + 1;
		else hooks.counters.activeDetailWrites = (hooks.counters.activeDetailWrites ?? 0) + 1;
	}
	return {
		sequence,
		byteLength: built.bytes.byteLength,
		sha256: built.sha256,
		...(optional ? { optional: true } : {}),
		...(contentAddressed ? { path: `${built.sha256}.json` } : {}),
	};
}

function publishManifest(
	storePath: string,
	manifest: Omit<V6Manifest, "workers"> & { checksum: string },
	hooks: V6FaultHooks | undefined,
): void {
	const path = v6ManifestPath(storePath);
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const { workers: _workers, ...jsonManifest } = manifest as V6Manifest;
	const bytes = canonical(jsonManifest);
	try {
		writeNew(temporary, bytes, "manifest-write", hooks);
		fail(hooks, { type: "manifest-rename", from: temporary, to: path });
		renameSync(temporary, path);
		fsyncDirectory(storePath, "manifest-parent-fsync", hooks);
	} finally {
		// A failed publication leaves the temp file as a recoverable diagnostic.
	}
}

function emptyShard(bucket: number): { bytes: Uint8Array; sha256: string; shard: V6TerminalIndexShard } {
	const unsigned = { formatVersion: 6 as const, bucket, entries: [] as V6TerminalIndexEntry[] };
	const shard = { ...unsigned, checksum: hash(canonical(unsigned)) };
	return { bytes: canonical(shard), sha256: hash(canonical(shard)), shard };
}

function readShard(storePath: string, sha256: string, bucket: number, counters?: V6ReadCounters): V6TerminalIndexShard {
	if (counters) counters.shardReads = (counters.shardReads ?? 0) + 1;
	const path = shardPath(storePath, sha256);
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch {
		throw new CheckpointStoreError(`Missing referenced v6 terminal shard ${bucket} (${sha256}).`);
	}
	if (hash(bytes) !== sha256)
		throw new CheckpointStoreError(`Corrupt referenced v6 terminal shard ${bucket} (${sha256}).`);
	return validateShard(parseJson(bytes, path), bucket);
}

function bucketForWorker(id: string): number {
	return Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % TERMINAL_INDEX_SHARD_COUNT;
}

function ensureDirs(storePath: string): void {
	mkdirSync(join(storePath, "blobs"), { recursive: true, mode: 0o700 });
	mkdirSync(join(storePath, "segments"), { recursive: true, mode: 0o700 });
	mkdirSync(join(storePath, "shards"), { recursive: true, mode: 0o700 });
}

function writeInitialShards(storePath: string, hooks: V6FaultHooks | undefined): string[] {
	const hashes: string[] = [];
	for (let bucket = 0; bucket < TERMINAL_INDEX_SHARD_COUNT; bucket += 1) {
		const built = emptyShard(bucket);
		writeImmutable(shardPath(storePath, built.sha256), built.bytes, hooks);
		hashes.push(built.sha256);
	}
	fsyncDirectory(join(storePath, "shards"), "artifact-fsync", hooks);
	return hashes;
}

function workerRefs(
	storePath: string,
	delta: V6WorkerDelta,
	hooks: V6FaultHooks | undefined,
	contentAddressed = true,
): { active: V6ActiveWorkerRef; terminal?: V6TerminalIndexEntry } {
	const worker = delta.worker;
	const activeBuilt = artifact(contentAddressed ? activeWorker(worker) : worker);
	const activePath = blobPath(storePath, activeBuilt.sha256);
	const activeWrote = writeImmutable(activePath, activeBuilt.bytes, hooks);
	if (activeWrote && hooks?.counters)
		hooks.counters.activeArtifactWrites = (hooks.counters.activeArtifactWrites ?? 0) + 1;
	const details =
		worker.log.length > 0
			? [writeSegment(storePath, worker.id, 0, worker.log, false, hooks, false, contentAddressed)]
			: [];
	const active: V6ActiveWorkerRef = {
		id: worker.id,
		active: { kind: "active", sha256: activeBuilt.sha256 },
		detailSegments: details,
		terminalDetailSegments: [],
	};
	if (!delta.terminal) return { active };
	const terminalBuilt = artifact(terminalWorker(worker));
	const outcomeBuilt = artifact(outcomeWorker(worker));
	const terminalWrote = writeImmutable(blobPath(storePath, terminalBuilt.sha256), terminalBuilt.bytes, hooks);
	const outcomeWrote = writeImmutable(blobPath(storePath, outcomeBuilt.sha256), outcomeBuilt.bytes, hooks);
	if (hooks?.counters) {
		if (terminalWrote) hooks.counters.terminalArtifactWrites = (hooks.counters.terminalArtifactWrites ?? 0) + 1;
		if (outcomeWrote) hooks.counters.terminalArtifactWrites = (hooks.counters.terminalArtifactWrites ?? 0) + 1;
	}
	const terminalDetails =
		worker.log.length > 0
			? [writeSegment(storePath, worker.id, 0, worker.log, true, hooks, true, contentAddressed)]
			: [];
	const ref: V6WorkerRef & { terminal: V6BlobRef; outcome: V6BlobRef } = {
		...active,
		terminal: { kind: "terminal", sha256: terminalBuilt.sha256 },
		outcome: { kind: "outcome", sha256: outcomeBuilt.sha256 },
		terminalDetailSegments: terminalDetails,
	};
	return { active, terminal: { id: worker.id, ref, summary: terminalSummary(worker) } };
}

function buildManifest(
	id: string,
	state: string,
	activeWorkers: V6ActiveWorkerRef[],
	terminalIndexShards: string[],
): V6Manifest {
	const unsigned = { formatVersion: 6 as const, id, state, activeWorkers, terminalIndexShards };
	return { ...unsigned, checksum: hash(canonical(unsigned)), workers: activeWorkers };
}

export function writeV6InitialState(state: V6CheckpointState, storePath: string, hooks?: V6FaultHooks): V6Manifest {
	if (manifestExists(storePath))
		throw new CheckpointStoreError(`A published v6 manifest already exists at ${storePath}.`);
	ensureDirs(storePath);
	const stateBuilt = artifact(state);
	writeImmutable(blobPath(storePath, stateBuilt.sha256), stateBuilt.bytes, hooks);
	const terminalIndexShards = writeInitialShards(storePath, hooks);
	fsyncDirectory(join(storePath, "blobs"), "artifact-fsync", hooks);
	const manifest = buildManifest(state.id, stateBuilt.sha256, [], terminalIndexShards);
	publishManifest(storePath, manifest, hooks);
	return manifest;
}

/** Full v5-shaped staging remains for migration and test fixtures only. */
export function writeV6Checkpoint(checkpoint: SessionCheckpoint, storePath: string, hooks?: V6FaultHooks): V6Manifest {
	const validated = validateCheckpoint(checkpoint);
	if (validated.schemaVersion !== 5) throw new CheckpointStoreError("v6 staging requires a validated v5 checkpoint.");
	if (manifestExists(storePath))
		throw new CheckpointStoreError(`A published v6 manifest already exists at ${storePath}.`);
	ensureDirs(storePath);
	const stateBuilt = artifact(stateWithoutWorkers(validated));
	writeImmutable(blobPath(storePath, stateBuilt.sha256), stateBuilt.bytes, hooks);
	const terminalIndexShards = writeInitialShards(storePath, hooks);
	const activeWorkers: V6ActiveWorkerRef[] = [];
	const terminalEntries: V6TerminalIndexEntry[] = [];
	const allRefs: V6WorkerRef[] = [];
	for (const worker of validated.workers) {
		if (hooks?.counters) hooks.counters.activeWorkerIterations = (hooks.counters.activeWorkerIterations ?? 0) + 1;
		const refs = workerRefs(storePath, { worker, terminal: isTerminalState(worker.state) }, hooks, false);
		allRefs.push(refs.terminal?.ref ?? refs.active);
		if (!isTerminalState(worker.state)) {
			// Full-shape staging is retained for migration/fixture compatibility only;
			// production deltas never write these terminal artifacts for active workers.
			writeImmutable(
				blobPath(storePath, artifact(terminalWorker(worker)).sha256),
				artifact(terminalWorker(worker)).bytes,
				hooks,
			);
			writeImmutable(
				blobPath(storePath, artifact(outcomeWorker(worker)).sha256),
				artifact(outcomeWorker(worker)).bytes,
				hooks,
			);
		}
		if (refs.terminal) terminalEntries.push(refs.terminal);
		else activeWorkers.push(refs.active);
	}
	const grouped = new Map<number, V6TerminalIndexEntry[]>();
	for (const entry of terminalEntries) {
		const bucket = bucketForWorker(entry.id);
		grouped.set(bucket, [...(grouped.get(bucket) ?? []), entry]);
	}
	for (const [bucket, entries] of grouped) {
		const prior = readShard(storePath, terminalIndexShards[bucket] as string, bucket);
		const shardUnsigned = {
			formatVersion: 6 as const,
			bucket,
			entries: [...prior.entries, ...entries].sort((left, right) => left.id.localeCompare(right.id)),
		};
		const shard = { ...shardUnsigned, checksum: hash(canonical(shardUnsigned)) };
		const built = artifact(shard);
		writeImmutable(shardPath(storePath, built.sha256), built.bytes, hooks);
		terminalIndexShards[bucket] = built.sha256;
	}
	fsyncDirectory(join(storePath, "blobs"), "artifact-fsync", hooks);
	fsyncDirectory(join(storePath, "segments"), "artifact-fsync", hooks);
	fsyncDirectory(join(storePath, "shards"), "artifact-fsync", hooks);
	const manifest = buildManifest(validated.id, stateBuilt.sha256, activeWorkers, terminalIndexShards);
	publishManifest(storePath, manifest, hooks);
	// Preserve the old in-memory inspection convenience for existing callers.
	return Object.assign(manifest, { workers: allRefs });
}

export function writeV6CheckpointDelta(delta: V6CheckpointDelta, storePath: string, hooks?: V6FaultHooks): V6Manifest {
	if (!manifestExists(storePath)) {
		if (!delta.state) throw new CheckpointStoreError("The first v6 delta must include structural state.");
		const initial = writeV6InitialState(delta.state, storePath, hooks);
		return delta.workers.length === 0 ? initial : writeV6CheckpointDelta(delta, storePath, hooks);
	}
	const prior = readV6Manifest(storePath);
	if (prior.id !== delta.id) throw new CheckpointStoreError(`v6 store id does not match "${delta.id}".`);
	ensureDirs(storePath);
	let stateHash = prior.state;
	if (delta.state) {
		const stateBuilt = artifact(delta.state);
		writeImmutable(blobPath(storePath, stateBuilt.sha256), stateBuilt.bytes, hooks);
		stateHash = stateBuilt.sha256;
	}
	const activeById = new Map(prior.activeWorkers.map((worker) => [worker.id, worker]));
	const terminalIndexShards = [...prior.terminalIndexShards];
	const terminalUpdates = new Map<number, Map<string, V6TerminalIndexEntry | undefined>>();
	for (const deltaWorker of delta.workers) {
		if (hooks?.counters) hooks.counters.activeWorkerIterations = (hooks.counters.activeWorkerIterations ?? 0) + 1;
		const refs = workerRefs(storePath, deltaWorker, hooks);
		if (deltaWorker.terminal) {
			activeById.delete(deltaWorker.worker.id);
			const bucket = bucketForWorker(deltaWorker.worker.id);
			const updates = terminalUpdates.get(bucket) ?? new Map<string, V6TerminalIndexEntry | undefined>();
			updates.set(deltaWorker.worker.id, refs.terminal);
			terminalUpdates.set(bucket, updates);
		} else {
			activeById.set(deltaWorker.worker.id, refs.active);
		}
	}
	for (const [bucket, updates] of terminalUpdates) {
		const priorShard = readShard(storePath, terminalIndexShards[bucket] as string, bucket);
		if (hooks?.counters)
			hooks.counters.terminalIndexEntriesVisited =
				(hooks.counters.terminalIndexEntriesVisited ?? 0) + priorShard.entries.length;
		const entries = new Map(priorShard.entries.map((entry) => [entry.id, entry]));
		for (const [id, entry] of updates) {
			if (entry) entries.set(id, entry);
			else entries.delete(id);
		}
		const shardUnsigned = {
			formatVersion: 6 as const,
			bucket,
			entries: [...entries.values()].sort((left, right) => left.id.localeCompare(right.id)),
		};
		const shard = { ...shardUnsigned, checksum: hash(canonical(shardUnsigned)) };
		const built = artifact(shard);
		writeImmutable(shardPath(storePath, built.sha256), built.bytes, hooks);
		terminalIndexShards[bucket] = built.sha256;
		if (hooks?.counters) hooks.counters.terminalShardWrites = (hooks.counters.terminalShardWrites ?? 0) + 1;
	}
	const manifest = buildManifest(
		delta.id,
		stateHash,
		[...activeById.values()].sort((left, right) => left.id.localeCompare(right.id)),
		terminalIndexShards,
	);
	publishManifest(storePath, manifest, hooks);
	return manifest;
}

/** Compatibility adapter used only by old tests and non-production callers. */
export function writeV6CheckpointUpdate(
	checkpoint: SessionCheckpoint,
	storePath: string,
	hooks?: V6FaultHooks,
): V6Manifest {
	const validated = validateCheckpoint(checkpoint);
	if (!manifestExists(storePath)) return writeV6Checkpoint(validated, storePath, hooks);
	return writeV6CheckpointDelta(
		{
			id: validated.id,
			state: stateWithoutWorkers(validated),
			workers: validated.workers.map((worker) => ({ worker, terminal: isTerminalState(worker.state) })),
		},
		storePath,
		hooks,
	);
}

function manifestExists(storePath: string): boolean {
	try {
		statSync(v6ManifestPath(storePath));
		return true;
	} catch {
		return false;
	}
}

export function readV6Manifest(storePath: string, counters?: V6ReadCounters): V6Manifest {
	let bytes: Buffer;
	try {
		bytes = readFileSync(v6ManifestPath(storePath));
	} catch {
		throw new CheckpointStoreError(`No published v6 manifest at ${storePath}.`);
	}
	if (counters) counters.manifestReads = (counters.manifestReads ?? 0) + 1;
	return validateV6Manifest(parseJson(bytes, v6ManifestPath(storePath)));
}

function readState(storePath: string, manifest: V6Manifest, counters?: V6ReadCounters): Record<string, unknown> {
	if (counters) counters.stateReads = (counters.stateReads ?? 0) + 1;
	return object(readArtifact(storePath, manifest.state, counters), "state blob");
}

/** Read only bounded structural state for an external v6 mutation. */
export function readV6StructuralState(storePath: string): V6CheckpointState {
	const manifest = readV6Manifest(storePath);
	const state = readState(storePath, manifest);
	if (state.id !== manifest.id || "workers" in state)
		throw new CheckpointStoreError("The v6 state blob is malformed or does not match its manifest.");
	return state as V6CheckpointState;
}

function summaryWorker(summary: V6TerminalSummary): CheckpointWorker {
	return {
		id: summary.id,
		name: summary.name,
		role: summary.role,
		tier: summary.tier,
		backend: summary.backend,
		writer: summary.writer,
		room: summary.room,
		task: summary.taskPreview,
		state: summary.state,
		startedAt: summary.startedAt,
		updatedAt: summary.endedAt ?? summary.startedAt,
		endedAt: summary.endedAt,
		finalResult: summary.resultPreview,
		laterFailure: summary.laterFailurePreview,
		pendingQuestion: summary.pendingQuestionPreview,
		lastProgress: summary.lastProgress,
		log: [],
		logFirstIndex: 0,
		logCursor: 0,
		pendingBrief: [],
		stateBeforeStop: summary.stateBeforeStop,
	};
}

function readAllTerminalEntries(
	storePath: string,
	manifest: V6Manifest,
	counters?: V6ReadCounters,
): V6TerminalIndexEntry[] {
	const entries: V6TerminalIndexEntry[] = [];
	for (let bucket = 0; bucket < TERMINAL_INDEX_SHARD_COUNT; bucket += 1)
		entries.push(...readShard(storePath, manifest.terminalIndexShards[bucket] as string, bucket, counters).entries);
	return entries.sort((left, right) => left.id.localeCompare(right.id));
}

export function readV6TerminalWorkerRefs(storePath: string, counters?: V6ReadCounters): Map<string, V6WorkerRef> {
	const manifest = readV6Manifest(storePath, counters);
	return new Map(readAllTerminalEntries(storePath, manifest, counters).map((entry) => [entry.id, entry.ref]));
}

export function readV6WorkerRef(
	storePath: string,
	workerId: string,
	counters?: V6ReadCounters,
): V6WorkerRef | undefined {
	const manifest = readV6Manifest(storePath, counters);
	const shard = readShard(
		storePath,
		manifest.terminalIndexShards[bucketForWorker(workerId)] as string,
		bucketForWorker(workerId),
		counters,
	);
	return shard.entries.find((entry) => entry.id === workerId)?.ref;
}

export function readV6CheckpointMetadata(
	storePath: string,
	counters?: V6ReadCounters,
): { checkpoint: SessionCheckpoint; manifest: V6Manifest } {
	const manifest = readV6Manifest(storePath, counters);
	const stateObject = readState(storePath, manifest, counters);
	const workers: CheckpointWorker[] = [];
	for (const reference of manifest.activeWorkers) {
		const active = readBlob(storePath, reference.active, "active", reference.id, counters);
		workers.push({
			...(active as unknown as CheckpointWorker),
			log: [],
			logFirstIndex: typeof active.logFirstIndex === "number" ? active.logFirstIndex : 0,
			logCursor: typeof active.logCursor === "number" ? active.logCursor : 0,
		});
	}
	for (const entry of readAllTerminalEntries(storePath, manifest, counters))
		workers.push(summaryWorker(entry.summary));
	const checkpoint = { ...stateObject, workers, schemaVersion: 5 } as unknown as SessionCheckpoint;
	try {
		const validated = validateCheckpoint(checkpoint);
		if (validated.id !== manifest.id)
			throw new CheckpointStoreError("Manifest id does not match the referenced state blob.");
		return { checkpoint: validated, manifest };
	} catch (error) {
		throw new CheckpointStoreError(
			`Corrupt v6 reconstructed checkpoint: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
}

export function readV6WorkerOutcome(
	storePath: string,
	reference: V6WorkerRef,
	counters?: V6ReadCounters,
): Record<string, unknown> {
	return readBlob(storePath, reference.outcome, "outcome", reference.id, counters);
}

export function readV6WorkerDetails(
	storePath: string,
	reference: V6WorkerRef,
	counters?: V6ReadCounters,
	terminal = true,
): unknown[] {
	const segments = terminal ? reference.terminalDetailSegments : reference.detailSegments;
	return segments.flatMap((segment) => readSegment(storePath, reference.id, segment, terminal, counters));
}

export interface V6ReadResult {
	checkpoint: SessionCheckpoint;
	manifest: V6Manifest;
	warnings: V6ReadWarning[];
	terminalDetailCorrupt: boolean;
}

export function readV6Checkpoint(storePath: string, counters?: V6ReadCounters): V6ReadResult {
	const manifest = readV6Manifest(storePath, counters);
	const stateObject = readState(storePath, manifest, counters);
	const terminalEntries = readAllTerminalEntries(storePath, manifest, counters);
	const workers: CheckpointWorker[] = [];
	const warnings: V6ReadWarning[] = [];
	for (const reference of manifest.activeWorkers) {
		const active = readBlob(storePath, reference.active, "active", reference.id, counters);
		const details = reference.detailSegments.flatMap((segment) =>
			readSegment(storePath, reference.id, segment, false, counters),
		);
		workers.push({
			...(active as unknown as CheckpointWorker),
			log: details as CheckpointWorker["log"],
			logFirstIndex: typeof active.logFirstIndex === "number" ? active.logFirstIndex : 0,
			logCursor: details.length,
		});
	}
	for (const entry of terminalEntries) {
		const active = readBlob(storePath, entry.ref.active, "active", entry.id, counters);
		const terminal = readBlob(storePath, entry.ref.terminal, "terminal", entry.id, counters);
		const outcome = readBlob(storePath, entry.ref.outcome, "outcome", entry.id, counters);
		const details: unknown[] = [];
		for (const segment of entry.ref.detailSegments)
			details.push(...readSegment(storePath, entry.id, segment, false, counters));
		for (const segment of entry.ref.terminalDetailSegments) {
			try {
				readSegment(storePath, entry.id, segment, true, counters);
			} catch (error) {
				if (!segment.optional) throw error;
				warnings.push({
					workerId: entry.id,
					sequence: segment.sequence,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		workers.push({
			...(active as unknown as CheckpointWorker),
			...(terminal as unknown as Partial<CheckpointWorker>),
			...(outcome as unknown as Partial<CheckpointWorker>),
			log: details as CheckpointWorker["log"],
			logFirstIndex: 0,
			logCursor: details.length,
		});
	}
	workers.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
	const checkpoint = { ...stateObject, workers, schemaVersion: 5 } as unknown as SessionCheckpoint;
	try {
		const validated = validateCheckpoint(checkpoint);
		if (validated.id !== manifest.id)
			throw new CheckpointStoreError("Manifest id does not match the referenced state blob.");
		return {
			checkpoint: stripUndefinedWorkerFields(validated),
			manifest,
			warnings,
			terminalDetailCorrupt: warnings.length > 0,
		};
	} catch (error) {
		throw new CheckpointStoreError(
			`Corrupt v6 reconstructed checkpoint: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
}

function stripUndefinedWorkerFields(checkpoint: SessionCheckpoint): SessionCheckpoint {
	return {
		...checkpoint,
		workers: checkpoint.workers.map((worker) => {
			if (worker.nativeAttached !== undefined) return worker;
			const { nativeAttached: _nativeAttached, ...withoutUndefined } = worker;
			return withoutUndefined as CheckpointWorker;
		}),
	};
}

export function readV6CheckpointState(storePath: string): SessionCheckpoint {
	return readV6Checkpoint(storePath).checkpoint;
}

export function migrateV5ToV6(
	id: string,
	agentDir: string,
	targetStorePath = v6CheckpointStorePath(id, agentDir),
	hooks?: V6FaultHooks,
): V6MigrationResult {
	if (manifestExists(targetStorePath)) {
		const published = readV6Checkpoint(targetStorePath);
		if (published.manifest.id !== id) throw new CheckpointStoreError(`Published v6 store id does not match "${id}".`);
		return { storePath: targetStorePath, published: true, alreadyMigrated: true };
	}
	const legacy = readCheckpoint(id, agentDir);
	const parent = join(targetStorePath, "..");
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const staging = join(parent, `.${id}.${process.pid}.${randomBytes(6).toString("hex")}.staging`);
	const manifest = writeV6Checkpoint(legacy, staging, hooks);
	publishManifest(staging, manifest, hooks);
	try {
		fail(hooks, { type: "store-rename", from: staging, to: targetStorePath });
		renameSync(staging, targetStorePath);
		fsyncDirectory(parent, "manifest-parent-fsync", hooks);
		return { storePath: targetStorePath, published: true, alreadyMigrated: false };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(code ?? "")) throw error;
		mkdirSync(targetStorePath, { recursive: true, mode: 0o700 });
		for (const directory of ["blobs", "segments", "shards"])
			mkdirSync(join(targetStorePath, directory), { recursive: true, mode: 0o700 });
		copyTreeWithoutManifest(staging, targetStorePath, hooks);
		publishManifest(targetStorePath, manifest, hooks);
		fsyncDirectory(parent, "manifest-parent-fsync", hooks);
		return { storePath: targetStorePath, published: true, alreadyMigrated: false };
	}
}

function copyTreeWithoutManifest(source: string, destination: string, hooks: V6FaultHooks | undefined): void {
	for (const name of readdirSync(source)) {
		if (name === V6_MANIFEST_FILE) continue;
		const sourcePath = join(source, name);
		const destinationPath = join(destination, name);
		if (statSync(sourcePath).isDirectory()) {
			mkdirSync(destinationPath, { recursive: true, mode: 0o700 });
			copyTreeWithoutManifest(sourcePath, destinationPath, hooks);
		} else writeImmutable(destinationPath, readFileSync(sourcePath), hooks);
	}
	fsyncDirectory(destination, "artifact-fsync", hooks);
}

export const stageV5ToV6 = migrateV5ToV6;

/** v6 is authoritative as soon as its manifest exists; a corrupt v6 never falls back. */
export function readAuthoritativeCheckpoint(id: string, agentDir: string): SessionCheckpoint {
	const storePath = v6CheckpointStorePath(id, agentDir);
	if (existsSync(v6ManifestPath(storePath))) return readV6Checkpoint(storePath).checkpoint;
	return readCheckpoint(id, agentDir);
}

/** Open legacy checkpoints by publishing a v6 copy, leaving the original JSON untouched. */
export function openCheckpointForHydration(id: string, agentDir: string): HydratableCheckpoint {
	const storePath = v6CheckpointStorePath(id, agentDir);
	if (!manifestExists(storePath)) migrateV5ToV6(id, agentDir, storePath);
	const checkpoint = readV6CheckpointMetadata(storePath).checkpoint;
	if (checkpoint.liveLease && isSessionLeaseAlive(checkpoint.liveLease, agentDir))
		throw new CheckpointStoreError(
			`Checkpoint "${id}" is still owned by live manager ${checkpoint.liveLease.managerId}; refusing unsafe hydration.`,
		);
	return checkpoint as HydratableCheckpoint;
}

export class CheckpointStore {
	readonly storePath: string;
	readonly hooks: V6FaultHooks | undefined;
	constructor(storePath: string, hooks?: V6FaultHooks) {
		this.storePath = storePath;
		this.hooks = hooks;
	}
	write(checkpoint: SessionCheckpoint): V6Manifest {
		return writeV6Checkpoint(checkpoint, this.storePath, this.hooks);
	}
	update(checkpoint: SessionCheckpoint): V6Manifest {
		return writeV6CheckpointUpdate(checkpoint, this.storePath, this.hooks);
	}
	writeDelta(delta: V6CheckpointDelta): V6Manifest {
		return writeV6CheckpointDelta(delta, this.storePath, this.hooks);
	}
	read(): V6ReadResult {
		return readV6Checkpoint(this.storePath);
	}
}
