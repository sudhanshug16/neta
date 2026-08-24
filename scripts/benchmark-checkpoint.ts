import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointWriter, emptySessionCheckpoint, type SessionCheckpoint } from "../src/checkpoint.ts";
import {
	readV6CheckpointMetadata,
	readV6Manifest,
	reclaimV6StoreOffline,
	type V6CheckpointDelta,
	type V6ReadCounters,
	type V6WriteCounters,
	v6CheckpointStorePath,
	writeV6Checkpoint,
	writeV6CheckpointDelta,
	writeV6CheckpointUpdate,
} from "../src/checkpoint-store.ts";

const TERMINAL_WORKERS = 1_000;
const TELEMETRY_MUTATIONS = 50;

function bytesIn(path: string): number {
	const stat = statSync(path);
	if (!stat.isDirectory()) return stat.size;
	return readdirSync(path).reduce((total, name) => total + bytesIn(join(path, name)), 0);
}

function worker(id: string, state: "done" | "running", index: number) {
	return {
		id,
		name: "worker",
		role: "scout",
		tier: "expert" as const,
		backend: "fake",
		writer: false,
		task: `task-${index}-${"t".repeat(256)}`,
		state,
		startedAt: index + 1,
		updatedAt: index + 2,
		...(state === "done" ? { endedAt: index + 3, finalResult: `result-${index}-${"r".repeat(256)}` } : {}),
		log: [],
		logFirstIndex: 0,
		logCursor: 0,
		pendingBrief: [],
	};
}

function base(id: string): SessionCheckpoint {
	const empty = emptySessionCheckpoint({ id, canonicalCwd: process.cwd(), leaderBackend: "claude" });
	return {
		...empty,
		workers: [
			...Array.from({ length: TERMINAL_WORKERS }, (_, index) => worker(`terminal-${index}`, "done", index)),
			worker("active", "running", TERMINAL_WORKERS + 1),
		],
	};
}

function activeDelta(checkpoint: SessionCheckpoint, mutation: number): V6CheckpointDelta {
	const active = checkpoint.workers.at(-1);
	if (!active) throw new Error("active fixture worker missing");
	return {
		id: checkpoint.id,
		lane: "worker",
		workers: [{ terminal: false, worker: { ...active, updatedAt: mutation, log: [{ at: mutation, kind: "progress", text: `telemetry-${mutation}` }] } }],
	};
}

function measure<T>(callback: () => T): { result: T; ms: number; rssDelta: number } {
	const before = process.memoryUsage().rss;
	const started = process.hrtime.bigint();
	const result = callback();
	return { result, ms: Number(process.hrtime.bigint() - started) / 1_000_000, rssDelta: process.memoryUsage().rss - before };
}

const root = mkdtempSync(join(tmpdir(), "neta-checkpoint-benchmark-"));
try {
	const beforeStore = join(root, "before");
	const afterAgentDir = join(root, "after-agent");
	const afterStore = v6CheckpointStorePath("after", afterAgentDir);
	const source = base("before");
	const afterSource = { ...source, id: "after" };
	writeV6Checkpoint(source, beforeStore);
	writeV6Checkpoint(afterSource, afterStore);
	const stateHashBefore = readV6Manifest(afterStore).state;
	const beforeCounters: V6WriteCounters = {};
	const beforeRun = measure(() => {
		for (let mutation = 0; mutation < TELEMETRY_MUTATIONS; mutation += 1) {
			const active = afterSource.workers.at(-1);
			if (!active) throw new Error("active fixture worker missing");
			writeV6CheckpointUpdate(
				{ ...source, workers: [...source.workers.slice(0, -1), { ...active, updatedAt: mutation, log: [{ at: mutation, kind: "progress", text: `telemetry-${mutation}` }] }] },
				beforeStore,
				{ counters: beforeCounters },
			);
		}
	});

	const afterCounters: V6WriteCounters = {};
	let materializations = 0;
	const writer = new CheckpointWriter(afterAgentDir, () => {}, undefined, "v6", { counters: afterCounters });
	const afterRss = process.memoryUsage().rss;
	const afterStarted = process.hrtime.bigint();
	for (let mutation = 0; mutation < TELEMETRY_MUTATIONS; mutation += 1) {
		writer.scheduleDeferredDelta(() => {
			materializations += 1;
			return activeDelta(afterSource, mutation);
		}, "after");
	}
	await writer.flush();
	const afterRun = { ms: Number(process.hrtime.bigint() - afterStarted) / 1_000_000, rssDelta: process.memoryUsage().rss - afterRss };

	const reads: V6ReadCounters = {};
	readV6CheckpointMetadata(afterStore, reads);
	const stateHashAfter = readV6Manifest(afterStore).state;
	const gc = reclaimV6StoreOffline(afterStore, {
		checkpointClaimHeld: true,
		directoryLockHeld: true,
		processDeathProven: true,
		noLiveManager: true,
		shutdownProof: "recovery",
	});
	const beforeBytes = bytesIn(beforeStore);
	const afterBytes = bytesIn(afterStore);
	console.log(JSON.stringify({
		fixture: { terminalWorkers: TERMINAL_WORKERS, activeWorkers: 1, telemetryMutations: TELEMETRY_MUTATIONS },
		before: { ms: beforeRun.ms, rssDelta: beforeRun.rssDelta, bytesWritten: beforeCounters.writtenBytes ?? 0, bytesSerialized: beforeCounters.serializedBytes ?? 0, terminalShardWrites: beforeCounters.terminalShardWrites ?? 0 },
		after: { ms: afterRun.ms, rssDelta: afterRun.rssDelta, materializations, manifests: afterCounters.manifestWrites ?? 0, stateWrites: afterCounters.stateWrites ?? 0, stateHashReuses: afterCounters.stateHashReuses ?? 0, stateHashStable: stateHashBefore === stateHashAfter, newArtifacts: (afterCounters.activeArtifactWrites ?? 0) + (afterCounters.activeDetailWrites ?? 0), bytesWritten: afterCounters.writtenBytes ?? 0, bytesSerialized: afterCounters.serializedBytes ?? 0, detailReads: reads.detailReads ?? 0, terminalDetailReads: reads.terminalDetailReads ?? 0, terminalShardWrites: afterCounters.terminalShardWrites ?? 0, terminalIndexEntriesVisited: afterCounters.terminalIndexEntriesVisited ?? 0, rssUnder512MiB: process.memoryUsage().rss < 512 * 1024 * 1024 },
		gc: { status: gc.status, scannedFiles: gc.scannedFiles, scannedBytes: gc.scannedBytes, candidateFiles: gc.candidateFiles, candidateBytes: gc.candidateBytes, deletedFiles: gc.deletedFiles, deletedBytes: gc.deletedBytes, durationMs: gc.durationMs, reason: gc.reason },
		storeBytes: { before: beforeBytes, after: afterBytes },
	}, null, 2));
} finally {
	rmSync(root, { recursive: true, force: true });
}
