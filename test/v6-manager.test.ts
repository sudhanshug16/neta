import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointWriter, emptySessionCheckpoint } from "../src/checkpoint.ts";
import {
	readV6CheckpointMetadata,
	type V6ReadCounters,
	v6CheckpointStorePath,
	writeV6Checkpoint,
} from "../src/checkpoint-store.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import type { WorkerEvent } from "../src/types.ts";
import { fixtureBackendConfig } from "./helpers.ts";

class Driver implements WorkerTransportDriver {
	readonly options: TransportOptions;
	private resolve: ((outcome: PromptOutcome) => void) | undefined;

	constructor(options: TransportOptions) {
		this.options = options;
	}

	async start(): Promise<void> {}

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
		driver?.options.events.log("status", "durable terminal detail");
		driver?.finish({ ok: true, summary: "exact terminal result" });
		await manager.wait([summary.id], 1000);
		const snapshot = manager.checkpointSnapshot();
		expect(snapshot.workers[0]?.log).toEqual([]);
		const detailReadsBeforeStatus = counters.detailReads ?? 0;
		manager.statusSnapshot();
		expect(counters.detailReads ?? 0).toBe(detailReadsBeforeStatus);
		const inspection = manager.inspect(summary.id);
		expect(inspection.entries.map((entry) => entry.text)).toContain("durable terminal detail");
		expect((counters.detailReads ?? 0) > detailReadsBeforeStatus).toBe(true);
		await manager.dispose();
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
});
