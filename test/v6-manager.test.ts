import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointWriter, emptySessionCheckpoint } from "../src/checkpoint.ts";
import {
	readV6Checkpoint,
	readV6CheckpointMetadata,
	readV6Manifest,
	type V6ReadCounters,
	v6CheckpointStorePath,
	writeV6Checkpoint,
} from "../src/checkpoint-store.ts";
import { TERMINAL_HOT_STATE_MAX_BYTES, WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import type { WorkerEvent } from "../src/types.ts";
import { fixtureBackendConfig } from "./helpers.ts";

class Driver implements WorkerTransportDriver {
	readonly options: TransportOptions;
	private resolve: ((outcome: PromptOutcome) => void) | undefined;

	constructor(options: TransportOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		this.options.events.vendorSession(`vendor-${this.options.workerId}`);
	}

	prompt(): Promise<PromptOutcome> {
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	async kill(): Promise<void> {}

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
		expect(
			readV6Checkpoint(storePath).checkpoint.workers.find((item) => item.id === summary.id)?.finalResult,
		).toBe("exact terminal result");
		driver?.finish({ ok: true, summary: "next result" });
		await manager.wait([next.id], 1_000);
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
				checkpoint: { id: "identity", leaderBackend: "fake", writer: new CheckpointWriter(agentDir, () => {}, undefined, "v6") },
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
				checkpoint: { id: "owned", leaderBackend: "fake", writer: new CheckpointWriter(agentDir, () => {}, undefined, "v6") },
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
