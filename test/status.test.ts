import { describe, expect, it } from "bun:test";
import { formatStatusSnapshot } from "../src/orchestrator/status.ts";
import type { WorkerStatusSnapshot, WorkerSummary } from "../src/types.ts";

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
	return {
		id: "w1",
		name: "auth flow",
		role: "worker",
		tier: "senior",
		backend: "codex",
		writer: false,
		state: "running",
		task: "implement auth",
		startedAt: 1,
		scratchDir: "/tmp/neta-w1",
		...overrides,
	};
}

describe("formatStatusSnapshot", () => {
	it("renders the writer slot, ordered queue, state groups, usage and linked notes", () => {
		const writer = worker({
			writer: true,
			model: "gpt-4o",
			mode: "workspace-write",
			usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
		});
		const queued = worker({ id: "w2", name: "docs pass", state: "queued", writer: true });
		const waiting = worker({ id: "w3", name: "db decision", state: "waiting", pendingQuestion: "Use Postgres?" });
		const done = worker({ id: "w4", name: "scout", role: "scout", state: "done" });
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
					workers: [{ workerId: "w2", state: "queued" }],
				},
			],
		};

		const status = formatStatusSnapshot(snapshot);

		expect(status).toContain('Writer slot:\n  w1 "auth flow" worker/senior | backend=codex | running | writer');
		expect(status).toContain("model=gpt-4o | mode=workspace-write | 2,000,000 tokens, est. $12.50");
		expect(status).toContain('Writer queue:\n  w2 "docs pass" worker/senior | backend=codex | queued | writer');
		expect(status).toContain(
			'Waiting (blocked on leader answer):\n  w3 "db decision" worker/senior | backend=codex | waiting | asking: Use Postgres?',
		);
		expect(status).toContain("Terminal:\n  w4 scout/senior | backend=codex | done");
		expect(status).toContain('Open notes:\n  n1 "finish the auth rollout" (w2 queued)');
	});
});
