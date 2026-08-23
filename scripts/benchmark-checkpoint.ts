import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointWriter, emptySessionCheckpoint } from "../src/checkpoint.ts";

const EVENTS_PER_SECOND = 50;
const STATE_BYTES = 46 * 1024 * 1024;

function baseCheckpoint(id: string, payload: string) {
	return {
		...emptySessionCheckpoint({ id, canonicalCwd: process.cwd(), leaderBackend: "claude" }),
		workers: [
			{
				id: "worker-1",
				name: "worker",
				role: "scout",
				tier: "expert" as const,
				backend: "fake",
				writer: false,
				task: payload,
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
}

async function eager(agentDir: string, checkpoint: ReturnType<typeof baseCheckpoint>): Promise<number> {
	const writer = new CheckpointWriter(agentDir);
	const started = process.hrtime.bigint();
	for (let event = 0; event < EVENTS_PER_SECOND; event += 1) {
		writer.schedule({ ...checkpoint, updatedAt: event + 1 });
		await writer.flush();
	}
	return Number(process.hrtime.bigint() - started) / 1_000_000;
}

async function deferred(agentDir: string, checkpoint: ReturnType<typeof baseCheckpoint>): Promise<{
	ms: number;
	materializations: number;
	writer: CheckpointWriter;
}> {
	const writer = new CheckpointWriter(agentDir);
	let materializations = 0;
	const started = process.hrtime.bigint();
	for (let event = 0; event < EVENTS_PER_SECOND; event += 1) {
		writer.scheduleDeferred(() => {
			materializations += 1;
			return { ...checkpoint, updatedAt: event + 1 };
		});
	}
	await writer.flush();
	return { ms: Number(process.hrtime.bigint() - started) / 1_000_000, materializations, writer };
}

const root = mkdtempSync(join(tmpdir(), "neta-checkpoint-benchmark-"));
try {
	const payload = "x".repeat(STATE_BYTES);
	const eagerDir = join(root, "eager");
	const deferredDir = join(root, "deferred");
	const eagerMs = await eager(eagerDir, baseCheckpoint("eager", payload));
	const deferredResult = await deferred(deferredDir, baseCheckpoint("deferred", payload));
	const eagerWrites = EVENTS_PER_SECOND;
	const deferredWrites = deferredResult.writer.writeCount;
	const materializationRatio = EVENTS_PER_SECOND / deferredResult.materializations;
	const writeRatio = eagerWrites / deferredWrites;
	const cpuRatio = eagerMs / deferredResult.ms;

	console.log(
		JSON.stringify(
			{
				stateMiB: STATE_BYTES / (1024 * 1024),
				eventsPerSecond: EVENTS_PER_SECOND,
				eager: { materializations: EVENTS_PER_SECOND, writes: eagerWrites, ms: eagerMs },
				deferred: {
					materializations: deferredResult.materializations,
					writes: deferredWrites,
					writesPerSecond: deferredWrites,
					ms: deferredResult.ms,
				},
				ratio: { materializations: materializationRatio, writes: writeRatio, cpu: cpuRatio },
				deterministicRequirements: {
					materializationsAtLeast40x: materializationRatio >= 40,
					writesAtLeast40xFewer: writeRatio >= 40,
					deferredWritesAtMost1_1PerSecond: deferredWrites <= 1.1,
				},
				measuredTiming: { checkpointCpuAtLeast4xLower: cpuRatio >= 4 },
			},
			2,
		),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
