import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckpointWorker, CheckpointWriter, emptySessionCheckpoint } from "../src/checkpoint.ts";
import {
	readV6CheckpointMetadata,
	readV6Manifest,
	TERMINAL_INDEX_SHARD_COUNT,
	type V6CheckpointDelta,
	type V6WriteCounters,
	v6CheckpointStorePath,
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

	it("atomically tombstones a revived worker's terminal index entry", () => {
		const root = temp();
		const store = join(root, "store");
		const terminal = worker("revived", "done", "old task");
		writeV6Checkpoint(checkpoint("revive", [terminal]), store);
		const revived: CheckpointWorker = {
			...terminal,
			state: "running",
			endedAt: undefined,
			finalResult: undefined,
			updatedAt: 20,
		};
		const { workers: _workers, ...state } = { ...checkpoint("revive", []), updatedAt: 20 };
		writeV6CheckpointDelta(
			{
				id: "revive",
				lane: "structural",
				state,
				workers: [{ worker: revived, terminal: false, removeTerminalIndex: true }],
			},
			store,
		);
		const persisted = readV6CheckpointMetadata(store).checkpoint.workers;
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({ id: "revived", state: "running" });
		expect(readV6Manifest(store).activeWorkers.map((item) => item.id)).toEqual(["revived"]);
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

	it("merges deferred workers, preserves them across structural updates, and flushes shutdown writes", async () => {
		const root = temp();
		const store = v6CheckpointStorePath("merge", root);
		const source = checkpoint("merge", []);
		writeV6Checkpoint(source, store);
		const writer = new CheckpointWriter(root, () => {}, undefined, "v6");
		const first = worker("ro1");
		const second = worker("ro2");
		writer.scheduleDeferredDelta(() => ({
			id: "merge",
			lane: "worker",
			workers: [{ worker: first, terminal: false }],
		}));
		writer.scheduleDeferredDelta(() => ({
			id: "merge",
			lane: "worker",
			workers: [{ worker: second, terminal: false }],
		}));
		const { workers: _workers, ...state } = { ...source, updatedAt: 9 };
		writer.scheduleDelta({ id: "merge", lane: "structural", state, workers: [] });
		await writer.dispose();
		const persisted = readV6CheckpointMetadata(store).checkpoint;
		expect(persisted.workers.map((item) => item.id).sort()).toEqual(["ro1", "ro2"]);

		const latest = { ...first, task: "latest", updatedAt: 10 };
		writer.scheduleDeferredDelta(() => ({
			id: "merge",
			lane: "worker",
			workers: [{ worker: first, terminal: false }],
		}));
		writer.scheduleDelta({ id: "merge", lane: "worker", workers: [{ worker: latest, terminal: false }] });
		await writer.flush();
		expect(readV6CheckpointMetadata(store).checkpoint.workers.find((item) => item.id === "ro1")?.task).toBe("latest");
	});

	it("round-trips archived terminal markers and treats an omitted old marker as false", () => {
		const root = temp();
		const store = join(root, "store");
		const terminal = worker("terminal", "done");
		writeV6Checkpoint(checkpoint("archive", [terminal]), store);
		expect(readV6CheckpointMetadata(store).checkpoint.workers[0]?.archived).toBe(false);
		const canonical = (value: unknown) => `${JSON.stringify(value)}\n`;
		const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
		const manifest = readV6Manifest(store);
		const bucket = manifest.terminalIndexShards.findIndex((shardHash) => {
			const shard = JSON.parse(readFileSync(join(store, "shards", `${shardHash}.json`), "utf8")) as {
				entries: Array<{ id: string }>;
			};
			return shard.entries.some((entry) => entry.id === "terminal");
		});
		if (bucket < 0) throw new Error("archived terminal shard fixture missing");
		const oldShardHash = manifest.terminalIndexShards[bucket];
		if (!oldShardHash) throw new Error("archived terminal shard hash missing");
		const oldShard = JSON.parse(readFileSync(join(store, "shards", `${oldShardHash}.json`), "utf8")) as {
			formatVersion: 6;
			bucket: number;
			entries: Array<{ id: string; ref: unknown; summary: Record<string, unknown> }>;
		};
		const unsignedShard = {
			formatVersion: 6 as const,
			bucket,
			entries: oldShard.entries.map((entry) => {
				const { archived: _archived, ...summary } = entry.summary;
				return { ...entry, summary };
			}),
		};
		const oldShardBytes = { ...unsignedShard, checksum: digest(unsignedShard) };
		const oldCompatibleHash = digest(oldShardBytes);
		writeFileSync(join(store, "shards", `${oldCompatibleHash}.json`), canonical(oldShardBytes));
		const terminalIndexShards = [...manifest.terminalIndexShards];
		terminalIndexShards[bucket] = oldCompatibleHash;
		const unsignedManifest = {
			formatVersion: 6 as const,
			id: manifest.id,
			state: manifest.state,
			activeWorkers: manifest.activeWorkers,
			terminalIndexShards,
		};
		writeFileSync(v6ManifestPath(store), canonical({ ...unsignedManifest, checksum: digest(unsignedManifest) }));
		expect(readV6CheckpointMetadata(store).checkpoint.workers[0]?.archived).toBe(false);
		writeV6CheckpointDelta(
			{ id: "archive", lane: "worker", workers: [{ worker: { ...terminal, archived: true }, terminal: true }] },
			store,
		);
		expect(readV6CheckpointMetadata(store).checkpoint.workers[0]?.archived).toBe(true);
	});
});
