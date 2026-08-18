import { describe, expect, it } from "bun:test";
import {
	formatLastProgress,
	formatStatusSnapshot,
	formatWorkerSummary,
	formatWriterStatus,
} from "../src/orchestrator/status.ts";
import type { WorkerStatusSnapshot, WorkerSummary } from "../src/types.ts";

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
	return {
		id: "ro1",
		name: "auth flow",
		role: "worker",
		tier: "expert",
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

		expect(status).toContain('Writer slot:\n  rw1 "auth flow" worker/expert | backend=codex | running | writer');
		expect(status).toContain("model=gpt-4o | mode=workspace-write | 2,000,000 tokens, est. $12.50");
		expect(status).toContain('Writer queue:\n  rw2 "docs pass" worker/expert | backend=codex | queued | writer');
		expect(status).toContain(
			'Waiting (legacy active state):\n  ro3 "db decision" worker/expert | backend=codex | waiting | ' +
				"model unknown — backend default | asking: Use Postgres?",
		);
		expect(status).toContain(
			"Terminal:\n  ro4 scout/expert | backend=codex | done | model unknown — backend default",
		);
		expect(status).toContain('Open notes:\n  n1 "finish the auth rollout" (rw2 queued)');
	});

	it("flattens and clips the latest progress milestone to one last: line", () => {
		expect(formatLastProgress(worker())).toBeUndefined();
		expect(formatLastProgress(worker({ lastProgress: { text: "line one\nline two", at: 1 } }))).toBe(
			"last: line one line two",
		);
		expect(formatLastProgress(worker({ lastProgress: { text: "y".repeat(200), at: 1 } }))).toBe(
			`last: ${"y".repeat(77)}...`,
		);
	});

	// A blank where the model should be reads as "fine"; only a worker that has
	// not started yet is allowed to say nothing.
	it("says loudly when a started worker's model is unknown", () => {
		expect(formatWorkerSummary(worker())).toContain("model unknown — backend default");
		expect(formatWorkerSummary(worker({ state: "queued" }))).not.toContain("model unknown");
		expect(formatWorkerSummary(worker({ state: "starting" }))).not.toContain("model unknown");
		expect(formatWorkerSummary(worker({ model: "sonnet" }))).toContain("model=sonnet");
	});

	it("renders only writers in finished, active and queued groups", () => {
		const active = worker({
			id: "rw1",
			name: "billing migration",
			task: "Migrate billing tables\nDo not deploy",
			writer: true,
		});
		const queued = worker({
			id: "rw2",
			name: "docs pass",
			task: "Document the rollout",
			state: "queued",
			writer: true,
		});
		const finished = worker({ id: "rw3", name: "cleanup", task: "Remove old index", state: "done", writer: true });
		const reader = worker({ id: "ro4", name: "scout", task: "Inspect billing", state: "running" });
		const snapshot: WorkerStatusSnapshot = {
			writerSlot: active,
			writerQueue: [queued],
			workers: { running: [active, reader], queued: [queued], waiting: [], terminal: [finished] },
			openNotes: [],
		};

		const status = formatWriterStatus(snapshot);

		expect(status).toContain('Finished:\n  rw3 "cleanup" | cleanup: Remove old index');
		expect(status).toContain('Active:\n  rw1 "billing migration" | billing migration: Migrate billing tables');
		expect(status).toContain('Queued:\n  rw2 "docs pass" | docs pass: Document the rollout');
		expect(status).not.toContain("ro4");
		expect(status).not.toContain("Open notes");
	});
});
