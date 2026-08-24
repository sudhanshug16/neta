import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkpointPath,
	listCheckpoints,
	newCheckpointBase,
	readCheckpoint,
	type SessionCheckpoint,
	writeCheckpointAtomic,
} from "../src/checkpoint.ts";
import {
	CHECKPOINT_STORE_FORMAT_VERSION,
	CheckpointStoreError,
	openCheckpointForHydration,
	readV6Checkpoint,
	readV6CheckpointMetadata,
	readV6Manifest,
	readV6WorkerDetails,
	V6_FORMAT_VERSION,
	type V6FaultEvent,
	type V6ReadCounters,
	v6CheckpointStorePath,
	v6ManifestPath,
	validateV6Manifest,
	writeV6Checkpoint,
	writeV6CheckpointUpdate,
} from "../src/checkpoint-store.ts";
import {
	type CheckpointClaim,
	releaseSessionLock,
	tryAcquireCheckpointClaim,
	tryAcquireSessionLock,
} from "../src/session.ts";

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

	it("does not mark a short multiline v5 result clipped during v6 migration", () => {
		const store = join(temp(), "store");
		const source = checkpoint("multiline");
		const first = source.workers[0];
		if (!first) throw new Error("terminal fixture missing");
		writeV6Checkpoint({ ...source, workers: [{ ...first, finalResult: "line one\nline two\nline three" }] }, store);
		const migrated = readV6CheckpointMetadata(store).checkpoint.workers[0];
		expect(migrated?.resultClipped).toBe(false);
	});

	it("publishes only through the manifest and ignores unreferenced orphans", () => {
		const root = temp();
		const store = join(root, "store");
		writeV6Checkpoint(checkpoint("authority"), store);
		writeFileSync(join(store, "blobs", `${"a".repeat(64)}.json`), "orphan");
		writeFileSync(join(store, "segments", "orphan.json"), "orphan");
		const tempManifest = join(store, "manifest.json.4242.aaaaaaaaaaaa.tmp");
		writeFileSync(tempManifest, readFileSync(v6ManifestPath(store)));
		expect(readV6Checkpoint(store).checkpoint.id).toBe("authority");
		expect(readFileSync(join(store, "blobs", `${"a".repeat(64)}.json`))).toEqual(Buffer.from("orphan"));
		expect(readFileSync(join(store, "segments", "orphan.json"))).toEqual(Buffer.from("orphan"));
		expect(readFileSync(tempManifest)).toBeTruthy();
		const noManifest = join(root, "unpublished");
		mkdirSync(join(noManifest, "blobs"), { recursive: true });
		writeFileSync(join(noManifest, "blobs", `${"b".repeat(64)}.json`), "orphan");
		expect(() => readV6Checkpoint(noManifest)).toThrow("No published v6 manifest");
	});

	it("falls back only when the v6 store is truly absent", () => {
		const agentDir = temp();
		const legacy = checkpoint("legacy-absence");
		writeCheckpointAtomic(legacy, agentDir);
		const parent = join(agentDir, "checkpoints-v6");
		const store = v6CheckpointStorePath(legacy.id, agentDir);
		mkdirSync(parent, { recursive: true });

		expect(readCheckpoint(legacy.id, agentDir).id).toBe(legacy.id);
		symlinkSync(join(parent, "missing-target"), store);
		expect(() => readCheckpoint(legacy.id, agentDir)).toThrow("v6 store is not a regular directory");
		rmSync(store, { force: true });

		mkdirSync(join(store, "manifest.json"), { recursive: true });
		expect(() => readCheckpoint(legacy.id, agentDir)).toThrow("v6 manifest is not a regular file");
		rmSync(store, { recursive: true, force: true });

		mkdirSync(store, { recursive: true });
		symlinkSync(join(store, "missing-manifest"), v6ManifestPath(store));
		expect(() => readCheckpoint(legacy.id, agentDir)).toThrow("v6 manifest");
		rmSync(store, { recursive: true, force: true });

		mkdirSync(store, { recursive: true });
		writeFileSync(v6ManifestPath(store), "{broken");
		expect(() => readCheckpoint(legacy.id, agentDir)).toThrow("invalid JSON");
	});

	it("treats a malformed v6 root as authoritative across reads, hydration, and enumeration", () => {
		const agentDir = temp();
		const legacy = checkpoint("root-authority");
		writeCheckpointAtomic(legacy, agentDir);
		const root = join(agentDir, "checkpoints-v6");
		for (const kind of ["file", "symlink"] as const) {
			if (kind === "file") writeFileSync(root, "not a directory");
			else {
				rmSync(root, { force: true });
				symlinkSync(join(agentDir, "missing-v6-root"), root);
			}
			expect(() => readCheckpoint(legacy.id, agentDir)).toThrow("v6 checkpoint root");
			expect(() => openCheckpointForHydration(legacy.id, agentDir)).toThrow("v6 checkpoint root");
			expect(() => listCheckpoints(agentDir)).toThrow("v6 checkpoint root");
			rmSync(root, { force: true });
		}
	});

	it("cleans failed manifest temps while preserving the prior authority", () => {
		const root = temp();
		const before = join(root, "before");
		const failBefore = (event: V6FaultEvent): void => {
			if (event.type === "manifest-rename") throw new Error("before rename");
		};
		expect(() => writeV6Checkpoint(checkpoint("before"), before, { fail: failBefore })).toThrow("before rename");
		expect(() => readV6Checkpoint(before)).toThrow("No published v6 manifest");
		expect(readdirSync(before).filter((name) => name.startsWith("manifest.json.")).length).toBe(0);

		const after = join(root, "after");
		writeV6Checkpoint(checkpoint("after"), after);
		const prior = readV6Manifest(after);
		const failAfter = (event: V6FaultEvent): void => {
			if (event.type === "manifest-fsync") throw new Error("manifest temp fsync");
		};
		expect(() =>
			writeV6CheckpointUpdate({ ...checkpoint("after"), updatedAt: 12 }, after, { fail: failAfter }),
		).toThrow("manifest temp fsync");
		expect(readV6Manifest(after).checksum).toBe(prior.checksum);
		expect(readV6Checkpoint(after).checkpoint.updatedAt).toBe(11);
		expect(readdirSync(after).filter((name) => name.startsWith("manifest.json.")).length).toBe(0);
		expect(readV6Checkpoint(after).checkpoint.updatedAt).toBe(11);
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

	it("validates published terminal artifacts before resume while keeping large detail lazy", () => {
		const agentDir = temp();
		const source = checkpoint("resume-validation");
		const terminal = source.workers.find((worker) => worker.id === "rw1");
		if (!terminal) throw new Error("expected terminal worker");
		const largeLog = Array.from({ length: 256 }, (_, index) => ({
			at: index + 1,
			kind: index % 2 === 0 ? ("status" as const) : ("text" as const),
			text: `terminal-${index}-${"x".repeat(256)}`,
		}));
		const large = { ...source, workers: [{ ...terminal, log: largeLog }] };
		const largeStore = v6CheckpointStorePath(large.id, agentDir);
		const largeManifest = writeV6Checkpoint(large, largeStore);
		const hydrated = openCheckpointForHydration(large.id, agentDir);
		expect(hydrated.workers[0]?.log).toEqual([]);
		const counters: V6ReadCounters = {};
		expect(readV6CheckpointMetadata(largeStore, counters).checkpoint.workers[0]?.log).toEqual([]);
		expect(counters.detailReads ?? 0).toBe(0);
		const terminalRef = largeManifest.workers[0];
		if (!terminalRef) throw new Error("expected terminal reference");
		expect(readV6WorkerDetails(largeStore, terminalRef)).toEqual(largeLog);

		for (const kind of ["terminal", "outcome"] as const) {
			const corrupt = checkpoint(`resume-corrupt-${kind}`);
			const store = v6CheckpointStorePath(corrupt.id, agentDir);
			const manifest = writeV6Checkpoint(corrupt, store);
			const reference = manifest.workers.find((worker) => worker.id === "rw1");
			const blob = reference?.[kind];
			if (!blob) throw new Error(`expected ${kind} blob reference`);
			writeFileSync(join(store, "blobs", `${blob.sha256}.json`), "tampered");
			expect(() => openCheckpointForHydration(corrupt.id, agentDir)).toThrow("v6 validation found corrupt");
		}
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

	it("requires the outer claim, lets one owner migrate, and lets the MCP child read v6", () => {
		const agentDir = temp();
		const legacy = checkpoint("migration");
		writeCheckpointAtomic(legacy, agentDir);
		const legacyPath = checkpointPath(legacy.id, agentDir);
		const before = readFileSync(legacyPath);
		expect(() => openCheckpointForHydration(legacy.id, agentDir)).toThrow("outer checkpoint claim");
		expect(() => statSync(v6CheckpointStorePath(legacy.id, agentDir))).toThrow();
		const directoryLock = tryAcquireSessionLock(agentDir, agentDir);
		if (!directoryLock) throw new Error("expected the generic directory lock");
		expect(() => openCheckpointForHydration(legacy.id, agentDir, directoryLock as never)).toThrow(
			"Invalid checkpoint claim",
		);
		expect(() => statSync(v6CheckpointStorePath(legacy.id, agentDir))).toThrow();
		releaseSessionLock(directoryLock);
		const wrongId = tryAcquireCheckpointClaim("another-id", agentDir);
		if (!wrongId) throw new Error("expected the wrong-id claim");
		expect(() => openCheckpointForHydration(legacy.id, agentDir, wrongId)).toThrow("Invalid checkpoint claim");
		expect(() => statSync(v6CheckpointStorePath(legacy.id, agentDir))).toThrow();
		releaseSessionLock(wrongId);
		const otherAgentDir = temp();
		const wrongAgent = tryAcquireCheckpointClaim(legacy.id, otherAgentDir);
		if (!wrongAgent) throw new Error("expected the wrong-agent claim");
		expect(() => openCheckpointForHydration(legacy.id, agentDir, wrongAgent)).toThrow("does not authorize");
		expect(() => statSync(v6CheckpointStorePath(legacy.id, agentDir))).toThrow();
		releaseSessionLock(wrongAgent);
		const validClaim = tryAcquireCheckpointClaim(legacy.id, agentDir);
		if (!validClaim) throw new Error("expected the exact claim");
		for (const tampered of [
			{ ...validClaim, path: join(agentDir, "sessions", "claims", "other") },
			{ ...validClaim, token: "tampered" },
			{ ...validClaim, inode: { ...validClaim.inode, ino: validClaim.inode.ino + 1 } },
		] as CheckpointClaim[]) {
			expect(() => openCheckpointForHydration(legacy.id, agentDir, tampered)).toThrow();
			expect(() => statSync(v6CheckpointStorePath(legacy.id, agentDir))).toThrow();
		}
		releaseSessionLock(validClaim);

		const claim = tryAcquireCheckpointClaim(legacy.id, agentDir);
		expect(claim).toBeDefined();
		expect(tryAcquireCheckpointClaim(legacy.id, agentDir)).toBeUndefined();
		const hydrated = openCheckpointForHydration(legacy.id, agentDir, claim);
		expect(hydrated.workers.map((worker) => worker.id)).toEqual(["rw2", "rw1"]);
		expect(readFileSync(legacyPath)).toEqual(before);
		releaseSessionLock(claim);

		// A resumed MCP child arrives after publication and is read-only even when
		// the legacy input remains present.
		const migratedStore = v6CheckpointStorePath(legacy.id, agentDir);
		const orphan = join(migratedStore, "blobs", `${"e".repeat(64)}.json`);
		const tempManifest = join(migratedStore, "manifest.json.4242.aaaaaaaaaaaa.tmp");
		writeFileSync(orphan, "orphan");
		writeFileSync(tempManifest, readFileSync(v6ManifestPath(migratedStore)));
		const child = openCheckpointForHydration(legacy.id, agentDir);
		expect(child.id).toBe(legacy.id);
		expect(readV6Checkpoint(migratedStore).checkpoint.id).toBe(legacy.id);
		expect(readFileSync(orphan, "utf8")).toBe("orphan");
		expect(readFileSync(tempManifest)).toBeTruthy();
	});

	it("hydrates migrated active details while keeping terminal details lazy", () => {
		const agentDir = temp();
		const legacy = checkpoint("active-log");
		const activeLog = [
			{ at: 5, kind: "status" as const, text: "first" },
			{ at: 6, kind: "text" as const, text: "second" },
		];
		const active = legacy.workers.find((worker) => worker.id === "rw2");
		if (!active) throw new Error("expected active worker");
		const migrated = {
			...legacy,
			workers: legacy.workers.map((worker) =>
				worker.id === active.id ? { ...worker, log: activeLog, logFirstIndex: 4, logCursor: 6 } : worker,
			),
		};
		writeCheckpointAtomic(migrated, agentDir);
		const claim = tryAcquireCheckpointClaim(migrated.id, agentDir);
		if (!claim) throw new Error("expected migration claim");
		const hydrated = openCheckpointForHydration(migrated.id, agentDir, claim);
		const hydratedActive = hydrated.workers.find((worker) => worker.id === active.id);
		expect(hydratedActive?.log).toEqual(activeLog);
		expect(hydratedActive).toMatchObject({ logFirstIndex: 4, logCursor: 6 });
		releaseSessionLock(claim);

		const counters: V6ReadCounters = {};
		const metadata = readV6CheckpointMetadata(v6CheckpointStorePath(migrated.id, agentDir), counters, {
			hydrateActiveDetails: true,
		});
		expect(metadata.checkpoint.workers.find((worker) => worker.id === active.id)?.log).toEqual(activeLog);
		expect(counters.detailReads).toBe(1);
	});

	it("releases the outer claim after migration failure so a later resume retries", () => {
		const agentDir = temp();
		const legacy = checkpoint("retryable");
		writeCheckpointAtomic(legacy, agentDir);
		const first = tryAcquireCheckpointClaim(legacy.id, agentDir);
		expect(first).toBeDefined();
		expect(() =>
			openCheckpointForHydration(legacy.id, agentDir, first, {
				fail: (event) => {
					if (event.type === "artifact-write") throw new Error("blocked first copy");
				},
			}),
		).toThrow("blocked first copy");
		releaseSessionLock(first);
		const second = tryAcquireCheckpointClaim(legacy.id, agentDir);
		expect(second).toBeDefined();
		expect(openCheckpointForHydration(legacy.id, agentDir, second).id).toBe(legacy.id);
		releaseSessionLock(second);
	});

	it("keeps staging-first cross-device fallback and retries after a failed copy", () => {
		const agentDir = temp();
		const legacy = checkpoint("fallback");
		writeCheckpointAtomic(legacy, agentDir);
		const events: V6FaultEvent[] = [];
		const claim = tryAcquireCheckpointClaim(legacy.id, agentDir);
		expect(claim).toBeDefined();
		const result = openCheckpointForHydration(legacy.id, agentDir, claim, {
			fail: (event) => {
				events.push(event);
				if (event.type === "store-rename") {
					const error = new Error("cross device") as NodeJS.ErrnoException;
					error.code = "EXDEV";
					throw error;
				}
			},
		});
		expect(result.id).toBe(legacy.id);
		expect(events.filter((event) => event.type === "manifest-parent-fsync")).not.toHaveLength(0);
		releaseSessionLock(claim);

		const failed = checkpoint("copy-failure");
		writeCheckpointAtomic(failed, agentDir);
		let copied = false;
		const failedClaim = tryAcquireCheckpointClaim(failed.id, agentDir);
		expect(() =>
			openCheckpointForHydration(failed.id, agentDir, failedClaim, {
				fail: (event) => {
					if (event.type === "store-rename") {
						const error = new Error("cross device") as NodeJS.ErrnoException;
						error.code = "EXDEV";
						throw error;
					}
					if (event.type === "artifact-write" && event.path.includes(".fallback.staging") && !copied) {
						copied = true;
						throw new Error("fallback copy failed");
					}
				},
			}),
		).toThrow("fallback copy failed");
		releaseSessionLock(failedClaim);
		const retryClaim = tryAcquireCheckpointClaim(failed.id, agentDir);
		expect(openCheckpointForHydration(failed.id, agentDir, retryClaim).id).toBe(failed.id);
		releaseSessionLock(retryClaim);
	});

	it("keeps a published migration retryable when the parent fsync fails after rename", () => {
		const agentDir = temp();
		const legacy = checkpoint("post-publish-fsync");
		writeCheckpointAtomic(legacy, agentDir);
		const legacyBytes = readFileSync(checkpointPath(legacy.id, agentDir));
		const claim = tryAcquireCheckpointClaim(legacy.id, agentDir);
		if (!claim) throw new Error("expected migration claim");
		let failed = false;
		expect(() =>
			openCheckpointForHydration(legacy.id, agentDir, claim, {
				fail: (event) => {
					if (event.type !== "manifest-parent-fsync" || !event.path.endsWith("/checkpoints-v6") || failed) return;
					failed = true;
					const error = new Error("parent fsync fault") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				},
			}),
		).toThrow("parent fsync fault");
		expect(readV6Checkpoint(v6CheckpointStorePath(legacy.id, agentDir)).checkpoint.id).toBe(legacy.id);
		expect(readFileSync(checkpointPath(legacy.id, agentDir))).toEqual(legacyBytes);
		releaseSessionLock(claim);
		const retryClaim = tryAcquireCheckpointClaim(legacy.id, agentDir);
		if (!retryClaim) throw new Error("expected retry claim");
		expect(openCheckpointForHydration(legacy.id, agentDir, retryClaim).id).toBe(legacy.id);
		releaseSessionLock(retryClaim);
	});

	it("rejects symlinked canonical parents and never falls back from corrupt v6", () => {
		const agentDir = temp();
		const real = temp();
		const alias = join(agentDir, "alias");
		symlinkSync(real, alias);
		const legacy = checkpoint("symlinked");
		writeCheckpointAtomic(legacy, real);
		expect(() => openCheckpointForHydration(legacy.id, alias)).toThrow("is a symlink");
		expect(() => statSync(v6CheckpointStorePath(legacy.id, real))).toThrow();

		const claim = tryAcquireCheckpointClaim(legacy.id, real);
		openCheckpointForHydration(legacy.id, real, claim);
		releaseSessionLock(claim);
		writeFileSync(v6ManifestPath(v6CheckpointStorePath(legacy.id, real)), "{broken");
		expect(() => openCheckpointForHydration(legacy.id, real)).toThrow("invalid JSON");
	});

	it("rejects malformed manifest sequence and unsupported format", () => {
		expect(() => validateV6Manifest({ formatVersion: 5 })).toThrow("Unsupported v6 format version");
		expect(() =>
			validateV6Manifest({ formatVersion: 6, id: "x", state: "x", workers: [], checksum: "x".repeat(64) }),
		).toThrow("invalid SHA-256");
		expect(() => readV6Checkpoint(join(temp(), "missing"))).toThrow(CheckpointStoreError);
	});
});
