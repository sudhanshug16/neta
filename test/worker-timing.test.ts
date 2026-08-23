import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySessionCheckpoint, validateCheckpoint } from "../src/checkpoint.ts";
import { readV6CheckpointMetadata, v6CheckpointStorePath, writeV6Checkpoint } from "../src/checkpoint-store.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import { formatWorkerDuration } from "../src/orchestrator/status.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { fixtureBackendConfig } from "./helpers.ts";

class Driver implements WorkerTransportDriver {
	private resolve: ((outcome: PromptOutcome) => void) | undefined;
	readonly options: TransportOptions;

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

	finish(summary = "done"): void {
		const resolve = this.resolve;
		this.resolve = undefined;
		if (!resolve) throw new Error("no prompt in flight");
		resolve({ ok: true, summary });
	}

	cancel(): boolean {
		return false;
	}

	async kill(): Promise<void> {}

	markTerminal(): void {}
}

function makeManager(now: () => number, drivers: Driver[]): WorkerManager {
	return new WorkerManager({
		cwd: process.cwd(),
		agentDir: tmpdir(),
		config: fixtureBackendConfig(),
		channelAddress: join(tmpdir(), `neta-timing-${Math.random()}.sock`),
		onEvent: () => {},
		now,
		createTransport: (options) => {
			const driver = new Driver(options);
			drivers.push(driver);
			return driver;
		},
	});
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("worker elapsed wall time", () => {
	it("renders a read-only worker's live active interval", async () => {
		let now = 1_000;
		const drivers: Driver[] = [];
		const manager = makeManager(() => now, drivers);
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "read" });

		now = 13_003;
		expect(formatWorkerDuration(manager.get(worker.id), now)).toBe("active 12s");
		expect(manager.status()).toContain("active 12s");
		await manager.dispose();
	});

	it("keeps queue delay separate when a writer starts", async () => {
		let now = 1_000;
		const drivers: Driver[] = [];
		const manager = makeManager(() => now, drivers);
		const holder = await manager.spawn({ role: "worker", tier: "expert", task: "hold", writer: true });
		now = 4_000;
		const queued = await manager.spawn({ role: "worker", tier: "expert", task: "queued", writer: true });
		now = 124_000;
		expect(formatWorkerDuration(queued, now)).toBe("active 0s | queued 2m");

		now = 130_000;
		drivers[0]?.finish("holder done");
		await manager.wait([holder.id], 1_000);
		await tick();
		const running = manager.get(queued.id);
		expect(running.state).toBe("running");
		expect(running.queuedMs).toBe(126_000);
		expect(running.activeMs).toBe(0);
		expect(formatWorkerDuration(running, now)).toBe("active 0s | queued 2m 6s");
		await manager.dispose();
	});

	it("freezes a killed queued worker without booking queue time as active", async () => {
		let now = 1_000;
		const drivers: Driver[] = [];
		const manager = makeManager(() => now, drivers);
		await manager.spawn({ role: "worker", tier: "expert", task: "hold", writer: true });
		now = 4_000;
		const queued = await manager.spawn({ role: "worker", tier: "expert", task: "queued", writer: true });
		now = 9_000;
		const killed = await manager.kill(queued.id);
		expect(killed.state).toBe("killed");
		expect(killed.activeMs).toBe(0);
		expect(killed.queuedMs).toBe(5_000);
		now = 90_000;
		expect(formatWorkerDuration(manager.get(queued.id), now)).toBe("active 0s | queued 5s");
		await manager.dispose();
	});

	it("freezes terminal time and accumulates exact-session revival time", async () => {
		let now = 1_000;
		const drivers: Driver[] = [];
		const manager = makeManager(() => now, drivers);
		const worker = await manager.spawn({ role: "worker", tier: "expert", task: "revive" });
		now = 10_000;
		drivers[0]?.finish("first");
		await manager.wait([worker.id], 1_000);
		const first = manager.get(worker.id);
		expect(first.activeMs).toBe(9_000);
		expect(first.activeStartedAt).toBeUndefined();
		now = 20_000;
		const resumed = await manager.steer(worker.id, "continue");
		expect(resumed.worker.activeMs).toBe(9_000);
		expect(resumed.worker.activeStartedAt).toBe(20_000);
		now = 25_000;
		drivers[1]?.finish("second");
		await manager.wait([worker.id], 1_000);
		now = 90_000;
		const terminal = manager.get(worker.id);
		expect(terminal.activeMs).toBe(14_000);
		expect(terminal.activeStartedAt).toBeUndefined();
		expect(formatWorkerDuration(terminal, now)).toBe("active 14s");
		await manager.dispose();
	});

	it("closes active and queued intervals at recovery instead of counting downtime", () => {
		const checkpoint = {
			...emptySessionCheckpoint({ id: "recovery", canonicalCwd: process.cwd(), leaderBackend: "codex" }),
			shutdown: { at: 1, processesStopped: true, by: "graceful" as const },
			workers: [
				{
					id: "ro1",
					name: "active",
					role: "scout",
					tier: "expert" as const,
					backend: "codex",
					writer: false,
					task: "active",
					state: "running" as const,
					startedAt: 1_000,
					updatedAt: 2_000,
					activeMs: 3_000,
					activeStartedAt: 2_000,
					log: [],
					logFirstIndex: 0,
					logCursor: 0,
					pendingBrief: [],
				},
				{
					id: "rw2",
					name: "queued",
					role: "worker",
					tier: "expert" as const,
					backend: "codex",
					writer: true,
					task: "queued",
					state: "queued" as const,
					startedAt: 1_000,
					updatedAt: 2_000,
					queuedMs: 100,
					queuedStartedAt: 2_000,
					log: [],
					logFirstIndex: 0,
					logCursor: 0,
					pendingBrief: [],
				},
			],
			writerQueue: ["rw2"],
			activeWriter: "ro1",
		};
		const manager = WorkerManager.hydrate(
			{
				cwd: process.cwd(),
				agentDir: tmpdir(),
				config: fixtureBackendConfig(),
				channelAddress: join(tmpdir(), "neta-recovery-timing.sock"),
				onEvent: () => {},
				now: () => 11_000,
			},
			checkpoint as never,
		);
		expect(manager.get("ro1")).toMatchObject({ state: "interrupted", activeMs: 12_000, activeStartedAt: undefined });
		expect(manager.get("rw2")).toMatchObject({ state: "interrupted", queuedMs: 9_100, queuedStartedAt: undefined });
	});

	it("accepts old v5 and v6 records without timing and carries v5 timing into v6", () => {
		const old = emptySessionCheckpoint({ id: "old", canonicalCwd: process.cwd(), leaderBackend: "codex" });
		const oldWorker = {
			id: "ro1",
			name: "worker",
			role: "scout",
			tier: "expert" as const,
			backend: "codex",
			writer: false,
			task: "old",
			state: "done" as const,
			startedAt: 1,
			updatedAt: 2,
			endedAt: 2,
			finalResult: "done",
			log: [],
			logFirstIndex: 0,
			logCursor: 0,
			pendingBrief: [],
		};
		const validated = validateCheckpoint({ ...old, schemaVersion: 5, workers: [oldWorker] });
		expect(validated.workers[0]?.activeMs).toBeUndefined();

		const root = mkdtempSync(join(tmpdir(), "neta-timing-migration-"));
		try {
			const store = v6CheckpointStorePath("old", root);
			writeV6Checkpoint({ ...validated, workers: [oldWorker] }, store);
			expect(readV6CheckpointMetadata(store).checkpoint.workers[0]?.activeMs).toBeUndefined();
			rmSync(store, { recursive: true, force: true });
			writeV6Checkpoint({ ...validated, workers: [{ ...oldWorker, activeMs: 7_000, queuedMs: 2_000 }] }, store);
			const migrated = readV6CheckpointMetadata(store).checkpoint;
			expect(migrated.workers[0]).toMatchObject({ activeMs: 7_000, queuedMs: 2_000 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders timing in terminal wait handoffs without reading terminal detail", async () => {
		let now = 1_000;
		const drivers: Driver[] = [];
		const manager = makeManager(() => now, drivers);
		const worker = await manager.spawn({ role: "worker", tier: "expert", task: "finish" });
		now = 6_000;
		drivers[0]?.finish("finished");
		const waited = await manager.wait([worker.id], 1_000);
		const handoff = await manager.leader(
			{ type: "wait", token: manager.leaderToken, workerIds: [worker.id], timeoutMs: 1 },
			new AbortController().signal,
		);
		expect(handoff.ok && handoff.text).toContain("active 5s");
		expect(waited.workers[0]?.activeMs).toBe(5_000);
		await manager.dispose();
	});
});
