import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointWriter, emptySessionCheckpoint } from "../src/checkpoint.ts";
import {
	readV6Checkpoint,
	readV6CheckpointMetadata,
	readV6Manifest,
	type V6ReadCounters,
	v6CheckpointStorePath,
	v6ManifestPath,
	writeV6Checkpoint,
} from "../src/checkpoint-store.ts";
import { TERMINAL_HOT_STATE_MAX_BYTES, WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import type { WorkerEvent } from "../src/types.ts";
import { fixtureBackendConfig, waitFor } from "./helpers.ts";

class Driver implements WorkerTransportDriver {
	readonly options: TransportOptions;
	started = false;
	killed = false;
	private startGate: Promise<void> | undefined;
	private releaseStartGate: (() => void) | undefined;
	private resolve: ((outcome: PromptOutcome) => void) | undefined;

	constructor(options: TransportOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		this.started = true;
		this.options.events.vendorSession(`vendor-${this.options.workerId}`);
		await this.startGate;
	}

	holdStart(): void {
		this.startGate = new Promise<void>((resolve) => {
			this.releaseStartGate = resolve;
		});
	}

	releaseStart(): void {
		this.releaseStartGate?.();
	}

	prompt(): Promise<PromptOutcome> {
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	async kill(): Promise<void> {
		this.killed = true;
	}

	cancel(): boolean {
		return false;
	}

	markTerminal(): void {}

	finish(outcome: PromptOutcome): void {
		const resolve = this.resolve;
		this.resolve = undefined;
		if (!resolve) throw new Error("no prompt");
		resolve(outcome);
	}
}

function checkpoint(id: string) {
	return {
		...emptySessionCheckpoint({ id, canonicalCwd: process.cwd(), leaderBackend: "codex" }),
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

describe("v6 manager integration", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("evicts terminal logs after durable publication and lazily reads one worker", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-manager-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("session", agentDir);
		writeV6Checkpoint(checkpoint("session"), storePath);
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6");
		const counters: V6ReadCounters = {};
		let driver: Driver | undefined;
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: (_event: WorkerEvent) => {},
			checkpoint: { id: "session", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			checkpointReadCounters: counters,
			createTransport: (options) => {
				driver = new Driver(options);
				return driver;
			},
		});
		const summary = await manager.spawn({ role: "scout", tier: "expert", task: "inspect" });
		await manager.flushCheckpoint();
		driver?.options.events.log("status", "durable terminal detail");
		const beforeTelemetry = readV6Manifest(storePath);
		const stateBlobCountBefore = readdirSync(join(storePath, "blobs")).length;
		await manager.flushCheckpoint();
		const afterTelemetry = readV6Manifest(storePath);
		expect(afterTelemetry.state).toBe(beforeTelemetry.state);
		expect(readdirSync(join(storePath, "blobs")).length).toBe(stateBlobCountBefore + 1);
		expect(writer.writeCounters.stateHashReuses).toBeGreaterThan(0);
		driver?.finish({ ok: true, summary: "exact terminal result" });
		await manager.wait([summary.id], 1000);
		const snapshot = manager.checkpointSnapshot();
		expect(snapshot.workers[0]?.log).toEqual([]);
		const detailReadsBeforeStatus = counters.detailReads ?? 0;
		manager.statusSnapshot();
		expect(counters.detailReads ?? 0).toBe(detailReadsBeforeStatus);
		manager.createNote("a later structural update");
		await manager.flushCheckpoint();
		expect(manager.get(summary.id).result).toBe("exact terminal result");
		expect(counters.detailReads ?? 0).toBe(detailReadsBeforeStatus);
		const inspection = manager.inspect(summary.id);
		expect(inspection.entries.map((entry) => entry.text)).toContain("durable terminal detail");
		expect((counters.detailReads ?? 0) > detailReadsBeforeStatus).toBe(true);
		const next = await manager.spawn({ role: "scout", tier: "expert", task: "next" });
		await manager.flushCheckpoint();
		expect(
			readV6CheckpointMetadata(storePath).checkpoint.workers.find((item) => item.id === summary.id)?.archived,
		).toBe(true);
		expect(readV6Checkpoint(storePath).checkpoint.workers.find((item) => item.id === summary.id)?.finalResult).toBe(
			"exact terminal result",
		);
		driver?.finish({ ok: true, summary: "next result" });
		await manager.wait([next.id], 1_000);
		await manager.dispose();
	});

	it("publishes archive markers only after startup and rolls back when archive publication fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-archive-race-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("archive-race", agentDir);
		writeV6Checkpoint(checkpoint("archive-race"), storePath);
		let faultInjected = false;
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6", {
			fail: (event) => {
				if (event.type !== "manifest-rename") return;
				const next = JSON.parse(readFileSync(event.from, "utf8")) as {
					activeWorkers?: Array<{ id: string }>;
					terminalIndexShards?: string[];
				};
				const current = JSON.parse(readFileSync(v6ManifestPath(storePath), "utf8")) as {
					terminalIndexShards?: string[];
				};
				const isArchiveCommit =
					next.activeWorkers?.some((worker) => worker.id === "ro2") === true &&
					next.terminalIndexShards?.some((hash, index) => hash !== current.terminalIndexShards?.[index]) === true;
				if (isArchiveCommit && !faultInjected) {
					faultInjected = true;
					throw new Error("archive publication fault");
				}
			},
		});
		const drivers: Driver[] = [];
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: () => {},
			checkpoint: { id: "archive-race", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			createTransport: (options) => {
				const driver = new Driver(options);
				drivers.push(driver);
				return driver;
			},
		});
		const first = await manager.spawn({ role: "scout", tier: "expert", task: "first" });
		drivers[0]?.finish({ ok: true, summary: "first result" });
		await manager.wait([first.id], 1_000);
		await expect(manager.spawn({ role: "scout", tier: "expert", task: "second" })).rejects.toThrow(
			/Archive publication failed/,
		);
		expect(drivers).toHaveLength(2);
		expect(drivers[1]?.started).toBe(true);
		expect(drivers[1]?.killed).toBe(true);
		expect(manager.tailLog(first.id).archived).toBe(false);
		expect(manager.get("ro2").state).toBe("failed");
		drivers[1]?.options.events.log("status", "later telemetry succeeds");
		await writer.flush();
		expect(writer.lastError).toBeUndefined();
		const persisted = readV6CheckpointMetadata(storePath).checkpoint.workers;
		expect(persisted.find((worker) => worker.id === first.id)?.archived).toBe(false);
		expect(persisted.find((worker) => worker.id === "ro2")?.state).toBe("failed");
		await manager.dispose();
	});

	it("leaves the prior terminal batch unarchived when the new transport fails to start", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-startup-archive-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("startup-archive", agentDir);
		writeV6Checkpoint(checkpoint("startup-archive"), storePath);
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6");
		const drivers: Driver[] = [];
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: () => {},
			checkpoint: { id: "startup-archive", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			createTransport: (options) => {
				const driver = new Driver(options);
				if (drivers.length === 1) driver.start = async () => Promise.reject(new Error("startup failed"));
				drivers.push(driver);
				return driver;
			},
		});
		const first = await manager.spawn({ role: "scout", tier: "expert", task: "first" });
		drivers[0]?.finish({ ok: true, summary: "first result" });
		await manager.wait([first.id], 1_000);

		await expect(manager.spawn({ role: "scout", tier: "expert", task: "second" })).rejects.toThrow("startup failed");
		const persisted = readV6CheckpointMetadata(storePath).checkpoint.workers;
		expect(persisted.find((worker) => worker.id === first.id)?.archived).toBe(false);
		expect(persisted.find((worker) => worker.id === "ro2")?.state).toBe("failed");
		await manager.dispose();
	});

	it("publishes the archive for a queued writer through the same start path", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-queued-archive-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("queued-archive", agentDir);
		writeV6Checkpoint(checkpoint("queued-archive"), storePath);
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6");
		const drivers: Driver[] = [];
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: () => {},
			checkpoint: { id: "queued-archive", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			createTransport: (options) => {
				const driver = new Driver(options);
				drivers.push(driver);
				return driver;
			},
		});
		const first = await manager.spawn({ role: "worker", tier: "expert", task: "first", writer: true });
		const queued = await manager.spawn({ role: "worker", tier: "expert", task: "queued", writer: true });
		drivers[0]?.finish({ ok: true, summary: "first result" });
		await manager.wait([first.id], 1_000);
		await waitFor(() => manager.get(queued.id).state === "running");
		await writer.flush();
		expect(
			readV6CheckpointMetadata(storePath).checkpoint.workers.find((item) => item.id === first.id)?.archived,
		).toBe(true);
		drivers[1]?.finish({ ok: true, summary: "queued result" });
		await manager.wait([queued.id], 1_000);
		await manager.dispose();
	});

	it("rolls back a queued writer archive failure and closes its transport", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-queued-archive-fault-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("queued-archive-fault", agentDir);
		writeV6Checkpoint(checkpoint("queued-archive-fault"), storePath);
		let faultInjected = false;
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6", {
			fail: (event) => {
				if (event.type !== "manifest-rename" || faultInjected) return;
				const next = JSON.parse(readFileSync(event.from, "utf8")) as {
					activeWorkers?: Array<{ id: string }>;
					terminalIndexShards?: string[];
				};
				const archived = next.terminalIndexShards?.some((hash) => {
					const shard = JSON.parse(readFileSync(join(storePath, "shards", `${hash}.json`), "utf8")) as {
						entries?: Array<{ summary?: { id?: string; archived?: boolean } }>;
					};
					return shard.entries?.some((entry) => entry.summary?.id === "rw1" && entry.summary.archived === true);
				});
				if (next.activeWorkers?.some((worker) => worker.id === "rw2") && archived) {
					faultInjected = true;
					throw new Error("queued archive fault");
				}
			},
		});
		const drivers: Driver[] = [];
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: () => {},
			checkpoint: { id: "queued-archive-fault", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			createTransport: (options) => {
				const driver = new Driver(options);
				drivers.push(driver);
				return driver;
			},
		});
		const first = await manager.spawn({ role: "worker", tier: "expert", task: "first", writer: true });
		const queued = await manager.spawn({ role: "worker", tier: "expert", task: "queued", writer: true });
		drivers[0]?.finish({ ok: true, summary: "first result" });
		await manager.wait([first.id], 1_000);
		await waitFor(() => manager.get(queued.id).state === "failed");
		expect(drivers[1]?.killed).toBe(true);
		expect(
			readV6CheckpointMetadata(storePath).checkpoint.workers.find((item) => item.id === first.id)?.archived,
		).toBe(false);
		await manager.dispose();
	});

	it("recomputes archive candidates after a worker finishes during transport startup", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-finish-startup-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("finish-startup", agentDir);
		writeV6Checkpoint(checkpoint("finish-startup"), storePath);
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6");
		const drivers: Driver[] = [];
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: () => {},
			checkpoint: { id: "finish-startup", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			createTransport: (options) => {
				const driver = new Driver(options);
				if (drivers.length === 1) driver.holdStart();
				drivers.push(driver);
				return driver;
			},
		});
		const first = await manager.spawn({ role: "scout", tier: "expert", task: "first" });
		const secondSpawn = manager.spawn({ role: "scout", tier: "expert", task: "second" });
		await waitFor(() => drivers.length === 2);
		drivers[0]?.finish({ ok: true, summary: "first result" });
		await manager.wait([first.id], 1_000);
		drivers[1]?.releaseStart();
		await secondSpawn;
		await writer.flush();
		expect(
			readV6CheckpointMetadata(storePath).checkpoint.workers.find((item) => item.id === first.id)?.archived,
		).toBe(true);
		drivers[1]?.finish({ ok: true, summary: "second result" });
		await manager.wait(["ro2"], 1_000);
		await manager.dispose();
	});

	it("does not archive a worker revived during transport startup", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-revive-startup-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("revive-startup", agentDir);
		writeV6Checkpoint(checkpoint("revive-startup"), storePath);
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6");
		const drivers: Driver[] = [];
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: () => {},
			checkpoint: { id: "revive-startup", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			createTransport: (options) => {
				const driver = new Driver(options);
				if (drivers.length === 1) driver.holdStart();
				drivers.push(driver);
				return driver;
			},
		});
		const first = await manager.spawn({ role: "scout", tier: "expert", task: "first" });
		drivers[0]?.finish({ ok: true, summary: "first result" });
		await manager.wait([first.id], 1_000);
		const secondSpawn = manager.spawn({ role: "scout", tier: "expert", task: "second" });
		await waitFor(() => drivers.length === 2);
		const revived = await manager.steer(first.id, "continue exact session");
		expect(revived.worker.state).toBe("running");
		drivers[1]?.releaseStart();
		await secondSpawn;
		await writer.flush();
		expect(
			readV6CheckpointMetadata(storePath).checkpoint.workers.find((item) => item.id === first.id)?.archived,
		).toBe(false);
		drivers[2]?.finish({ ok: true, summary: "revived result" });
		drivers[1]?.finish({ ok: true, summary: "second result" });
		await manager.wait([first.id, "ro2"], 1_000);
		await manager.dispose();
	});

	it("wakes terminal waiters when a deferred checkpoint factory throws", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-terminal-factory-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("terminal-factory", agentDir);
		writeV6Checkpoint(checkpoint("terminal-factory"), storePath);
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6");
		const drivers: Driver[] = [];
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: () => {},
			checkpoint: { id: "terminal-factory", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			createTransport: (options) => {
				const driver = new Driver(options);
				drivers.push(driver);
				return driver;
			},
		});
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "finish" });
		const bad = writer.scheduleDeferredDelta(() => {
			throw new Error("terminal deferred factory fault");
		}, "terminal-factory");
		drivers[0]?.finish({ ok: true, summary: "terminal result" });
		await manager.wait([worker.id], 1_000);
		expect(manager.get(worker.id).state).toBe("done");
		await expect(bad).rejects.toThrow("terminal deferred factory fault");
		const valid = writer.scheduleDelta({ id: "terminal-factory", lane: "worker", workers: [] });
		await valid;
		await writer.flush();
		await manager.dispose();
	});

	it("revival timing uses its live interval without reading terminal detail", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-revival-timing-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("revival", agentDir);
		writeV6Checkpoint(checkpoint("revival"), storePath);
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6");
		const counters: V6ReadCounters = {};
		const drivers: Driver[] = [];
		let now = 1_000;
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: () => {},
			checkpoint: { id: "revival", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			checkpointReadCounters: counters,
			now: () => now,
			createTransport: (options) => {
				const driver = new Driver(options);
				drivers.push(driver);
				return driver;
			},
		});

		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "revive" });
		drivers[0]?.options.events.log("status", "terminal detail remains lazy");
		now = 10_000;
		drivers[0]?.finish({ ok: true, summary: "first" });
		await manager.wait([worker.id], 1_000);
		const terminal = manager.get(worker.id);
		expect(terminal.activeMs).toBe(9_000);
		expect(terminal.activeStartedAt).toBeUndefined();
		const detailReadsBeforeRevival = counters.detailReads ?? 0;

		now = 20_000;
		const resumed = await manager.steer(worker.id, "continue");
		expect(resumed.worker.state).toBe("running");
		expect(manager.get(worker.id)).toMatchObject({ activeMs: 9_000, activeStartedAt: 20_000 });
		const revivedPersisted = readV6CheckpointMetadata(storePath).checkpoint.workers;
		expect(revivedPersisted).toHaveLength(1);
		expect(revivedPersisted[0]).toMatchObject({ id: worker.id, state: "running" });
		expect(manager.status()).toContain("active 9s");

		now = 23_000;
		expect(manager.get(worker.id)).toMatchObject({ activeMs: 9_000, activeStartedAt: 20_000 });
		expect(manager.status()).toContain("active 12s");
		expect(counters.detailReads ?? 0).toBe(detailReadsBeforeRevival);

		now = 25_000;
		drivers[1]?.finish({ ok: true, summary: "second" });
		await manager.wait([worker.id], 1_000);
		await manager.dispose();
	});

	it("bounds terminal hot state for large outcomes and many terminal workers", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-bounded-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("large", agentDir);
		writeV6Checkpoint(checkpoint("large"), storePath);
		const writer = new CheckpointWriter(agentDir, () => {}, undefined, "v6");
		const counters: V6ReadCounters = {};
		let driver: Driver | undefined;
		const manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir,
			config: fixtureBackendConfig(),
			channelAddress: join(root, "channel.sock"),
			onEvent: () => {},
			checkpoint: { id: "large", leaderBackend: "codex", writer },
			checkpointStorePath: storePath,
			checkpointReadCounters: counters,
			createTransport: (options) => {
				driver = new Driver(options);
				return driver;
			},
		});
		const largeTask = "task-".repeat(20_000);
		const largeOutcome = "outcome-".repeat(20_000);
		const summary = await manager.spawn({ role: "scout", tier: "expert", task: largeTask });
		for (let index = 0; index < 500; index += 1)
			driver?.options.events.log("text", `${"x".repeat(200)}-log-${index}`);
		driver?.finish({ ok: true, summary: largeOutcome });
		await manager.wait([summary.id], 1000);
		expect(manager.terminalHotStateBytes(summary.id)).toBeLessThanOrEqual(TERMINAL_HOT_STATE_MAX_BYTES);
		const detailReadsBeforeStatus = counters.detailReads ?? 0;
		manager.statusSnapshot();
		expect(counters.detailReads ?? 0).toBe(detailReadsBeforeStatus);
		expect(manager.get(summary.id).result).toBe(largeOutcome);
		const inspected = manager.inspect(summary.id, { maxEntries: 40, maxChars: 6000 });
		expect(inspected.worker.result).toBe(largeOutcome);
		expect(inspected.entries.at(-2)?.text).toContain("log-499");

		const manyStorePath = v6CheckpointStorePath("many", agentDir);
		const manyWorkers = Array.from({ length: 1000 }, (_, index) => ({
			id: `w${index + 1}`,
			name: "worker",
			role: "scout",
			tier: "expert" as const,
			backend: "codex",
			writer: false,
			task: `large task ${"t".repeat(20_000)}`,
			state: "done" as const,
			startedAt: 1,
			updatedAt: 2,
			endedAt: 2,
			finalResult: `large outcome ${"o".repeat(20_000)}`,
			log: [],
			logFirstIndex: 0,
			logCursor: 0,
			pendingBrief: [],
		}));
		writeV6Checkpoint({ ...checkpoint("many"), workers: manyWorkers }, manyStorePath);
		const manyCounters: V6ReadCounters = {};
		const many = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: join(root, "many.channel.sock"),
				onEvent: () => {},
				checkpoint: { id: "many", leaderBackend: "codex", writer: new CheckpointWriter(agentDir) },
				checkpointStorePath: manyStorePath,
				checkpointReadCounters: manyCounters,
			},
			readV6CheckpointMetadata(manyStorePath).checkpoint as Parameters<typeof WorkerManager.hydrate>[1],
		);
		expect(many.terminalHotStateCount()).toBe(1000);
		expect(many.terminalHotStateBytes("w1")).toBeLessThanOrEqual(TERMINAL_HOT_STATE_MAX_BYTES);
		expect(many.terminalHotStateBytes("w1000")).toBeLessThanOrEqual(TERMINAL_HOT_STATE_MAX_BYTES);
		const manyStatus = many.statusSnapshot();
		expect(manyStatus.workers.terminal).toHaveLength(1000);
		expect(manyCounters.detailReads ?? 0).toBe(0);
		await manager.dispose();
		await many.dispose();
	});

	it("hydrates active workers inertly from v6 without restarting them", () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-recovery-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("recovery", agentDir);
		const source = {
			...checkpoint("recovery"),
			workers: [
				{
					id: "ro1",
					name: "worker",
					role: "scout",
					tier: "expert" as const,
					backend: "codex",
					writer: false,
					task: "active",
					state: "running" as const,
					startedAt: 1,
					updatedAt: 1,
					log: [],
					logFirstIndex: 0,
					logCursor: 0,
					pendingBrief: [],
				},
			],
		};
		writeV6Checkpoint(source, storePath);
		const hydrated = readV6CheckpointMetadata(storePath).checkpoint as Parameters<typeof WorkerManager.hydrate>[1];
		const transports: Driver[] = [];
		const manager = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: join(root, "channel.sock"),
				onEvent: () => {},
				checkpoint: { id: "recovery", leaderBackend: "codex", writer: new CheckpointWriter(agentDir) },
				checkpointStorePath: storePath,
				createTransport: (options) => {
					const transport = new Driver(options);
					transports.push(transport);
					return transport;
				},
			},
			hydrated,
		);
		expect(manager.get("ro1").state).toBe("interrupted");
		expect(transports).toHaveLength(0);
	});

	it("retains hydrated active logs through interruption and preserves archived terminals", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-active-log-recovery-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("active-log-recovery", agentDir);
		const activeLog = Array.from({ length: 128 }, (_, index) => ({
			at: index + 5,
			kind: index % 2 === 0 ? ("status" as const) : ("text" as const),
			text: `event-${index}-${"x".repeat(256)}`,
		}));
		const terminal = {
			id: "terminal",
			name: "terminal",
			role: "scout",
			tier: "expert" as const,
			backend: "codex",
			writer: false,
			task: "archived",
			state: "done" as const,
			startedAt: 1,
			updatedAt: 2,
			endedAt: 2,
			finalResult: "done",
			archived: true,
			log: [],
			logFirstIndex: 0,
			logCursor: 0,
			pendingBrief: [],
		};
		const active = {
			id: "active",
			name: "active",
			role: "scout",
			tier: "expert" as const,
			backend: "codex",
			writer: false,
			task: "recover",
			state: "running" as const,
			startedAt: 3,
			updatedAt: 6,
			log: activeLog,
			logFirstIndex: 4,
			logCursor: 132,
			pendingBrief: [],
		};
		writeV6Checkpoint({ ...checkpoint("active-log-recovery"), workers: [terminal, active] }, storePath);
		const counters: V6ReadCounters = {};
		const hydrated = readV6CheckpointMetadata(storePath, counters, { hydrateActiveDetails: true }).checkpoint;
		expect(hydrated.workers.find((worker) => worker.id === "active")).toMatchObject({
			log: activeLog,
			logFirstIndex: 4,
			logCursor: 132,
		});
		expect(counters.detailReads).toBe(1);
		const manager = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: join(root, "channel.sock"),
				onEvent: () => {},
				checkpoint: {
					id: "active-log-recovery",
					leaderBackend: "codex",
					writer: new CheckpointWriter(agentDir, () => {}, undefined, "v6"),
				},
				checkpointStorePath: storePath,
			},
			hydrated as Parameters<typeof WorkerManager.hydrate>[1],
		);
		expect(manager.get("active").state).toBe("interrupted");
		expect(manager.tailLog("active", 4)).toMatchObject({ entries: activeLog, cursor: 132 });
		expect(manager.tailLog("terminal").archived).toBe(true);
		await manager.flushCheckpoint();
		const persisted = readV6Checkpoint(storePath).checkpoint;
		expect(persisted.workers.find((worker) => worker.id === "active")).toMatchObject({
			state: "interrupted",
			log: activeLog,
			logFirstIndex: 4,
			logCursor: 132,
		});
		expect(persisted.workers.find((worker) => worker.id === "terminal")?.archived).toBe(true);
		await manager.dispose();
	});

	it("hydrates terminal identity for exact revival and preserves native ownership", async () => {
		const root = mkdtempSync(join(tmpdir(), "neta-v6-terminal-identity-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const storePath = v6CheckpointStorePath("identity", agentDir);
		const terminal = {
			id: "ro1",
			name: "worker",
			role: "scout",
			tier: "expert" as const,
			backend: "claude",
			writer: false,
			task: "original",
			cwd: process.cwd(),
			state: "done" as const,
			startedAt: 1,
			updatedAt: 2,
			endedAt: 2,
			finalResult: "done",
			vendorSessionId: "vendor-original",
			modelId: "model-original",
			model: "model-original",
			nativeAttached: false,
			log: [],
			logFirstIndex: 0,
			logCursor: 0,
			pendingBrief: [],
		};
		writeV6Checkpoint({ ...checkpoint("identity"), workers: [terminal] }, storePath);
		const hydrated = readV6CheckpointMetadata(storePath).checkpoint as Parameters<typeof WorkerManager.hydrate>[1];
		const resumedDrivers: Driver[] = [];
		const manager = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: join(root, "channel.sock"),
				onEvent: () => {},
				checkpoint: {
					id: "identity",
					leaderBackend: "fake",
					writer: new CheckpointWriter(agentDir, () => {}, undefined, "v6"),
				},
				checkpointStorePath: storePath,
				createTransport: (options) => {
					const driver = new Driver(options);
					resumedDrivers.push(driver);
					return driver;
				},
			},
			hydrated,
		);
		await manager.steer("ro1", "continue");
		expect(resumedDrivers[0]?.options.resumeSessionId).toBe("vendor-original");
		expect(resumedDrivers[0]?.options.model).toBe("model-original");
		resumedDrivers[0]?.finish({ ok: true, summary: "resumed" });
		await manager.wait(["ro1"], 1_000);
		await manager.dispose();

		const ownedStorePath = v6CheckpointStorePath("owned", agentDir);
		writeV6Checkpoint(
			{ ...checkpoint("owned"), workers: [{ ...terminal, id: "ro2", nativeAttached: false }] },
			ownedStorePath,
		);
		const attachManager = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: join(root, "attach.channel.sock"),
				onEvent: () => {},
				checkpoint: {
					id: "owned",
					leaderBackend: "fake",
					writer: new CheckpointWriter(agentDir, () => {}, undefined, "v6"),
				},
				checkpointStorePath: ownedStorePath,
				panes: {
					open: () => ({ opened: true }),
					openRoom: () => ({ opened: true }),
					attach: () => ({ opened: true }),
				},
			},
			readV6CheckpointMetadata(ownedStorePath).checkpoint as Parameters<typeof WorkerManager.hydrate>[1],
		);
		await attachManager.reopenWorkerTui("ro2");
		await attachManager.flushCheckpoint();
		expect(readV6CheckpointMetadata(ownedStorePath).checkpoint.workers[0]?.nativeAttached).toBe(true);
		await attachManager.dispose();
		const owned = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: join(root, "owned.channel.sock"),
				onEvent: () => {},
				checkpoint: {
					id: "owned",
					leaderBackend: "fake",
					writer: new CheckpointWriter(agentDir, () => {}, undefined, "v6"),
				},
				checkpointStorePath: ownedStorePath,
			},
			readV6CheckpointMetadata(ownedStorePath).checkpoint as Parameters<typeof WorkerManager.hydrate>[1],
		);
		await expect(owned.reopenWorkerTui("ro2")).rejects.toThrow(/native client/);
		await owned.dispose();
	});
});
