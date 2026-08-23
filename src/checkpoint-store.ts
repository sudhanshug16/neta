/**
 * Staged, normalized checkpoint storage.
 *
 * This module is deliberately not wired into WorkerManager yet. A v6 store is
 * useful only when its manifest is valid; the legacy v5 JSON remains the
 * manager's authority until the integration work makes that boundary explicit.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
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
import { type CheckpointWorker, readCheckpoint, type SessionCheckpoint, validateCheckpoint } from "./checkpoint.ts";

export const CHECKPOINT_STORE_FORMAT_VERSION = 6 as const;
export const V6_FORMAT_VERSION = CHECKPOINT_STORE_FORMAT_VERSION;
export const V6_MANIFEST_FILE = "manifest.json";

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
}

export interface V6WorkerRef {
	id: string;
	active: V6BlobRef;
	terminal: V6BlobRef;
	outcome: V6BlobRef;
	detailSegments: V6DetailSegmentRef[];
	terminalDetailSegments: V6DetailSegmentRef[];
}

/** The only file that gives a v6 store meaning. Directory enumeration is not authority. */
export interface V6Manifest {
	formatVersion: 6;
	id: string;
	state: string;
	workers: V6WorkerRef[];
	checksum: string;
}

export interface V6ReadWarning {
	workerId: string;
	sequence: number;
	message: string;
}

export interface V6ReadResult {
	checkpoint: SessionCheckpoint;
	manifest: V6Manifest;
	warnings: V6ReadWarning[];
	terminalDetailCorrupt: boolean;
}

export interface V6FaultHooks {
	/** Called immediately before each fs operation named by the event. */
	fail?: (event: V6FaultEvent) => void;
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
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		throw new CheckpointStoreError(`Invalid ${label} "${value}".`);
	}
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
	exact(segment, ["sequence", "byteLength", "sha256", "optional"], path);
	integer(segment.sequence, `${path}.sequence`);
	integer(segment.byteLength, `${path}.byteLength`);
	validateHash(segment.sha256, `${path}.sha256`);
	if (segment.optional !== undefined && typeof segment.optional !== "boolean")
		throw new CheckpointStoreError(`Corrupt v6 ${path}.optional: expected a boolean.`);
	return {
		sequence: segment.sequence,
		byteLength: segment.byteLength,
		sha256: segment.sha256,
		...(segment.optional === undefined ? {} : { optional: segment.optional }),
	};
}

export function validateV6Manifest(value: unknown): V6Manifest {
	const manifest = object(value, "manifest");
	exact(manifest, ["formatVersion", "id", "state", "workers", "checksum"], "manifest");
	if (manifest.formatVersion !== CHECKPOINT_STORE_FORMAT_VERSION)
		throw new CheckpointStoreError(`Unsupported v6 format version ${String(manifest.formatVersion)}.`);
	string(manifest.id, "manifest.id");
	safePart(manifest.id, "checkpoint id");
	validateHash(manifest.state, "manifest.state");
	if (!Array.isArray(manifest.workers))
		throw new CheckpointStoreError("Corrupt v6 manifest.workers: expected an array.");
	const workers = manifest.workers.map((value, index) => {
		const worker = object(value, `manifest.workers[${index}]`);
		exact(
			worker,
			["id", "active", "terminal", "outcome", "detailSegments", "terminalDetailSegments"],
			`manifest.workers[${index}]`,
		);
		string(worker.id, `manifest.workers[${index}].id`);
		safePart(worker.id, "worker id");
		const detailSegments = worker.detailSegments;
		const terminalDetailSegments = worker.terminalDetailSegments;
		if (!Array.isArray(detailSegments))
			throw new CheckpointStoreError(`Corrupt v6 manifest.workers[${index}].detailSegments.`);
		if (!Array.isArray(terminalDetailSegments))
			throw new CheckpointStoreError(`Corrupt v6 manifest.workers[${index}].terminalDetailSegments.`);
		const details = detailSegments.map((entry, detailIndex) =>
			validateSegment(entry, `manifest.workers[${index}].detailSegments[${detailIndex}]`),
		);
		const terminalDetails = terminalDetailSegments.map((entry, detailIndex) =>
			validateSegment(entry, `manifest.workers[${index}].terminalDetailSegments[${detailIndex}]`),
		);
		for (const [segments, label] of [
			[details, "detailSegments"],
			[terminalDetails, "terminalDetailSegments"],
		] as const) {
			segments.forEach((segment, sequence) => {
				if (segment.sequence !== sequence)
					throw new CheckpointStoreError(
						`Corrupt v6 manifest.workers[${index}].${label}: sequence is not contiguous.`,
					);
			});
		}
		return {
			id: worker.id,
			active: validateBlobRef(worker.active, `manifest.workers[${index}].active`),
			terminal: validateBlobRef(worker.terminal, `manifest.workers[${index}].terminal`),
			outcome: validateBlobRef(worker.outcome, `manifest.workers[${index}].outcome`),
			detailSegments: details,
			terminalDetailSegments: terminalDetails,
		};
	});
	if (new Set(workers.map((worker) => worker.id)).size !== workers.length)
		throw new CheckpointStoreError("Corrupt v6 manifest: duplicate worker id.");
	validateHash(manifest.checksum, "manifest.checksum");
	const unsigned = canonical({ formatVersion: 6, id: manifest.id, state: manifest.state, workers });
	if (hash(unsigned) !== manifest.checksum) throw new CheckpointStoreError("Corrupt v6 manifest: checksum mismatch.");
	return { formatVersion: 6, id: manifest.id, state: manifest.state, workers, checksum: manifest.checksum };
}

