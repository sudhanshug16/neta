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
		expect(status).toContain("Terminal:\n  counts: blocked=0 | failed=0 | interrupted=0 | done=1 | killed=0");
		expect(status).not.toContain("ro4 scout/expert");
		expect(status).toContain('Open notes:\n  n1 "finish the auth rollout" (rw2 queued)');
	});

	it("keeps every unresolved worker and open note visible", () => {
		const running = Array.from({ length: 7 }, (_, index) => worker({ id: `run${index}`, name: `run ${index}` }));
		const queued = Array.from({ length: 7 }, (_, index) =>
			worker({ id: `queue${index}`, name: `queue ${index}`, state: "queued" }),
		);
		const waiting = Array.from({ length: 7 }, (_, index) =>
			worker({ id: `wait${index}`, name: `wait ${index}`, state: "waiting" }),
		);
		const blocked = Array.from({ length: 7 }, (_, index) =>
			worker({ id: `blocked${index}`, name: `blocked ${index}`, state: "blocked" }),
		);
		const notes = Array.from({ length: 7 }, (_, index) => ({
			id: `n${index}`,
			text: `note ${index}`,
			open: true,
			createdAt: index,
			workers: [],
		}));
		const status = formatStatusSnapshot({
			writerSlot: running[0],
			writerQueue: queued,
			workers: { running, queued, waiting, terminal: blocked },
			openNotes: notes,
		});

		for (const item of [...running, ...queued, ...waiting, ...blocked]) expect(status).toContain(item.id);
		for (const note of notes) expect(status).toContain(`${note.id} "${note.text}"`);
		expect(status).not.toContain("worker rows omitted");
		expect(status).not.toContain("note previews omitted");
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

	it("reports pending and unavailable launched views without calling them headless", () => {
		expect(
			formatWorkerSummary(worker({ viewStatus: "verification-pending", viewReason: "stale tab listing" })),
		).toContain("Worker view: view verification pending — stale tab listing");
		expect(
			formatWorkerSummary(worker({ viewStatus: "verification-unavailable", viewReason: "ambiguous tab identity" })),
		).toContain("Worker view: view launched; verification unavailable — ambiguous tab identity");
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

	it("bounds finished writer history while keeping active and queued writers visible", () => {
		const finished = Array.from({ length: 12 }, (_, index) =>
			worker({
				id: `rw${index + 1}`,
				writer: true,
				state: index === 0 ? "failed" : "done",
				name: `writer ${index + 1}`,
			}),
		);
		const active = worker({ id: "rw-active", writer: true, name: "active writer" });
		const queued = Array.from({ length: 7 }, (_, index) =>
			worker({ id: `rw-queued-${index + 1}`, writer: true, state: "queued", name: `queued ${index + 1}` }),
		);
		const status = formatWriterStatus({
			writerSlot: active,
			writerQueue: queued,
			workers: { running: [active], queued, waiting: [], terminal: finished },
			openNotes: [],
		});

		expect(status).toContain("total: 12 (blocked=0 | failed=1 | interrupted=0 | done=11 | killed=0)");
		expect(status).toContain("... 7 finished writer previews omitted");
		expect((status.match(/^ {2}rw\d+ /gm) ?? []).length).toBe(5);
		expect(status).toContain("rw-active");
		for (const writer of queued) expect(status).toContain(writer.id);
	});

	it("suggests inspection only for active or diagnostic worker states", () => {
		const snapshot: WorkerStatusSnapshot = {
			writerQueue: [],
			workers: {
				running: [worker({ id: "ro-running", state: "running" })],
				queued: [worker({ id: "ro-queued", state: "queued" })],
				waiting: [worker({ id: "ro-waiting", state: "waiting" })],
				terminal: [
					worker({ id: "ro-blocked", state: "blocked" }),
					worker({ id: "ro-failed", state: "failed" }),
					worker({ id: "ro-interrupted", state: "interrupted" }),
					worker({ id: "ro-done", state: "done" }),
					worker({ id: "ro-killed", state: "killed" }),
					worker({ id: "ro-later-failure", state: "done", laterFailure: "notice failed" }),
				],
			},
			openNotes: [],
		};

		const status = formatStatusSnapshot(snapshot);
		for (const id of ["ro-running", "ro-queued", "ro-waiting"])
			expect(status).toContain(`expand: neta inspect ${id}`);
		expect(status).toContain("ro-blocked");
		expect(status).toContain("ro-later-failure");
		for (const id of ["ro-failed", "ro-interrupted"]) expect(status).not.toContain(`inspect: neta inspect ${id}`);
		for (const id of ["ro-blocked", "ro-later-failure"]) expect(status).toContain(`inspect: neta inspect ${id}`);
		for (const id of ["ro-done", "ro-killed"]) expect(status).not.toContain(`inspect ${id}`);
	});

	it("shows closed-worker counts and every open note with bounded fields", () => {
		const terminal = Array.from({ length: 557 }, (_, index) =>
			worker({
				id: `ro${index + 1}`,
				name: `closed ${index}`,
				state: index % 2 === 0 ? "done" : index % 4 === 1 ? "killed" : "failed",
				result: "result ".repeat(1_000),
			}),
		);
		const openNotes = Array.from({ length: 150 }, (_, index) => ({
			id: `n${index + 1}`,
			text: "note ".repeat(500),
			open: true,
			createdAt: index + 1,
			workers: Array.from({ length: 10 }, (__unused, workerIndex) => ({
				workerId: `ro${workerIndex + 1}`,
				state: "failed" as const,
			})),
		}));
		const rendered = formatStatusSnapshot({
			writerQueue: [],
			workers: { running: [], queued: [], waiting: [], terminal },
			openNotes,
		});

		expect(rendered).toContain("counts: blocked=0 | failed=139 | interrupted=0 | done=279 | killed=139");
		for (const id of terminal.map((item) => item.id)) expect(rendered).not.toContain(`  ${id} `);
		expect(rendered).toContain("total: 150");
		expect(rendered).not.toContain("note previews omitted");
		expect(rendered).not.toContain("linked workers omitted");
		for (const note of openNotes) expect(rendered).toContain(`${note.id} "`);
		const noteLines = rendered.split("\n").filter((line) => /^ {2}n\d+ "/.test(line));
		expect(noteLines).toHaveLength(150);
		expect(noteLines.every((line) => line.length <= 520)).toBe(true);
	});
});
