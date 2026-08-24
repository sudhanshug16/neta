import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySessionCheckpoint } from "../src/checkpoint.ts";
import {
	readV6Checkpoint,
	readV6Manifest,
	readV6WorkerRef,
	reclaimV6StoreOffline,
	v6ManifestPath,
	writeV6Checkpoint,
	writeV6CheckpointDelta,
} from "../src/checkpoint-store.ts";

const proof = {
	checkpointClaimHeld: true as const,
	directoryLockHeld: true as const,
	processDeathProven: true as const,
	noLiveManager: true as const,
	shutdownProof: "recovery" as const,
};

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fixture(id: string) {
	return {
		...emptySessionCheckpoint({ id, canonicalCwd: process.cwd(), leaderBackend: "fake" }),
		workers: [
			{
				id: "active",
				name: "worker",
				role: "scout",
				tier: "expert" as const,
				backend: "fake",
				writer: false,
				task: "task",
				state: "running" as const,
				startedAt: 1,
				updatedAt: 2,
				log: [{ at: 2, kind: "progress" as const, text: "old" }],
				logFirstIndex: 0,
				logCursor: 1,
				pendingBrief: [],
			},
		],
	};
}

describe("v6 offline reclamation", () => {
	const roots: string[] = [];
	const root = () => {
		const value = mkdtempSync(join(tmpdir(), "neta-v6-gc-"));
		roots.push(value);
		return value;
	};
	afterEach(() => {
		for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
	});

	it("deletes unreachable recognized artifacts and preserves every manifest reachability", () => {
		const store = join(root(), "store");
		const initial = fixture("gc");
		writeV6Checkpoint(initial, store);
		const oldManifest = readV6Manifest(store);
		const oldState = oldManifest.state;
		const worker = initial.workers[0];
		if (!worker) throw new Error("worker fixture missing");
		const nextState = { ...initial, updatedAt: 3 };
		const { workers: _workers, ...state } = nextState;
		writeV6CheckpointDelta(
			{
				id: "gc",
				lane: "structural",
				state,
				workers: [
					{
						terminal: false,
						worker: { ...worker, updatedAt: 3, log: [{ at: 3, kind: "progress", text: "new" }] },
					},
				],
			},
			store,
		);
		const orphan = "orphan artifact";
		const orphanHash = hash(`${orphan}\n`);
		writeFileSync(join(store, "blobs", `${orphanHash}.json`), `${orphan}\n`);
		const before = readV6Manifest(store);
		const result = reclaimV6StoreOffline(store, proof);
		expect(result.status).toBe("deleted");
		expect(result.deletedFiles).toBeGreaterThan(0);
		expect(result.candidateFiles).toBeGreaterThanOrEqual(result.deletedFiles);
		expect(() => readFileSync(join(store, "blobs", `${orphanHash}.json`))).toThrow();
		expect(readV6Manifest(store).checksum).toBe(before.checksum);
		expect(readV6Checkpoint(store).checkpoint.id).toBe("gc");
		expect(() => readFileSync(join(store, "blobs", `${oldState}.json`))).toThrow();
	});

	it("skips without offline proof and fails closed on a symlink or missing reference", () => {
		const store = join(root(), "store");
		writeV6Checkpoint(fixture("unsafe"), store);
		const manifest = readV6Manifest(store);
		const active = manifest.activeWorkers[0];
		if (!active) throw new Error("active fixture ref missing");
		const activePath = join(store, "blobs", `${active.active.sha256}.json`);
		const symlinkName = `${"a".repeat(64)}.json`;
		const skipped = reclaimV6StoreOffline(store, undefined);
		expect(skipped.status).toBe("skipped");
		symlinkSync(activePath, join(store, "blobs", symlinkName));
		const symlink = reclaimV6StoreOffline(store, proof);
		expect(symlink.status).toBe("failed");
		unlinkSync(join(store, "blobs", symlinkName));
		unlinkSync(activePath);
		const missing = reclaimV6StoreOffline(store, proof);
		expect(missing.status).toBe("failed");
		expect(missing.deletedFiles).toBe(0);
	});

	it("does not collect while a reader token is present", () => {
		const store = join(root(), "store");
		writeV6Checkpoint(fixture("reader"), store);
		mkdirSync(join(store, "locks", "readers"), { recursive: true });
		mkdirSync(join(store, "locks", "readers", "held"));
		const result = reclaimV6StoreOffline(store, proof);
		expect(result.status).toBe("skipped");
		expect(result.deletedFiles).toBe(0);
	});

	it("retries dead reader preparation residue and skips live preparation residue", () => {
		const deadStore = join(root(), "reader-prepared-dead");
		writeV6Checkpoint(fixture("reader-prepared-dead"), deadStore);
		const deadReaders = join(deadStore, "locks", "readers");
		mkdirSync(deadReaders, { recursive: true });
		const deadPath = join(deadReaders, "dead-reader");
		const deadToken = "dead-reader-token";
		const deadPrepared = join(deadReaders, `dead-reader.prepared.${process.pid}.${deadToken}`);
		writeFileSync(
			deadPrepared,
			JSON.stringify({ pid: 4242, startedAt: "dead", token: deadToken, path: deadPath, kind: "directory" }),
		);
		const deadOrphan = join(deadStore, "blobs", `${hash("dead reader orphan\n")}.json`);
		writeFileSync(deadOrphan, "dead reader orphan\n");
		const recovered = reclaimV6StoreOffline(deadStore, proof, {
			processIsAlive: () => false,
			processStartTime: () => "dead",
		});
		expect(recovered.status).toBe("deleted");
		expect(() => readFileSync(deadPrepared)).toThrow();
		expect(() => readFileSync(deadOrphan)).toThrow();

		const liveStore = join(root(), "reader-prepared-live");
		writeV6Checkpoint(fixture("reader-prepared-live"), liveStore);
		const liveReaders = join(liveStore, "locks", "readers");
		mkdirSync(liveReaders, { recursive: true });
		const livePath = join(liveReaders, "live-reader");
		const liveToken = "live-reader-token";
		const livePrepared = join(liveReaders, `live-reader.prepared.${process.pid}.${liveToken}`);
		writeFileSync(
			livePrepared,
			JSON.stringify({ pid: 4242, startedAt: "live", token: liveToken, path: livePath, kind: "directory" }),
		);
		const liveResult = reclaimV6StoreOffline(liveStore, proof, {
			processIsAlive: () => true,
			processStartTime: () => "live",
		});
		expect(liveResult.status).toBe("skipped");
		expect(readFileSync(livePrepared, "utf8")).toContain(liveToken);
	});

	it("revalidates a changed manifest or scan before deleting", () => {
		const store = join(root(), "store");
		writeV6Checkpoint(fixture("race"), store);
		const manifest = readV6Manifest(store);
		const orphan = hash("race orphan\n");
		const orphanPath = join(store, "blobs", `${orphan}.json`);
		writeFileSync(orphanPath, "race orphan\n");
		const result = reclaimV6StoreOffline(store, proof, {
			beforeDelete: () => {
				writeFileSync(join(store, "unexpected.tmp"), "unexpected");
			},
		});
		expect(result.status).toBe("failed");
		expect(result.deletedFiles).toBe(0);
		expect(readFileSync(orphanPath, "utf8")).toBe("race orphan\n");
		expect(readFileSync(v6ManifestPath(store), "utf8")).toContain(manifest.checksum);
	});

	it("does not block resume or erase unrelated evidence when optional terminal detail is missing or corrupt", () => {
		const store = join(root(), "store");
		writeV6Checkpoint(
			{
				...fixture("optional"),
				workers: [
					{
						...fixture("optional").workers[0],
						id: "terminal",
						state: "done" as const,
						endedAt: 3,
						finalResult: "complete",
						log: [{ at: 3, kind: "progress" as const, text: "terminal evidence" }],
					},
				],
			},
			store,
		);
		const reference = readV6WorkerRef(store, "terminal");
		const segment = reference?.terminalDetailSegments[0];
		if (!segment) throw new Error("terminal optional segment fixture missing");
		const segmentPath = segment.path
			? join(store, "segments", segment.path)
			: join(store, "segments", "terminal", "terminal-0.json");
		unlinkSync(segmentPath);
		const orphanPath = join(store, "blobs", `${hash("unrelated\n")}.json`);
		writeFileSync(orphanPath, "unrelated\n");
		const result = reclaimV6StoreOffline(store, proof);
		expect(result.status).toBe("deleted");
		expect(() => readFileSync(orphanPath)).toThrow();
		expect(readV6Checkpoint(store).warnings).toHaveLength(1);
		expect(readV6Checkpoint(store).checkpoint.id).toBe("optional");

		const corruptStore = join(root(), "corrupt");
		writeV6Checkpoint(
			{
				...fixture("corrupt-optional"),
				workers: [
					{
						...fixture("corrupt-optional").workers[0],
						id: "terminal",
						state: "done" as const,
						endedAt: 3,
						finalResult: "complete",
						log: [{ at: 3, kind: "progress" as const, text: "terminal evidence" }],
					},
				],
			},
			corruptStore,
		);
		const corruptReference = readV6WorkerRef(corruptStore, "terminal");
		const corruptSegment = corruptReference?.terminalDetailSegments[0];
		if (!corruptSegment) throw new Error("corrupt optional segment fixture missing");
		const corruptPath = corruptSegment.path
			? join(corruptStore, "segments", corruptSegment.path)
			: join(corruptStore, "segments", "terminal", "terminal-0.json");
		writeFileSync(corruptPath, "corrupt\n");
		const corruptResult = reclaimV6StoreOffline(corruptStore, proof);
		expect(corruptResult.status).toBe("deleted");
		expect(readFileSync(corruptPath, "utf8")).toBe("corrupt\n");
		expect(readV6Checkpoint(corruptStore).terminalDetailCorrupt).toBe(true);
	});

	it("recovers crashed maintenance, never steals a live owner, and respects replacement claims", () => {
		const store = join(root(), "stale");
		writeV6Checkpoint(fixture("stale"), store);
		mkdirSync(join(store, "locks", "maintenance"), { recursive: true });
		writeFileSync(
			join(store, "locks", "maintenance", "owner.json"),
			JSON.stringify({ pid: 4242, startedAt: "dead-start" }),
		);
		const staleOrphan = join(store, "blobs", `${hash("stale orphan\n")}.json`);
		writeFileSync(staleOrphan, "stale orphan\n");
		expect(
			reclaimV6StoreOffline(store, proof, {
				processIsAlive: () => false,
				processStartTime: () => "dead-start",
			}).status,
		).toBe("deleted");
		expect(() => readFileSync(staleOrphan)).toThrow();

		const liveStore = join(root(), "live");
		writeV6Checkpoint(fixture("live"), liveStore);
		mkdirSync(join(liveStore, "locks", "maintenance"), { recursive: true });
		writeFileSync(
			join(liveStore, "locks", "maintenance", "owner.json"),
			JSON.stringify({ pid: 4242, startedAt: "live-start" }),
		);
		const liveOrphan = join(liveStore, "blobs", `${hash("live orphan\n")}.json`);
		writeFileSync(liveOrphan, "live orphan\n");
		const live = reclaimV6StoreOffline(liveStore, proof, {
			processIsAlive: () => true,
			processStartTime: () => "live-start",
		});
		expect(live.status).toBe("skipped");
		expect(readFileSync(liveOrphan, "utf8")).toBe("live orphan\n");

		const liveMismatchStore = join(root(), "live-mismatch");
		writeV6Checkpoint(fixture("live-mismatch"), liveMismatchStore);
		mkdirSync(join(liveMismatchStore, "locks", "maintenance"), { recursive: true });
		writeFileSync(
			join(liveMismatchStore, "locks", "maintenance", "owner.json"),
			JSON.stringify({ pid: 4242, startedAt: "recorded-start" }),
		);
		const liveMismatchOrphan = join(liveMismatchStore, "blobs", `${hash("live mismatch orphan\n")}.json`);
		writeFileSync(liveMismatchOrphan, "live mismatch orphan\n");
		const liveMismatch = reclaimV6StoreOffline(liveMismatchStore, proof, {
			processIsAlive: () => true,
			processStartTime: () => "replacement-start",
		});
		expect(liveMismatch.status).toBe("deleted");
		expect(liveMismatch.deletedFiles).toBeGreaterThan(0);
		expect(() => readFileSync(liveMismatchOrphan, "utf8")).toThrow();

		const deadAmbiguousStore = join(root(), "dead-ambiguous");
		writeV6Checkpoint(fixture("dead-ambiguous"), deadAmbiguousStore);
		mkdirSync(join(deadAmbiguousStore, "locks", "maintenance"), { recursive: true });
		writeFileSync(
			join(deadAmbiguousStore, "locks", "maintenance", "owner.json"),
			JSON.stringify({ pid: 4242, startedAt: "recorded-start" }),
		);
		const deadAmbiguousOrphan = join(deadAmbiguousStore, "blobs", `${hash("dead ambiguous orphan\n")}.json`);
		writeFileSync(deadAmbiguousOrphan, "dead ambiguous orphan\n");
		const deadAmbiguous = reclaimV6StoreOffline(deadAmbiguousStore, proof, {
			processIsAlive: () => false,
			processStartTime: () => undefined,
		});
		expect(deadAmbiguous.status).toBe("skipped");
		expect(deadAmbiguous.deletedFiles).toBe(0);
		expect(readFileSync(deadAmbiguousOrphan, "utf8")).toBe("dead ambiguous orphan\n");

		const malformedStore = join(root(), "malformed");
		writeV6Checkpoint(fixture("malformed"), malformedStore);
		mkdirSync(join(malformedStore, "locks", "maintenance"), { recursive: true });
		writeFileSync(join(malformedStore, "locks", "maintenance", "owner.json"), "{not-json");
		const malformedOrphan = join(malformedStore, "blobs", `${hash("malformed orphan\n")}.json`);
		writeFileSync(malformedOrphan, "malformed orphan\n");
		const malformed = reclaimV6StoreOffline(malformedStore, proof, {
			processIsAlive: () => false,
			processStartTime: () => "dead-start",
		});
		expect(malformed.status).toBe("skipped");
		expect(malformed.deletedFiles).toBe(0);
		expect(readFileSync(malformedOrphan, "utf8")).toBe("malformed orphan\n");

		const replacementStore = join(root(), "replacement");
		writeV6Checkpoint(fixture("replacement"), replacementStore);
		mkdirSync(join(replacementStore, "locks", "maintenance"), { recursive: true });
		mkdirSync(join(replacementStore, "locks", "maintenance-reclaim"));
		writeFileSync(
			join(replacementStore, "locks", "maintenance", "owner.json"),
			JSON.stringify({ pid: 4242, startedAt: "dead-start" }),
		);
		const replacementOrphan = join(replacementStore, "blobs", `${hash("replacement orphan\n")}.json`);
		writeFileSync(replacementOrphan, "replacement orphan\n");
		const guarded = reclaimV6StoreOffline(replacementStore, proof, {
			processIsAlive: () => false,
			processStartTime: () => "dead-start",
		});
		expect(guarded.status).toBe("skipped");
		expect(readFileSync(replacementOrphan, "utf8")).toBe("replacement orphan\n");
	});
});