export function v6CheckpointStorePath(id: string, agentDir: string): string {
	safePart(id, "checkpoint id");
	return join(agentDir, "checkpoints-v6", id);
}

export const checkpointStorePath = v6CheckpointStorePath;

export function v6ManifestPath(storePath: string): string {
	return join(storePath, V6_MANIFEST_FILE);
}

function manifestPath(storePath: string): string {
	return v6ManifestPath(storePath);
}

function blobPath(storePath: string, sha256: string): string {
	return join(storePath, "blobs", `${sha256}.json`);
}

function segmentPath(storePath: string, workerId: string, sequence: number, terminal: boolean): string {
	return join(storePath, "segments", workerId, `${terminal ? "terminal-" : ""}${sequence}.json`);
}

function fsyncDirectory(
	path: string,
	type: "manifest-parent-fsync" | "artifact-fsync",
	hooks: V6FaultHooks | undefined,
): void {
	if (type === "manifest-parent-fsync") fail(hooks, { type, path });
	else fail(hooks, { type, path });
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
	const handle = openSync(path, "wx", 0o600);
	try {
		writeSync(handle, bytes);
		fail(hooks, { type: event === "artifact-write" ? "artifact-fsync" : "manifest-fsync", path });
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

function writeImmutable(path: string, bytes: Uint8Array, hooks: V6FaultHooks | undefined): void {
	try {
		const current = readFileSync(path);
		if (!current.equals(Buffer.from(bytes))) throw new CheckpointStoreError(`Immutable artifact changed at ${path}.`);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	writeNew(path, bytes, "artifact-write", hooks);
}

function readArtifact(storePath: string, sha256: string): unknown {
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
	reference: V6BlobRef,
	expectedKind: BlobKind,
	workerId: string,
): Record<string, unknown> {
	if (reference.kind !== expectedKind)
		throw new CheckpointStoreError(
			`Corrupt v6 manifest worker ${workerId}: ${expectedKind} blob reference has kind ${reference.kind}.`,
		);
	return object(readArtifact(storePath, reference.sha256), `${workerId} ${expectedKind} blob`);
}

function readSegment(storePath: string, workerId: string, segment: V6DetailSegmentRef, terminal: boolean): unknown[] {
	const path = segmentPath(storePath, workerId, segment.sequence, terminal);
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

function activeWorker(worker: CheckpointWorker): Record<string, unknown> {
	const {
		state: _state,
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
		...(worker.stateBeforeStop === undefined ? {} : { stateBeforeStop: worker.stateBeforeStop }),
		...(worker.endedAt === undefined ? {} : { endedAt: worker.endedAt }),
		...(worker.pendingQuestion === undefined ? {} : { pendingQuestion: worker.pendingQuestion }),
	};
}

function outcomeWorker(worker: CheckpointWorker): Record<string, unknown> {
	return {
		...(worker.finalResult === undefined ? {} : { finalResult: worker.finalResult }),
		...(worker.substantiveResponse === undefined ? {} : { substantiveResponse: worker.substantiveResponse }),
		...(worker.lastResponse === undefined ? {} : { lastResponse: worker.lastResponse }),
		...(worker.laterFailure === undefined ? {} : { laterFailure: worker.laterFailure }),
	};
}

function stateWithoutWorkers(checkpoint: SessionCheckpoint): Record<string, unknown> {
	const { workers: _workers, ...state } = checkpoint;
	return state;
}

function artifact(value: unknown): { bytes: Uint8Array; sha256: string } {
	const bytes = canonical(value);
	return { bytes, sha256: hash(bytes) };
}

function writeSegment(
	storePath: string,
	workerId: string,
	sequence: number,
	entries: unknown[],
	terminal: boolean,
	hooks: V6FaultHooks | undefined,
	optional = false,
): V6DetailSegmentRef {
	const built = artifact(entries);
	const path = segmentPath(storePath, workerId, sequence, terminal);
	writeImmutable(path, built.bytes, hooks);
	return {
		sequence,
		byteLength: built.bytes.byteLength,
		sha256: built.sha256,
		...(optional ? { optional: true } : {}),
	};
}

function publishManifest(storePath: string, manifest: V6Manifest, hooks: V6FaultHooks | undefined): void {
	const path = manifestPath(storePath);
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const bytes = canonical(manifest);
	try {
		writeNew(temporary, bytes, "manifest-write", hooks);
		fail(hooks, { type: "manifest-rename", from: temporary, to: path });
		renameSync(temporary, path);
		fsyncDirectory(storePath, "manifest-parent-fsync", hooks);
	} finally {
		// Deliberately do not remove a published artifact. The temporary name is
		// not published and is safe to leave behind after a fault for diagnosis.
	}
}

function writeStoreContents(
	checkpoint: SessionCheckpoint,
	storePath: string,
	hooks: V6FaultHooks | undefined,
): V6Manifest {
	mkdirSync(join(storePath, "blobs"), { recursive: true, mode: 0o700 });
	mkdirSync(join(storePath, "segments"), { recursive: true, mode: 0o700 });
	const state = artifact(stateWithoutWorkers(checkpoint));
	writeImmutable(blobPath(storePath, state.sha256), state.bytes, hooks);
	const workers: V6WorkerRef[] = [];
	for (const worker of checkpoint.workers) {
		const active = artifact(activeWorker(worker));
		const terminal = artifact(terminalWorker(worker));
		const outcome = artifact(outcomeWorker(worker));
		writeImmutable(blobPath(storePath, active.sha256), active.bytes, hooks);
		writeImmutable(blobPath(storePath, terminal.sha256), terminal.bytes, hooks);
		writeImmutable(blobPath(storePath, outcome.sha256), outcome.bytes, hooks);
		const details = worker.log.length > 0 ? [writeSegment(storePath, worker.id, 0, worker.log, false, hooks)] : [];
		const terminalDetails =
			worker.state === "done" ||
			worker.state === "failed" ||
			worker.state === "killed" ||
			worker.state === "interrupted"
				? [writeSegment(storePath, worker.id, 0, [{ lastResponse: worker.lastResponse }], true, hooks, true)]
				: [];
		workers.push({
			id: worker.id,
			active: { kind: "active", sha256: active.sha256 },
			terminal: { kind: "terminal", sha256: terminal.sha256 },
			outcome: { kind: "outcome", sha256: outcome.sha256 },
			detailSegments: details,
			terminalDetailSegments: terminalDetails,
		});
	}
	for (const worker of checkpoint.workers) {
		mkdirSync(join(storePath, "segments", worker.id), { recursive: true, mode: 0o700 });
		fsyncDirectory(join(storePath, "segments", worker.id), "artifact-fsync", hooks);
	}
	fsyncDirectory(join(storePath, "blobs"), "artifact-fsync", hooks);
	const unsigned = { formatVersion: 6 as const, id: checkpoint.id, state: state.sha256, workers };
	return { ...unsigned, checksum: hash(canonical(unsigned)) };
}

export function writeV6Checkpoint(checkpoint: SessionCheckpoint, storePath: string, hooks?: V6FaultHooks): V6Manifest {
	const validated = validateCheckpoint(checkpoint);
	if (validated.schemaVersion !== 5) throw new CheckpointStoreError("v6 staging requires a validated v5 checkpoint.");
	if (manifestExists(storePath))
		throw new CheckpointStoreError(`A published v6 manifest already exists at ${storePath}.`);
	const manifest = writeStoreContents(validated, storePath, hooks);
	publishManifest(storePath, manifest, hooks);
	return manifest;
}

function manifestExists(storePath: string): boolean {
	try {
		statSync(manifestPath(storePath));
		return true;
	} catch {
		return false;
	}
}

export function readV6Checkpoint(storePath: string): V6ReadResult {
	let manifestBytes: Buffer;
	try {
		manifestBytes = readFileSync(manifestPath(storePath));
	} catch {
		throw new CheckpointStoreError(`No published v6 manifest at ${storePath}.`);
	}
	const manifest = validateV6Manifest(parseJson(manifestBytes, manifestPath(storePath)));
	const state = readArtifact(storePath, manifest.state);
	const stateObject = object(state, "state blob");
	const workers: CheckpointWorker[] = [];
	const warnings: V6ReadWarning[] = [];
	for (const reference of manifest.workers) {
		const active = readBlob(storePath, reference.active, "active", reference.id);
		const terminal = readBlob(storePath, reference.terminal, "terminal", reference.id);
		const outcome = readBlob(storePath, reference.outcome, "outcome", reference.id);
		const details = reference.detailSegments.flatMap((segment) =>
			readSegment(storePath, reference.id, segment, false),
		);
		for (const segment of reference.terminalDetailSegments) {
			try {
				readSegment(storePath, reference.id, segment, true);
			} catch (error) {
				if (!segment.optional) throw error;
				warnings.push({
					workerId: reference.id,
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
			logFirstIndex: typeof active.logFirstIndex === "number" ? active.logFirstIndex : 0,
			logCursor: typeof active.logCursor === "number" ? active.logCursor : details.length,
		});
	}
	const checkpoint = { ...stateObject, workers, schemaVersion: 5 } as unknown as SessionCheckpoint;
	try {
		const validated = validateCheckpoint(checkpoint);
		if (validated.id !== manifest.id)
			throw new CheckpointStoreError("Manifest id does not match the referenced state blob.");
		if (validated.workers.some((worker, index) => worker.id !== manifest.workers[index]?.id))
			throw new CheckpointStoreError("Manifest worker ordering does not match the referenced worker blobs.");
		return {
			checkpoint: validated,
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
	const manifest = writeStoreContents(legacy, staging, hooks);
	publishManifest(staging, manifest, hooks);
	try {
		fail(hooks, { type: "store-rename", from: staging, to: targetStorePath });
		renameSync(staging, targetStorePath);
		fsyncDirectory(parent, "manifest-parent-fsync", hooks);
		return { storePath: targetStorePath, published: true, alreadyMigrated: false };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(code ?? "")) throw error;
		// Some filesystems cannot rename a directory into place. The stable
		// directory remains invisible until its manifest is the final operation.
		mkdirSync(targetStorePath, { recursive: true, mode: 0o700 });
		// Copying through the immutable writer keeps the fallback's publication
		// ordering explicit and avoids making directory enumeration authoritative.
		for (const directory of ["blobs", "segments"])
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
		} else {
			const bytes = readFileSync(sourcePath);
			writeImmutable(destinationPath, bytes, hooks);
		}
	}
	fsyncDirectory(destination, "artifact-fsync", hooks);
}

export const stageV5ToV6 = migrateV5ToV6;

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
	read(): V6ReadResult {
		return readV6Checkpoint(this.storePath);
	}
}
