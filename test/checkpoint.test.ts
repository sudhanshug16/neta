import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHECKPOINT_SCHEMA_VERSION,
	CheckpointWriter,
	type CheckpointWriterTimers,
	checkpointPath,
	listCheckpoints,
	newCheckpointBase,
	readCheckpoint,
	readCheckpointForHydration,
	recordLeaderVendorConversationId,
	type SessionCheckpoint,
	validateCheckpoint,
	writeCheckpointAtomic,
} from "../src/checkpoint.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { processStartTime, writeSessionRecord } from "../src/session.ts";
import { fixtureBackendConfig, waitFor } from "./helpers.ts";

class FakeTransport implements WorkerTransportDriver {
	readonly prompts: string[] = [];
	readonly options: TransportOptions;
	private readonly outcomes: Array<(outcome: PromptOutcome) => void> = [];

	constructor(options: TransportOptions) {
		this.options = options;
	}
	start(): Promise<void> {
		return Promise.resolve();
	}
	prompt(text: string): Promise<PromptOutcome> {
		this.prompts.push(text);
		return new Promise((resolve) => this.outcomes.push(resolve));
	}
	kill(): Promise<void> {
		return Promise.resolve();
	}
	cancels = 0;

	cancel(): boolean {
		this.cancels += 1;
		return true;
	}

	markTerminal(): void {}
	finish(outcome: PromptOutcome): void {
		const resolve = this.outcomes.shift();
		if (!resolve) throw new Error("No prompt is running.");
		resolve(outcome);
	}
}

function emptyCheckpoint(id: string, cwd: string): SessionCheckpoint {
	return {
		...newCheckpointBase({ id, canonicalCwd: cwd, leaderBackend: "codex", createdAt: 100 }),
		updatedAt: 101,
		counter: 0,
		noteCounter: 0,
		workers: [],
		writerQueue: [],
		writerQueueHistory: [],
		notes: [],
		rooms: [],
		spreadCursors: [],
		roomDebaterBackends: [],
	};
}

class FakeTimers implements CheckpointWriterTimers {
	private nextId = 0;
	private readonly tasks = new Map<number, { at: number; callback: () => void }>();
	now = 0;

	setTimeout(callback: () => void, delayMs: number): number {
		const id = ++this.nextId;
		this.tasks.set(id, { at: this.now + delayMs, callback });
		return id;
	}

	clearTimeout(timer: unknown): void {
		this.tasks.delete(timer as number);
	}

	advance(delayMs: number): void {
		const target = this.now + delayMs;
		for (;;) {
			const due = [...this.tasks.entries()]
				.filter(([, task]) => task.at <= target)
				.sort(([, left], [, right]) => left.at - right.at)[0];
			if (!due) break;
			this.now = due[1].at;
			this.tasks.delete(due[0]);
			due[1].callback();
		}
		this.now = target;
	}
}

