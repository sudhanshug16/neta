import { describe, expect, it } from "bun:test";
import { formatStatusSnapshot, formatWorkerSummary } from "../src/orchestrator/status.ts";
import type { WorkerStatusSnapshot, WorkerSummary } from "../src/types.ts";

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
	return {
		id: "ro1",
		name: "auth flow",
		role: "worker",
		tier: "senior",
		backend: "codex",
		writer: false,
		state: "running",
		task: "implement auth",
		startedAt: 1,
		scratchDir: "/tmp/neta-ro1",
		...overrides,
	};
}

describe("formatStatusSnapshot", () => {
	it("renders the writer slot, ordered queue, state groups, usage and linked notes", () => {
		const writer = worker({
			id: "rw1",
			writer: true,
			model: "gpt-4o",
			mode: "workspace-write",
			usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
		});
		const queued = worker({ id: "rw2", name: "docs pass", state: "queued", writer: true });
		const waiting = worker({ id: "ro3", name: "db decision", state: "waiting", pendingQuestion: "Use Postgres?" });
		const done = worker({ id: "ro4", name: "scout", role: "scout", state: "done" });
		const snapshot: WorkerStatusSnapshot = {
			writerSlot: writer,
			writerQueue: [queued],
			workers: { running: [writer], queued: [queued], waiting: [waiting], terminal: [done] },
			openNotes: [
				{
					id: "n1",
					text: "finish the auth rollout",
					open: true,
					createdAt: 1,
					workers: [{ workerId: "rw2", state: "queued" }],
				},
			],
		};

		const status = formatStatusSnapshot(snapshot);

		expect(status).toContain('Writer slot:\n  rw1 "auth flow" worker/senior | backend=codex | running | writer');
		expect(status).toContain("model=gpt-4o | mode=workspace-write | 2,000,000 tokens, est. $12.50");
		expect(status).toContain('Writer queue:\n  rw2 "docs pass" worker/senior | backend=codex | queued | writer');
		expect(status).toContain(
			'Waiting (blocked on leader answer):\n  ro3 "db decision" worker/senior | backend=codex | waiting | ' +
				"model unknown — backend default | asking: Use Postgres?",
		);
		expect(status).toContain(
			"Terminal:\n  ro4 scout/senior | backend=codex | done | model unknown — backend default",
		);
		expect(status).toContain('Open notes:\n  n1 "finish the auth rollout" (rw2 queued)');
	});

	// A blank where the model should be reads as "fine"; only a worker that has
	// not started yet is allowed to say nothing.
	it("says loudly when a started worker's model is unknown", () => {
		expect(formatWorkerSummary(worker())).toContain("model unknown — backend default");
		expect(formatWorkerSummary(worker({ state: "queued" }))).not.toContain("model unknown");
		expect(formatWorkerSummary(worker({ state: "starting" }))).not.toContain("model unknown");
		expect(formatWorkerSummary(worker({ model: "sonnet" }))).toContain("model=sonnet");
	});
});
