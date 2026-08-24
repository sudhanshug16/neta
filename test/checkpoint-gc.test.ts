import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySessionCheckpoint } from "../src/checkpoint.ts";
import {
	readV6Checkpoint,
	readV6Manifest,
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
});