describe("durable session checkpoints", () => {
	const dirs: string[] = [];
	const tempDir = (prefix: string) => {
		const path = mkdtempSync(join(tmpdir(), prefix));
		dirs.push(path);
		return path;
	};

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("writes atomically with private modes and preserves corrupt or unknown-schema files", () => {
		const agentDir = tempDir("neta-checkpoint-");
		const cwd = tempDir("neta-checkpoint-repo-");
		const checkpoint = emptyCheckpoint("logical-1", cwd);
		const path = writeCheckpointAtomic(checkpoint, agentDir);

		expect(statSync(join(agentDir, "checkpoints")).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readCheckpoint("logical-1", agentDir)).toEqual(checkpoint);
		expect(readdirSync(join(agentDir, "checkpoints"))).toEqual(["logical-1.json"]);

		writeFileSync(path, "{broken", { mode: 0o600 });
		expect(() => writeCheckpointAtomic(checkpoint, agentDir)).toThrow("corrupt JSON");
		expect(readFileSync(path, "utf8")).toBe("{broken");
		expect(listCheckpoints(agentDir)[0]).toMatchObject({
			id: "logical-1",
			error: expect.stringContaining("corrupt JSON"),
		});

		writeFileSync(path, JSON.stringify({ ...checkpoint, schemaVersion: 99 }), { mode: 0o600 });
		expect(() => writeCheckpointAtomic(checkpoint, agentDir)).toThrow("schema version 99");
		expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe(99);
	});

	/**
	 * Schema 1 is what Neta wrote before the shutdown proof existed. Its files are
	 * still out there in people's `~/.neta`, and every field this build reads is
	 * already in them — so they are read as they are and carried to the current
	 * schema, with no proof of a clean shutdown, which is the truth about them.
	 *
	 * The upgrade suite resumes a real older Neta, and that runtime writes schema
	 * 2; nothing else would notice if schemas 1 and 2 stopped being readable.
	 */
	it("reads a schema-1 checkpoint and carries it to the current schema", () => {
		const agentDir = tempDir("neta-checkpoint-");
		const cwd = tempDir("neta-checkpoint-repo-");
		const { schemaVersion: _current, ...rest } = emptyCheckpoint("old-schema", cwd);
		const schemaOne = {
			...rest,
			schemaVersion: 1,
			appVersion: "1.1.0",
			leader: { backend: "codex", vendorConversationId: "22222222-2222-4222-8222-222222222222" },
			notes: [{ id: "n1", text: "decide on the rollout window", open: true, createdAt: 1, workers: [] }],
		};
		// Written where an older Neta left it, not through this build's writer.
		mkdirSync(join(agentDir, "checkpoints"), { recursive: true, mode: 0o700 });
		writeFileSync(checkpointPath("old-schema", agentDir), JSON.stringify(schemaOne), { mode: 0o600 });

		const read = readCheckpoint("old-schema", agentDir);
		expect(read.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
		expect(read.goal).toBeUndefined();
		expect(read.appVersion).toBe("1.1.0");
		expect(read.leader.vendorConversationId).toBe("22222222-2222-4222-8222-222222222222");
		expect(read.notes[0]).toMatchObject({ id: "n1", open: true });
		// It predates the shutdown proof, so it claims none.
		expect(read.shutdown).toBeUndefined();
	});

	it("round-trips semantic state, excludes live secrets, and hydrates without side effects", async () => {
		const agentDir = tempDir("neta-checkpoint-");
		const cwd = tempDir("neta-checkpoint-repo-");
		const writer = new CheckpointWriter(agentDir);
		const transports: FakeTransport[] = [];
		const manager = new WorkerManager({
			cwd,
			agentDir,
			config: fixtureBackendConfig({ backends: { claude: { env: { SECRET_ENV: "env-secret-value" } } } }),
			channelAddress: "/tmp/socket-secret-value.sock",
			leaderToken: "leader-token-secret-value",
			onEvent: () => {},
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
			checkpoint: {
				id: "stable-session",
				leaderBackend: "codex",
				leaderVendorConversationId: "leader-vendor-42",
				writer,
			},
		});

		manager.initGoal("ship the release");
		const note = manager.createNote("review rollout");
		const completed = await manager.spawn({
			role: "scout",
			tier: "expert",
			task: "audit auth",
			room: "review",
			note: note.id,
		});
		transports[0].options.events.vendorSession("worker-vendor-1");
		transports[0].options.events.usage({ inputTokens: 12, outputTokens: 5 });
		manager.progress(completed.id, "mapped auth");
		manager.postToRoom("review", completed.id, "auth scout", "race confirmed");
		transports[0].finish({ ok: true, summary: "Substantive auth handoff" });
		await manager.waitFor([completed.id], 1000);

		const waiting = await manager.spawn({ role: "reviewer", tier: "architect", task: "decide rollout" });
		await waitFor(() => transports[1]?.prompts.length === 1);
		manager.blocked(waiting.id, "Ship now?");
		transports[1].finish({ ok: false, cancelled: true, summary: "Turn cancelled." });
		await waitFor(() => manager.get(waiting.id).state === "blocked");
		const activeWriter = await manager.spawn({ role: "worker", tier: "expert", task: "implement", writer: true });
		const queuedWriter = await manager.spawn({ role: "worker", tier: "expert", task: "follow up", writer: true });
		manager.send(queuedWriter.id, "also update tests");
		manager.closeNote(note.id);
		await manager.flushCheckpoint();

		const saved = readCheckpoint("stable-session", agentDir);
		expect(saved.canonicalCwd).toBe(realpathSync(cwd));
		expect(saved.id).toBe("stable-session");
		expect(saved.leader).toEqual({ backend: "codex", vendorConversationId: "leader-vendor-42" });
		expect(saved.goal).toMatchObject({ originalIntent: "ship the release", revision: 0, status: "active" });
		expect(saved.workers.find((worker) => worker.id === completed.id)?.finalResult).toBe("Substantive auth handoff");
		expect(saved.workers.find((worker) => worker.id === completed.id)?.vendorSessionId).toBe("worker-vendor-1");
		expect(saved.workers.find((worker) => worker.id === waiting.id)?.pendingQuestion).toBe("Ship now?");
		expect(saved.writerQueue).toEqual([queuedWriter.id]);
		expect(saved.writerQueueHistory.map((event) => event.action)).toEqual(["queued"]);
		expect(saved.notes[0]?.open).toBe(false);
		expect(saved.rooms[0]?.posts[0]?.text).toBe("race confirmed");
		expect(saved.spreadCursors.length).toBeGreaterThan(0);

		const serialized = readFileSync(checkpointPath("stable-session", agentDir), "utf8");
		for (const forbidden of [
			"leader-token-secret-value",
			"socket-secret-value",
			"env-secret-value",
			"channelToken",
			"processGroupId",
			'"pid"',
			"scratchDir",
			"driver",
			"pendingAsk",
			"mcpServers",
			'"token"',
			'"socket"',
			'"env"',
			'"pgid"',
			'"promise"',
			'"callback"',
		])
			expect(serialized).not.toContain(forbidden);

		let createdTransports = 0;
		let prepared = 0;
		let openedPanes = 0;
		const hydratedWriter = new CheckpointWriter(agentDir);
		const safe = readCheckpointForHydration("stable-session", agentDir);
		const hydrated = WorkerManager.hydrate(
			{
				cwd: "/ignored",
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: "/tmp/fresh.sock",
				onEvent: () => {},
				prepareEnv: async () => {
					prepared += 1;
					return {};
				},
				panes: {
					open: () => {
						openedPanes += 1;
						return { opened: true };
					},
					openRoom: () => ({ opened: true }),
				},
				createTransport: (options) => {
					createdTransports += 1;
					return new FakeTransport(options);
				},
				checkpoint: { id: "stable-session", leaderBackend: "codex", writer: hydratedWriter },
			},
			safe,
		);

		expect(createdTransports).toBe(0);
		expect(prepared).toBe(0);
		expect(openedPanes).toBe(0);
		expect(hydrated.get(completed.id).state).toBe("done");
		expect(hydrated.goalSnapshot()).toMatchObject({ originalIntent: "ship the release", revision: 0 });
		expect(hydrated.get(completed.id).result).toBe("Substantive auth handoff");
		expect(hydrated.get(waiting.id)).toMatchObject({ state: "blocked", pendingQuestion: "Ship now?" });
		expect(hydrated.get(activeWriter.id)).toMatchObject({ state: "interrupted", stateBeforeStop: "running" });
		expect(hydrated.get(queuedWriter.id)).toMatchObject({ state: "interrupted", stateBeforeStop: "queued" });
		expect(hydrated.statusSnapshot().writerQueue.map((worker) => worker.id)).toEqual([queuedWriter.id]);
		await expect(hydrated.spawn({ role: "worker", tier: "expert", task: "unsafe", writer: true })).rejects.toThrow(
			"prior worker process death",
		);

		await hydrated.flushCheckpoint();
		await manager.dispose();
		await hydrated.dispose();
	});

	it("fails closed on malformed nested goal data", () => {
		const checkpoint = emptyCheckpoint("bad-goal", process.cwd());
		expect(() => validateCheckpoint({ ...checkpoint, goal: { originalIntent: "x" } })).toThrow(
			"checkpoint.goal.workingObjective",
		);
	});

	it("persists native TUI ownership and fails closed after manager restart", async () => {
		const agentDir = tempDir("neta-checkpoint-");
		const cwd = tempDir("neta-checkpoint-repo-");
		const transports: FakeTransport[] = [];
		const manager = new WorkerManager({
			cwd,
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: "/tmp/native-owner.sock",
			onEvent: () => {},
			panes: {
				open: () => ({ opened: true }),
				openRoom: () => ({ opened: true }),
				attach: () => ({ opened: true }),
			},
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
			checkpoint: { id: "native-owner", leaderBackend: "codex", writer: new CheckpointWriter(agentDir) },
		});
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "inspect" });
		transports[0].options.events.vendorSession("vendor-native");
		transports[0].finish({ ok: true, summary: "done" });
		await waitFor(() => manager.get(worker.id).state === "done");
		await manager.reopenWorkerTui(worker.id);
		await manager.flushCheckpoint();
		const current = readCheckpoint("native-owner", agentDir);
		expect(current.workers[0].nativeAttached).toBe(true);
		expect(validateCheckpoint({ ...current, schemaVersion: 3 }).workers[0].nativeAttached).toBeUndefined();
		await manager.dispose();

		const hydrated = WorkerManager.hydrate(
			{
				cwd,
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: "/tmp/native-owner-restored.sock",
				onEvent: () => {},
				checkpoint: { id: "native-owner", leaderBackend: "codex", writer: new CheckpointWriter(agentDir) },
			},
			readCheckpointForHydration("native-owner", agentDir),
		);
		await expect(hydrated.steer(worker.id, "continue headlessly")).rejects.toThrow("exclusive ownership");
		await hydrated.dispose();
	});

	it("retains a final graceful checkpoint and can read the last crash-safe mutation", async () => {
		const agentDir = tempDir("neta-checkpoint-");
		const cwd = tempDir("neta-checkpoint-repo-");
		const writer = new CheckpointWriter(agentDir);
		const transports: FakeTransport[] = [];
		const manager = new WorkerManager({
			cwd,
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: "/tmp/checkpoint.sock",
			onEvent: () => {},
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
			checkpoint: { id: "retained", leaderBackend: "claude", writer },
		});
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "inspect" });
		manager.progress(worker.id, "halfway");
		await manager.flushCheckpoint();
		expect(readCheckpoint("retained", agentDir).workers[0]?.state).toBe("running");

		await manager.dispose();
		const retained = readCheckpoint("retained", agentDir);
		expect(retained.workers[0]).toMatchObject({
			state: "interrupted",
			stateBeforeStop: "running",
			finalResult: "Leader shut down; review this worker before continuing.",
		});
	});

	it("refuses hydration while the exact old live-manager lease still exists", () => {
		const agentDir = tempDir("neta-checkpoint-");
		const cwd = tempDir("neta-checkpoint-repo-");
		const identity = processStartTime(process.pid);
		const checkpoint = {
			...emptyCheckpoint("live-logical", cwd),
			liveLease: { managerId: "manager-ephemeral", processStartedAt: identity },
		};
		writeCheckpointAtomic(checkpoint, agentDir);
		writeSessionRecord(
			{
				id: "manager-ephemeral",
				socket: "/tmp/neta-live-test.sock",
				token: "registry-secret",
				cwd,
				leader: "codex",
				pid: process.pid,
				processStartedAt: identity,
				startedAt: Date.now(),
			},
			agentDir,
		);

		expect(() => readCheckpointForHydration("live-logical", agentDir)).toThrow("still owned by live manager");
	});

	it("reports a failed checkpoint write without throwing into the live caller", async () => {
		const blockedAgentDir = join(tempDir("neta-checkpoint-blocked-"), "not-a-directory");
		writeFileSync(blockedAgentDir, "occupied");
		const reports: string[] = [];
		const writer = new CheckpointWriter(blockedAgentDir, (message) => reports.push(message));

		expect(() => writer.schedule(emptyCheckpoint("write-failure", process.cwd()))).not.toThrow();
		await expect(writer.flush()).resolves.toBeUndefined();
		expect(writer.lastError).toBeInstanceOf(Error);
		expect(reports[0]).toContain("checkpoint write-failure was not saved");
	});

	it("defers materialization, coalesces telemetry, and preserves an external leader capture", async () => {
		const agentDir = tempDir("neta-checkpoint-writer-");
		const checkpoint = emptyCheckpoint("writer", process.cwd());
		const writer = new CheckpointWriter(agentDir);
		let materializations = 0;
		writer.scheduleDeferred(() => {
			materializations += 1;
			return checkpoint;
		});
		await Promise.resolve();
		expect(materializations).toBe(0);
		await writer.flush();
		expect(materializations).toBe(1);

		const stale = { ...checkpoint, updatedAt: 1 };
		recordLeaderVendorConversationId("writer", agentDir, "ses_external_capture_1234");
		writer.schedule(stale);
		await writer.flush();
		expect(readCheckpoint("writer", agentDir).leader.vendorConversationId).toBe("ses_external_capture_1234");
	});

	it("uses trailing debounce, a hard deadline, latest-wins, and immediate priority", async () => {
		const agentDir = tempDir("neta-checkpoint-timers-");
		const checkpoint = emptyCheckpoint("timers", process.cwd());
		const timers = new FakeTimers();
		const writer = new CheckpointWriter(agentDir, () => {}, timers);
		const snapshots: number[] = [];
		writer.scheduleDeferred(() => {
			snapshots.push(1);
			return { ...checkpoint, updatedAt: 1 };
		});
		timers.advance(99);
		writer.scheduleDeferred(() => {
			snapshots.push(2);
			return { ...checkpoint, updatedAt: 2 };
		});
		timers.advance(99);
		expect(snapshots).toEqual([]);
		timers.advance(1);
		await writer.flush();
		expect(snapshots).toEqual([2]);

		const hardSnapshots: number[] = [];
		for (let event = 0; event < 11; event += 1) {
			writer.scheduleDeferred(() => {
				hardSnapshots.push(event);
				return { ...checkpoint, updatedAt: event + 10 };
			});
			timers.advance(90);
		}
		expect(hardSnapshots).toEqual([]);
		timers.advance(10);
		await writer.flush();
		expect(hardSnapshots).toEqual([10]);

		let immediateMaterializations = 0;
		writer.scheduleDeferred(() => {
			immediateMaterializations += 1;
			return checkpoint;
		});
		writer.schedule({ ...checkpoint, updatedAt: 99 });
		await writer.flush();
		expect(immediateMaterializations).toBe(0);
	});

	it("fails visibly when an atomic write presents a different nonempty leader id", () => {
		const agentDir = tempDir("neta-checkpoint-race-");
		const checkpoint = emptyCheckpoint("race", process.cwd());
		writeCheckpointAtomic(
			{ ...checkpoint, leader: { ...checkpoint.leader, vendorConversationId: "id-a" } },
			agentDir,
		);
		expect(() =>
			writeCheckpointAtomic(
				{ ...checkpoint, leader: { ...checkpoint.leader, vendorConversationId: "id-b" } },
				agentDir,
			),
		).toThrow("refusing to replace it");
	});
});
