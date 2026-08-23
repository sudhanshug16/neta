import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointPath, newCheckpointBase, type SessionCheckpoint, writeCheckpointAtomic } from "../src/checkpoint.ts";
import {
	CHECKPOINT_STORE_FORMAT_VERSION,
	CheckpointStoreError,
	migrateV5ToV6,
	readV6Checkpoint,
	V6_FORMAT_VERSION,
	type V6FaultEvent,
	v6CheckpointStorePath,
	validateV6Manifest,
	writeV6Checkpoint,
} from "../src/checkpoint-store.ts";

function checkpoint(id: string): SessionCheckpoint {
	return {
		...newCheckpointBase({ id, canonicalCwd: "/repo", leaderBackend: "codex", createdAt: 10 }),
		updatedAt: 11,
		counter: 2,
		noteCounter: 0,
		workers: [
			{
				id: "rw1",
				name: "audit",
				role: "scout",
				tier: "expert",
				backend: "codex",
				writer: false,
				task: "audit",
				state: "done",
				startedAt: 1,
				updatedAt: 9,
				endedAt: 10,
				finalResult: "summary survives detail loss",
				lastResponse: "last response",
				log: [{ at: 2, kind: "progress", text: "mapped" }],
				logFirstIndex: 0,
				logCursor: 1,
				pendingBrief: [],
			},
			{
				id: "rw2",
				name: "plain",
				role: "scout",
				tier: "expert",
				backend: "codex",
				writer: false,
				task: "audit",
				state: "running",
				startedAt: 3,
				updatedAt: 4,
				log: [],
				logFirstIndex: 0,
				logCursor: 0,
				pendingBrief: [],
				finalResult: "summary survives detail loss",
				lastResponse: "last response",
			},
		],
		writerQueue: [],
		writerQueueHistory: [],
		notes: [],
		rooms: [],
		spreadCursors: [],
		roomDebaterBackends: [],
	};
}

