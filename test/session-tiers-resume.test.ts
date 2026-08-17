/**
 * A session's worker tiers outlive the process that chose them.
 *
 * The startup checklist runs once per session. Everything after that — the
 * control plane, a checkpoint written mid-session, a resume days later — has to
 * carry the same answer, because the session's recorded workers were staffed
 * under it. Two failures are equally bad: a resume that quietly re-asks today's
 * preferences, and an old checkpoint that reads as "no tiers at all".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CheckpointError,
	checkpointPath,
	emptySessionCheckpoint,
	readCheckpoint,
	type SessionCheckpoint,
	validateCheckpoint,
	writeCheckpointAtomic,
} from "../src/checkpoint.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { readStartupPreferences, writeStartupTierChoice } from "../src/startup/preferences.ts";
import { TIERS, type Tier } from "../src/types.ts";
import { fixtureBackendConfig } from "./helpers.ts";

class FakeTransport implements WorkerTransportDriver {
	readonly options: TransportOptions;
	constructor(options: TransportOptions) {
		this.options = options;
	}
	start(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<PromptOutcome> {
		return new Promise(() => {});
	}
	cancel(): boolean {
		return true;
	}
	async kill(): Promise<void> {}
	markTerminal(): void {}
}

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "neta-tier-resume-"));
	mkdirSync(join(agentDir, "checkpoints"), { recursive: true });
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

function manager(sessionTiers: Tier[] | undefined, checkpointId = "sess"): WorkerManager {
	return new WorkerManager({
		cwd: process.cwd(),
		agentDir,
		config: fixtureBackendConfig(),
		sessionTiers,
		channelAddress: "/tmp/neta-tier-resume.sock",
		onEvent: () => {},
		createTransport: (options) => new FakeTransport(options),
		checkpoint: {
			id: checkpointId,
			leaderBackend: "claude",
			writer: { flush: async () => {}, writeDurable: async () => {} } as never,
		},
	});
}

describe("the checkpoint schema", () => {
	it("records the session's tiers", () => {
		const checkpoint = emptySessionCheckpoint({
			id: "sess",
			canonicalCwd: "/repo",
			leaderBackend: "claude",
			sessionTiers: ["journeyman", "expert"],
		});
		expect(checkpoint.sessionTiers).toEqual(["journeyman", "expert"]);
	});

	it("records nothing when no choice was made, rather than an empty list", () => {
		const checkpoint = emptySessionCheckpoint({ id: "sess", canonicalCwd: "/repo", leaderBackend: "claude" });
		expect(checkpoint.sessionTiers).toBeUndefined();
	});

	it("stores tiers in canonical order whatever order they arrive in", () => {
		const checkpoint = emptySessionCheckpoint({
			id: "sess",
			canonicalCwd: "/repo",
			leaderBackend: "claude",
			sessionTiers: ["architect", "apprentice"],
		});
		expect(checkpoint.sessionTiers).toEqual(["apprentice", "architect"]);
	});

	// The whole installed base predates this field. Reading those files as "no
	// tiers" would make every older session unresumable; absent means the full
	// ladder, which is what they actually ran with.
	it("reads a checkpoint written before session tiers existed", () => {
		const older = emptySessionCheckpoint({ id: "sess", canonicalCwd: "/repo", leaderBackend: "claude" });
		const onDisk = { ...older, schemaVersion: 1 } as unknown;
		expect(validateCheckpoint(onDisk).sessionTiers).toBeUndefined();
	});

	it("round-trips through disk", () => {
		writeCheckpointAtomic(
			emptySessionCheckpoint({
				id: "sess",
				canonicalCwd: "/repo",
				leaderBackend: "claude",
				sessionTiers: ["apprentice", "architect"],
			}),
			agentDir,
		);
		expect(readCheckpoint("sess", agentDir).sessionTiers).toEqual(["apprentice", "architect"]);
	});

	it("normalizes a file whose tiers were stored out of order", () => {
		const checkpoint = emptySessionCheckpoint({ id: "sess", canonicalCwd: "/repo", leaderBackend: "claude" });
		writeFileSync(
			checkpointPath("sess", agentDir),
			JSON.stringify({ ...checkpoint, sessionTiers: ["architect", "journeyman"] }),
		);
		expect(readCheckpoint("sess", agentDir).sessionTiers).toEqual(["journeyman", "architect"]);
	});

	// A session that may staff nothing cannot exist, so a file claiming one is
	// corrupt rather than a session with an unusual setting.
	it("refuses a file that records an empty or unknown ladder", () => {
		const checkpoint = emptySessionCheckpoint({ id: "sess", canonicalCwd: "/repo", leaderBackend: "claude" });
		expect(() => validateCheckpoint({ ...checkpoint, sessionTiers: [] })).toThrow(CheckpointError);
		expect(() => validateCheckpoint({ ...checkpoint, sessionTiers: ["wizard"] })).toThrow(/not a known tier/);
		expect(() => validateCheckpoint({ ...checkpoint, sessionTiers: "expert" })).toThrow(CheckpointError);
	});
});

describe("a manager's snapshot", () => {
	it("carries the session's tiers into the checkpoint it writes", () => {
		expect(manager(["journeyman", "expert"]).checkpointSnapshot().sessionTiers).toEqual(["journeyman", "expert"]);
	});

	it("records the full ladder when nothing narrowed it", () => {
		expect(manager(undefined).checkpointSnapshot().sessionTiers).toEqual([...TIERS]);
	});
});

describe("hydrating a resumed session", () => {
	function hydratable(sessionTiers?: Tier[]): SessionCheckpoint {
		return {
			...emptySessionCheckpoint({
				id: "sess",
				canonicalCwd: process.cwd(),
				leaderBackend: "claude",
				sessionTiers,
			}),
			shutdown: { at: 1, processesStopped: true, by: "graceful" },
		};
	}

	// The point of the whole feature: a resume restores the session it saved.
	it("restores the tiers the session was launched with", async () => {
		const restored = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: "/tmp/neta-tier-resume.sock",
				onEvent: () => {},
				createTransport: (options) => new FakeTransport(options),
			},
			hydratable(["journeyman", "expert"]) as never,
		);
		expect(restored.sessionTiers).toEqual(["journeyman", "expert"]);
		await expect(restored.spawn({ role: "scout", tier: "architect", task: "x" })).rejects.toThrow(
			/not available in this session/,
		);
	});

	// Today's preference is about the next session, not this one. If it leaked
	// in, a resumed session could staff tiers its own history says it could not.
	it("ignores what the resuming process was told, and what is remembered today", () => {
		writeStartupTierChoice(["apprentice"], agentDir);
		expect(readStartupPreferences(agentDir).tiers).toEqual(["apprentice"]);

		const restored = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir,
				config: fixtureBackendConfig(),
				// The environment says something different; the checkpoint wins.
				sessionTiers: ["apprentice"],
				channelAddress: "/tmp/neta-tier-resume.sock",
				onEvent: () => {},
				createTransport: (options) => new FakeTransport(options),
			},
			hydratable(["journeyman", "expert"]) as never,
		);
		expect(restored.sessionTiers).toEqual(["journeyman", "expert"]);
	});

	it("gives a session saved before tier selection the whole ladder back", () => {
		const restored = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir,
				config: fixtureBackendConfig(),
				// Even a stale or hand-built resume environment cannot narrow an old
				// checkpoint. Absence in the checkpoint itself means the full ladder.
				sessionTiers: ["expert"],
				channelAddress: "/tmp/neta-tier-resume.sock",
				onEvent: () => {},
				createTransport: (options) => new FakeTransport(options),
			},
			hydratable(undefined) as never,
		);
		expect(restored.sessionTiers).toEqual([...TIERS]);
	});
});

describe("the checkpoint file on disk", () => {
	it("keeps the tier list across a rewrite", () => {
		writeCheckpointAtomic(
			emptySessionCheckpoint({
				id: "sess",
				canonicalCwd: "/repo",
				leaderBackend: "claude",
				sessionTiers: ["expert"],
			}),
			agentDir,
		);
		const raw = JSON.parse(readFileSync(checkpointPath("sess", agentDir), "utf8"));
		expect(raw.sessionTiers).toEqual(["expert"]);
	});
});
