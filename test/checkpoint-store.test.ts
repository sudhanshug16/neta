import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	lstatSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkpointPath, newCheckpointBase, type SessionCheckpoint, writeCheckpointAtomic } from "../src/checkpoint.ts";
import {
	CHECKPOINT_STORE_FORMAT_VERSION,
	CheckpointStoreError,
	migrateV5ToV6,
	readV6Checkpoint,
	readV6Manifest,
	reclaimV6StoreOffline,
	V6_FORMAT_VERSION,
	type V6FaultEvent,
	v6CheckpointStorePath,
	v6ManifestPath,
	validateV6Manifest,
	writeV6Checkpoint,
	writeV6CheckpointUpdate,
} from "../src/checkpoint-store.ts";

const offlineProof = {
	checkpointClaimHeld: true as const,
	directoryLockHeld: true as const,
	processDeathProven: true as const,
	noLiveManager: true as const,
	shutdownProof: "recovery" as const,
};

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
		const recovered = reclaimV6StoreOffline(after, offlineProof);
		expect(recovered.status).toBe("deleted");
		expect(readV6Checkpoint(after).checkpoint.updatedAt).toBe(11);
	});

	it("fails closed on arbitrary, malformed, symlink, and hardlink manifest temps", () => {
		const root = temp();
		const cases = [
			{ name: "arbitrary", entry: "manifest.json.not-a-runtime-temp.tmp", kind: "file" as const },
			{ name: "malformed", entry: "manifest.json.4242.aaaaaaaaaaaa.tmp", kind: "malformed" as const },
			{ name: "symlink", entry: "manifest.json.4242.bbbbbbbbbbbb.tmp", kind: "symlink" as const },
			{ name: "hardlink", entry: "manifest.json.4242.cccccccccccc.tmp", kind: "hardlink" as const },
		];
		for (const item of cases) {
			const store = join(root, item.name);
			writeV6Checkpoint(checkpoint(item.name), store);
			const orphan = join(store, "blobs", `${"d".repeat(64)}.json`);
			writeFileSync(orphan, "orphan");
			const entry = join(store, item.entry);
			if (item.kind === "symlink") symlinkSync(v6ManifestPath(store), entry);
			else if (item.kind === "hardlink") linkSync(v6ManifestPath(store), entry);
			else writeFileSync(entry, item.kind === "malformed" ? "{broken" : "arbitrary");
			const result = reclaimV6StoreOffline(store, offlineProof);
			expect(result.status).toBe("failed");
			expect(result.deletedFiles).toBe(0);
			expect(readFileSync(orphan, "utf8")).toBe("orphan");
		}
	});

	it("removes a valid crash-left manifest temp during the next exclusive GC", () => {
		const root = temp();
		const store = join(root, "crash-temp");
		writeV6Checkpoint(checkpoint("crash-temp"), store);
		const tempPath = join(store, "manifest.json.4242.dddddddddddd.tmp");
		writeFileSync(tempPath, readFileSync(v6ManifestPath(store)));
		const result = reclaimV6StoreOffline(store, offlineProof);
		expect(result.status).toBe("deleted");
		expect(() => readFileSync(tempPath)).toThrow();
		expect(readV6Checkpoint(store).checkpoint.id).toBe("crash-temp");
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

	it("serializes migration before staging cleanup and permits a later retry", () => {
		const agentDir = temp();
		const legacy = checkpoint("concurrent-migration");
		writeCheckpointAtomic(legacy, agentDir);
		const legacyPath = checkpointPath(legacy.id, agentDir);
		const before = readFileSync(legacyPath);
		const target = v6CheckpointStorePath(legacy.id, agentDir);
		let nestedError: unknown;
		let nested = false;
		expect(() =>
			migrateV5ToV6(legacy.id, agentDir, target, {
				fail: (event) => {
					if (nested || event.type !== "artifact-write") return;
					nested = true;
					const staging = readdirSync(dirname(target)).find((name) => name.endsWith(".staging"));
					expect(staging).toBeDefined();
					try {
						migrateV5ToV6(legacy.id, agentDir, target);
					} catch (error) {
						nestedError = error;
					}
					expect(staging ? statSync(join(dirname(target), staging)).isDirectory() : false).toBe(true);
					throw new Error("blocked first copy");
				},
			}),
		).toThrow("blocked first copy");
		expect(nestedError).toBeInstanceOf(CheckpointStoreError);
		expect(String((nestedError as Error).message)).toContain("already owned");
		expect(readFileSync(legacyPath)).toEqual(before);
		expect(migrateV5ToV6(legacy.id, agentDir, target).published).toBe(true);
		expect(readFileSync(legacyPath)).toEqual(before);
	});

	it("fails closed on malformed claims and unowned staging", () => {
		for (const kind of ["malformed", "symlink", "hardlink"] as const) {
			const agentDir = temp();
			const legacy = checkpoint(`unsafe-${kind}`);
			writeCheckpointAtomic(legacy, agentDir);
			const legacyPath = checkpointPath(legacy.id, agentDir);
			const before = readFileSync(legacyPath);
			const claim = join(agentDir, "checkpoint-migration-claims", legacy.id);
			mkdirSync(claim, { recursive: true });
			const owner = join(claim, "owner.json");
			if (kind === "malformed") writeFileSync(owner, "{not-json");
			if (kind === "symlink") symlinkSync(agentDir, owner);
			if (kind === "hardlink") {
				const source = join(agentDir, "owner-source");
				writeFileSync(source, JSON.stringify({ id: legacy.id, pid: 4242, startedAt: "dead", nonce: "a".repeat(24) }));
				linkSync(source, owner);
			}
			expect(() => migrateV5ToV6(legacy.id, agentDir)).toThrow();
			expect(readFileSync(legacyPath)).toEqual(before);
			expect(() => statSync(v6CheckpointStorePath(legacy.id, agentDir))).toThrow();
		}

		const agentDir = temp();
		const legacy = checkpoint("unowned-staging");
		writeCheckpointAtomic(legacy, agentDir);
		const claim = join(agentDir, "checkpoint-migration-claims", legacy.id);
		mkdirSync(claim, { recursive: true });
		writeFileSync(
			join(claim, "owner.json"),
			JSON.stringify({ id: legacy.id, pid: 4242, startedAt: "dead", nonce: "b".repeat(24) }),
		);
		const staging = join(agentDir, "checkpoints-v6", `.${legacy.id}.4242.${"c".repeat(24)}.staging`);
		mkdirSync(dirname(staging), { recursive: true });
		symlinkSync(agentDir, staging);
		expect(() => migrateV5ToV6(legacy.id, agentDir)).toThrow();
		expect(lstatSync(staging).isSymbolicLink()).toBe(true);
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

		const copyFailureTarget = join(agentDir, "copy-failure");
		let copyFailed = false;
		expect(() =>
			migrateV5ToV6("migration", agentDir, copyFailureTarget, {
				fail: (event) => {
					if (event.type === "store-rename") {
						const error = new Error("cross device") as NodeJS.ErrnoException;
						error.code = "EXDEV";
						throw error;
					}
					if (event.type === "artifact-write" && event.path.includes(".fallback.staging") && !copyFailed) {
						copyFailed = true;
						throw new Error("fallback copy failed");
					}
				},
			}),
		).toThrow("fallback copy failed");
		expect(readFileSync(legacyPath)).toEqual(completeBefore);
		expect(() => readV6Checkpoint(copyFailureTarget)).toThrow("No published v6 manifest");
		expect(migrateV5ToV6("migration", agentDir, copyFailureTarget).alreadyMigrated).toBe(false);
		expect(readV6Checkpoint(copyFailureTarget).checkpoint.id).toBe("migration");

		const ambiguousTarget = join(agentDir, "ambiguous");
		mkdirSync(ambiguousTarget, { recursive: true });
		const marker = join(ambiguousTarget, "marker");
		writeFileSync(marker, "preserve");
		expect(() => migrateV5ToV6("migration", agentDir, ambiguousTarget)).toThrow(
			"already exists without a valid manifest",
		);
		expect(readFileSync(marker, "utf8")).toBe("preserve");

		const migrationClaim = join(agentDir, "checkpoint-migration-claims", "migration");
		mkdirSync(migrationClaim, { recursive: true });
		writeFileSync(
			join(migrationClaim, "owner.json"),
			JSON.stringify({ id: "migration", pid: 4242, startedAt: "dead-owner", nonce: "e".repeat(24) }),
		);
		const crashStaging = join(agentDir, "checkpoints-v6", `.migration.4242.${"e".repeat(24)}.fallback.staging`);
		mkdirSync(crashStaging, { recursive: true });
		writeFileSync(join(crashStaging, "partial"), "partial");
		const recoveredTarget = join(agentDir, "checkpoints-v6", "recovered-staging");
		expect(migrateV5ToV6("migration", agentDir, recoveredTarget).published).toBe(true);
		expect(() => statSync(crashStaging)).toThrow();
	});

	it("rejects malformed manifest sequence and unsupported format", () => {
		expect(() => validateV6Manifest({ formatVersion: 5 })).toThrow("Unsupported v6 format version");
		expect(() =>
			validateV6Manifest({ formatVersion: 6, id: "x", state: "x", workers: [], checksum: "x".repeat(64) }),
		).toThrow("invalid SHA-256");
		expect(() => readV6Checkpoint(join(temp(), "missing"))).toThrow(CheckpointStoreError);
	});
});