function sha(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("normalized v6 checkpoint store", () => {
	const dirs: string[] = [];
	const temp = () => {
		const directory = mkdtempSync(join(tmpdir(), "neta-v6-store-"));
		dirs.push(directory);
		return directory;
	};

	afterEach(() => {
		for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("uses deterministic content hashes, immutable blob reuse, and numbered checksummed segments", () => {
		const root = temp();
		const store = join(root, "store");
		const manifest = writeV6Checkpoint(checkpoint("deterministic"), store);
		expect(manifest.formatVersion).toBe(CHECKPOINT_STORE_FORMAT_VERSION);
		expect(V6_FORMAT_VERSION).toBe(6);
		const segment = manifest.workers[0]?.detailSegments[0];
		if (!segment) throw new Error("expected detail segment");
		expect(segment.sequence).toBe(0);
		expect(typeof segment.byteLength).toBe("number");
		const segmentBytes = readFileSync(join(store, "segments", "rw1", "0.json"));
		expect(segment.sha256).toBe(sha(segmentBytes));
		expect(segment.byteLength).toBe(segmentBytes.byteLength);
		// Both workers have an empty outcome, proving identical content is reused.
		expect(readdirSync(join(store, "blobs")).length).toBe(6);
		expect(() => writeV6Checkpoint(checkpoint("deterministic"), join(root, "store"))).toThrow("already exists");
	});

	it("publishes only through the manifest and ignores unreferenced orphans", () => {
		const root = temp();
		const store = join(root, "store");
		writeV6Checkpoint(checkpoint("authority"), store);
		writeFileSync(join(store, "blobs", `${"a".repeat(64)}.json`), "orphan");
		writeFileSync(join(store, "segments", "orphan.json"), "orphan");
		expect(readV6Checkpoint(store).checkpoint.id).toBe("authority");
		const noManifest = join(root, "unpublished");
		mkdirSync(join(noManifest, "blobs"), { recursive: true });
		writeFileSync(join(noManifest, "blobs", `${"b".repeat(64)}.json`), "orphan");
		expect(() => readV6Checkpoint(noManifest)).toThrow("No published v6 manifest");
	});

	it("has atomic manifest fault boundaries before and after rename", () => {
		const root = temp();
		const before = join(root, "before");
		const failBefore = (event: V6FaultEvent): void => {
			if (event.type === "manifest-rename") throw new Error("before rename");
		};
		expect(() => writeV6Checkpoint(checkpoint("before"), before, { fail: failBefore })).toThrow("before rename");
		expect(() => readV6Checkpoint(before)).toThrow("No published v6 manifest");

		const after = join(root, "after");
		const failAfter = (event: V6FaultEvent): void => {
			if (event.type === "manifest-parent-fsync") throw new Error("after rename");
		};
		expect(() => writeV6Checkpoint(checkpoint("after"), after, { fail: failAfter })).toThrow("after rename");
		expect(readV6Checkpoint(after).checkpoint.id).toBe("after");
	});

	it("fails closed on a corrupt manifest, referenced blob, or required segment", () => {
		const root = temp();
		const manifestStore = join(root, "manifest");
		writeV6Checkpoint(checkpoint("broken-manifest"), manifestStore);
		writeFileSync(join(manifestStore, "manifest.json"), "{broken");
		expect(() => readV6Checkpoint(manifestStore)).toThrow("invalid JSON");

		const blobStore = join(root, "blob");
		const blobManifest = writeV6Checkpoint(checkpoint("broken-blob"), blobStore);
		writeFileSync(join(blobStore, "blobs", `${blobManifest.state}.json`), "tampered");
		expect(() => readV6Checkpoint(blobStore)).toThrow("Corrupt referenced v6 blob");

		const segmentStore = join(root, "segment");
		const segmentManifest = writeV6Checkpoint(checkpoint("broken-segment"), segmentStore);
		const segment = segmentManifest.workers[0]?.detailSegments[0];
		if (!segment) throw new Error("expected segment");
		writeFileSync(join(segmentStore, "segments", "rw1", "0.json"), "tampered");
		expect(() => readV6Checkpoint(segmentStore)).toThrow("Corrupt referenced v6 detail segment");
	});

	it("keeps terminal summary visible while reporting optional terminal-detail corruption", () => {
		const root = temp();
		const store = join(root, "store");
		const manifest = writeV6Checkpoint(checkpoint("terminal"), store);
		expect(manifest.workers[0]?.terminalDetailSegments[0]?.optional).toBe(true);
		writeFileSync(join(store, "segments", "rw1", "terminal-0.json"), "tampered");
		const result = readV6Checkpoint(store);
		expect(result.terminalDetailCorrupt).toBe(true);
		expect(result.warnings[0]?.workerId).toBe("rw1");
		expect(result.checkpoint.workers[0]?.finalResult).toBe("summary survives detail loss");
	});

	it("migrates v5 once, preserves the original bytes, and supports stable-directory fallback", () => {
		const agentDir = temp();
		const legacy = checkpoint("migration");
		writeCheckpointAtomic(legacy, agentDir);
		const legacyPath = checkpointPath("migration", agentDir);
		const before = readFileSync(legacyPath);
		const target = v6CheckpointStorePath("migration", agentDir);
		const first = migrateV5ToV6("migration", agentDir, target);
		expect(first.alreadyMigrated).toBe(false);
		expect(readFileSync(legacyPath)).toEqual(before);
		const migrated = readV6Checkpoint(target).checkpoint;
		expect(migrated.workers).toEqual(legacy.workers);
		expect(migrated).toMatchObject({ id: legacy.id, canonicalCwd: legacy.canonicalCwd, updatedAt: legacy.updatedAt });
		const second = migrateV5ToV6("migration", agentDir, target);
		expect(second.alreadyMigrated).toBe(true);
		expect(readFileSync(legacyPath)).toEqual(before);

		const fallbackTarget = join(agentDir, "fallback");
		const fallbackEvents: V6FaultEvent[] = [];
		const fallback = migrateV5ToV6("migration", agentDir, fallbackTarget, {
			fail: (event) => {
				fallbackEvents.push(event);
				if (event.type === "store-rename") {
					const error = new Error("cross device") as NodeJS.ErrnoException;
					error.code = "EXDEV";
					throw error;
				}
			},
		});
		expect(fallback.published).toBe(true);
		expect(statSync(join(fallbackTarget, "manifest.json")).isFile()).toBe(true);
		expect(readV6Checkpoint(fallbackTarget).checkpoint.id).toBe("migration");
		expect(
			fallbackEvents.filter(
				(event) => event.type === "manifest-parent-fsync" && event.path === join(fallbackTarget, ".."),
			),
		).toHaveLength(1);

		const completeAfterBoundaryFault = join(agentDir, "complete-after-boundary-fault");
		const completeBefore = readFileSync(legacyPath);
		expect(() =>
			migrateV5ToV6("migration", agentDir, completeAfterBoundaryFault, {
				fail: (event) => {
					if (event.type === "store-rename") {
						const error = new Error("cross device") as NodeJS.ErrnoException;
						error.code = "EXDEV";
						throw error;
					}
					if (event.type === "manifest-parent-fsync" && event.path === join(completeAfterBoundaryFault, ".."))
						throw new Error("crash after fallback publication");
				},
			}),
		).toThrow("crash after fallback publication");
		expect(readFileSync(legacyPath)).toEqual(completeBefore);
		expect(readV6Checkpoint(completeAfterBoundaryFault).checkpoint.id).toBe("migration");

		const priorAuthority = join(agentDir, "prior-authority");
		expect(() =>
			migrateV5ToV6("migration", agentDir, priorAuthority, {
				fail: (event) => {
					if (event.type === "store-rename") {
						const error = new Error("cross device") as NodeJS.ErrnoException;
						error.code = "EXDEV";
						throw error;
					}
					if (event.type === "manifest-rename" && event.to === join(priorAuthority, "manifest.json"))
						throw new Error("crash before fallback publication");
				},
			}),
		).toThrow("crash before fallback publication");
		expect(readFileSync(legacyPath)).toEqual(completeBefore);
		expect(() => readV6Checkpoint(priorAuthority)).toThrow("No published v6 manifest");
	});

	it("rejects malformed manifest sequence and unsupported format", () => {
		expect(() => validateV6Manifest({ formatVersion: 5 })).toThrow("Unsupported v6 format version");
		expect(() =>
			validateV6Manifest({ formatVersion: 6, id: "x", state: "x", workers: [], checksum: "x".repeat(64) }),
		).toThrow("invalid SHA-256");
		expect(() => readV6Checkpoint(join(temp(), "missing"))).toThrow(CheckpointStoreError);
	});
});
