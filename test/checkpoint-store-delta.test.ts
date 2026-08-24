import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckpointWorker, emptySessionCheckpoint } from "../src/checkpoint.ts";
import {
	readV6CheckpointMetadata,
	readV6Manifest,
	TERMINAL_INDEX_SHARD_COUNT,
	type V6CheckpointDelta,
	type V6WriteCounters,
	v6ManifestPath,
	writeV6Checkpoint,
	writeV6CheckpointDelta,
} from "../src/checkpoint-store.ts";

function worker(id: string, state: CheckpointWorker["state"] = "running", payload = "small"): CheckpointWorker {
	return {
		id,
		name: "worker",
		role: "scout",
		tier: "expert",
		backend: "fake",
		writer: false,
		task: payload,
		state,
		startedAt: 1,
		updatedAt: 2,
		...(state === "done" ? { endedAt: 3, finalResult: payload } : {}),
		log: [],
		logFirstIndex: 0,
		logCursor: 0,
		pendingBrief: [],
	};
}

function checkpoint(id: string, workers: CheckpointWorker[]) {
	return { ...emptySessionCheckpoint({ id, canonicalCwd: process.cwd(), leaderBackend: "fake" }), workers };
}

function delta(
	id: string,
	state: ReturnType<typeof checkpoint>,
	next: CheckpointWorker,
	terminal = false,
): V6CheckpointDelta {
	const { workers: _workers, ...structural } = state;
	return { id, lane: "structural", state: structural, workers: [{ worker: next, terminal }] };
}

describe("v6 delta checkpoint store", () => {
	const roots: string[] = [];
	const temp = () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-delta-"));
		roots.push(root);
		return root;
	};
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("keeps terminal history out of the root and uses deterministic fixed shards", () => {
		const root = temp();
		const one = checkpoint("one", [worker("terminal-1", "done")]);
		const many = checkpoint(
			"many",
			Array.from({ length: 1_000 }, (_, index) => worker(`terminal-${index}`, "done", `payload-${index}`)),
		);
		const onePath = join(root, "one");
		const manyPath = join(root, "many");
		const oneManifest = writeV6Checkpoint(one, onePath);
		const manyManifest = writeV6Checkpoint(many, manyPath);
		expect(oneManifest.terminalIndexShards).toHaveLength(TERMINAL_INDEX_SHARD_COUNT);
		expect(manyManifest.terminalIndexShards).toHaveLength(TERMINAL_INDEX_SHARD_COUNT);
		expect(
			Math.abs(
				readFileSync(v6ManifestPath(onePath), "utf8").length -
					readFileSync(v6ManifestPath(manyPath), "utf8").length,
			),
		).toBeLessThanOrEqual(2);
		expect(JSON.parse(readFileSync(v6ManifestPath(manyPath), "utf8"))).not.toHaveProperty("workers");
	});

	it("rewrites one terminal shard and active telemetry touches no terminal index", () => {
		const root = temp();
		const store = join(root, "store");
		const source = checkpoint("delta", [worker("active")]);
		writeV6Checkpoint(source, store);
		const before = readV6Manifest(store);
		const sourceWorker = source.workers[0];
		if (!sourceWorker) throw new Error("active worker fixture missing");
		const activeCounters: V6WriteCounters = {};
		writeV6CheckpointDelta(
			delta("delta", source, {
				...sourceWorker,
				updatedAt: 9,
				log: [{ at: 9, kind: "progress", text: "telemetry" }],
			}),
			store,
			{ counters: activeCounters },
		);
		expect(activeCounters.terminalShardWrites ?? 0).toBe(0);
		expect(activeCounters.terminalIndexEntriesVisited ?? 0).toBe(0);
		const activeManifest = readV6Manifest(store);
		expect(activeManifest.terminalIndexShards).toEqual(before.terminalIndexShards);
		const terminalCounters: V6WriteCounters = {};
		writeV6CheckpointDelta(
			delta(
				"delta",
				source,
				{ ...sourceWorker, state: "done", endedAt: 10, finalResult: "complete", updatedAt: 10 },
				true,
			),
			store,
			{ counters: terminalCounters },
		);
		expect(terminalCounters.terminalShardWrites).toBe(1);
		const terminalManifest = readV6Manifest(store);
		expect(
			terminalManifest.terminalIndexShards.filter(
				(hash, index) => hash !== activeManifest.terminalIndexShards[index],
			),
		).toHaveLength(1);
	});

	it("reuses the state hash for worker-only deltas and changes it for structural deltas", () => {
		const root = temp();
		const store = join(root, "store");
		const source = checkpoint("lanes", [worker("active")]);
		writeV6Checkpoint(source, store);
		const before = readV6Manifest(store);
		const sourceWorker = source.workers[0];
		if (!sourceWorker) throw new Error("active worker fixture missing");
		const workerCounters: V6WriteCounters = {};
		writeV6CheckpointDelta(
			{
				id: "lanes",
				lane: "worker",
				workers: [
					{
						worker: { ...sourceWorker, updatedAt: 9, log: [{ at: 9, kind: "progress", text: "telemetry" }] },
						terminal: false,
					},
				],
			},
			store,
			{ counters: workerCounters },
		);
		const workerManifest = readV6Manifest(store);
		expect(workerManifest.state).toBe(before.state);
		expect(workerCounters.stateWrites ?? 0).toBe(0);
		expect(workerCounters.stateHashReuses).toBe(1);
		const structural = { ...source, updatedAt: 10 };
		const { workers: _workers, ...state } = structural;
		writeV6CheckpointDelta(
			{
				id: "lanes",
				lane: "structural",
				state,
				workers: [],
			},
			store,
		);
		expect(readV6Manifest(store).state).not.toBe(workerManifest.state);
	});

	it("fails closed when a referenced terminal shard is missing or corrupt", () => {
		const root = temp();
		const store = join(root, "store");
		writeV6Checkpoint(checkpoint("corrupt", [worker("terminal", "done")]), store);
		const manifest = readV6Manifest(store);
		const firstHash = manifest.terminalIndexShards[0];
		if (!firstHash) throw new Error("terminal shard fixture missing");
		const bucketHash = manifest.terminalIndexShards.find((hash) => hash !== firstHash) ?? firstHash;
		writeFileSync(join(store, "shards", `${bucketHash}.json`), "corrupt");
		expect(() => readV6CheckpointMetadata(store)).toThrow(/terminal shard/);
	});
});
