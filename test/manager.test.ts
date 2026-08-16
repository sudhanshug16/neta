import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETA_SOCKET_ENV, NETA_WORKER_ENV, NETA_WORKER_TOKEN_ENV } from "../src/channel/protocol.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { NetaConfig } from "../src/settings.ts";
import type { WorkerEvent } from "../src/types.ts";

class FakeTransport implements WorkerTransportDriver {
	readonly options: TransportOptions;
	readonly prompts: string[] = [];
	started = false;
	killed = false;
	markedTerminal = false;
	private pending: Array<(outcome: PromptOutcome) => void> = [];
	private killGate: Promise<void> | undefined;
	private unblockKill: (() => void) | undefined;

	constructor(options: TransportOptions) {
		this.options = options;
	}

	start(): Promise<void> {
		this.started = true;
		return Promise.resolve();
	}

	prompt(text: string): Promise<PromptOutcome> {
		this.prompts.push(text);
		return new Promise((resolve) => this.pending.push(resolve));
	}

	async kill(): Promise<void> {
		this.killed = true;
		const killGate = this.killGate;
		this.killGate = undefined;
		if (killGate) await killGate;
	}

	markTerminal(): void {
		this.markedTerminal = true;
	}

	/** Finish the worker's current turn the way a real backend would. */
	finish(outcome: PromptOutcome): void {
		const resolve = this.pending.shift();
		if (!resolve) throw new Error("No prompt is running");
		resolve(outcome);
	}

	/** Hold process death until the test explicitly releases it. */
	delayKill(): () => void {
		this.killGate = new Promise<void>((resolve) => {
			this.unblockKill = resolve;
		});
		return () => this.unblockKill?.();
	}
}

describe("WorkerManager", () => {
	const config = new NetaConfig();
	let transports: FakeTransport[];
	let events: WorkerEvent[];
	let manager: WorkerManager;

	beforeEach(() => {
		transports = [];
		events = [];
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config,
			channelAddress: "/tmp/neta-test.sock",
			onEvent: (event) => events.push(event),
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
		});
	});

	afterEach(async () => {
		await manager.dispose();
		rmSync("/tmp/neta-test.sock", { force: true });
	});

	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("starts a worker with its role prompt, working agreement and channel environment", async () => {
		const summary = await manager.spawn({ role: "scout", tier: "senior", task: "map the auth flow" });

		expect(summary.state).toBe("running");
		const transport = transports[0];
		expect(transport.started).toBe(true);
		expect(transport.options.systemPrompt).toContain("You are a scout");
		expect(transport.options.systemPrompt).toContain("You are read-only");
		expect(transport.options.env[NETA_SOCKET_ENV]).toBe("/tmp/neta-test.sock");
		expect(transport.options.env[NETA_WORKER_ENV]).toBe(summary.id);
		expect(transport.options.env[NETA_WORKER_TOKEN_ENV]).toMatch(/^[a-f0-9]{32}$/);
		expect(transport.prompts[0]).toBe("map the auth flow");
	});

	it("does not add writer context when no writers are active or queued", async () => {
		await manager.spawn({ role: "scout", tier: "senior", task: "map the auth flow" });

		expect(transports[0].prompts[0]).toBe("map the auth flow");
	});

	it("prepends active and queued writer context to a read-only worker task", async () => {
		await manager.spawn({
			role: "worker",
			name: "billing migration",
			tier: "senior",
			task: "Migrate billing tables\nThen verify invoices.",
			writer: true,
		});
		await manager.spawn({
			role: "worker",
			name: "docs pass",
			tier: "senior",
			task: "Document the billing rollout",
			writer: true,
		});
		await manager.spawn({ role: "scout", tier: "senior", task: "Inspect the migration" });

		const prompt = transports[1].prompts[0];
		expect(prompt).toContain("# Concurrent writer context");
		expect(prompt).toContain('Active writer: rw1 "billing migration" | billing migration: Migrate billing tables');
		expect(prompt).toContain('Queued writers:\n- rw2 "docs pass" | docs pass: Document the billing rollout');
		expect(prompt).toContain("`git show HEAD:<path>` reads the last committed version.");
		expect(prompt).toEndWith("Inspect the migration");
	});

	it("uses access prefixes with one serial counter, including queued writers", async () => {
		const firstWriter = await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
		const reader = await manager.spawn({ role: "scout", tier: "senior", task: "inspect" });
		const queuedWriter = await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });
		const secondReader = await manager.spawn({ role: "reviewer", tier: "senior", task: "review" });

		expect(firstWriter.id).toBe("rw1");
		expect(reader.id).toBe("ro2");
		expect(queuedWriter.id).toBe("rw3");
		expect(queuedWriter.queuedBehind).toBe("rw1");
		expect(secondReader.id).toBe("ro4");
	});

	// Finished workers' views stay readable until the leader moves on, then close
	// themselves — otherwise a long session buries you in tabs of workers that
	// ended an hour ago.
	it("archives a finished batch when the next one starts", async () => {
		const first = await manager.spawn({ role: "scout", tier: "senior", task: "a" });
		transports[0].finish({ ok: true, summary: "found it" });
		await manager.waitFor([first.id], 5000);
		expect(manager.tailLog(first.id).archived).toBe(false);

		await manager.spawn({ role: "scout", tier: "senior", task: "b" });

		expect(manager.tailLog(first.id).archived).toBe(true);
	});

	it("leaves a batch alone while any of it is still running", async () => {
		const first = await manager.spawn({ role: "scout", tier: "senior", task: "a" });

		await manager.spawn({ role: "scout", tier: "senior", task: "b" });

		expect(manager.tailLog(first.id).archived).toBe(false);
	});

	it("tells juniors they cannot ask and seniors that they can", async () => {
		await manager.spawn({ role: "worker", tier: "junior", task: "rename foo to bar" });
		await manager.spawn({ role: "worker", tier: "staff", task: "find the leak" });

		expect(transports[0].options.systemPrompt).toContain("You cannot ask the leader questions");
		expect(transports[1].options.systemPrompt).toContain("ask <question>` blocks you");
	});

	it("hands the worker the backend its tier maps to", async () => {
		const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look" });

		expect(summary.backend).toBe("claude");
		// The model reaches the worker over ACP, not through an environment
		// variable: setting ANTHROPIC_MODEL did nothing, and every worker quietly
		// ran on the most expensive model instead of its tier's.
		expect(transports[0].options.model).toBe("sonnet");
	});

	it("surfaces the negotiated model, mode and bridge in the worker summary", async () => {
		const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look" });
		transports[0].options.events.session({
			model: "negotiated-model",
			modelId: "negotiated-model-id",
			mode: "negotiated-mode",
			agentInfo: "fake-bridge@1.0.0",
		});

		const updated = manager.get(summary.id);
		expect(updated.model).toBe("negotiated-model");
		expect(updated.modelId).toBe("negotiated-model-id");
		expect(updated.mode).toBe("negotiated-mode");
		expect(updated.agentInfo).toBe("fake-bridge@1.0.0");
	});

	it("queues a second writer and starts it automatically when the first finishes", async () => {
		const first = await manager.spawn({ role: "worker", tier: "senior", task: "fix the bug", writer: true });
		expect(first.writer).toBe(true);
		expect(first.state).toBe("running");

		const second = await manager.spawn({ role: "worker", tier: "senior", task: "other change", writer: true });
		expect(second.state).toBe("queued");
		expect(second.queuedBehind).toBe(first.id);

		// A read-only worker alongside the writer is fine.
		await manager.spawn({ role: "scout", tier: "junior", task: "read the tests" });

		transports[0].finish({ ok: true, summary: "fixed and committed" });
		// A finishing writer is checked for uncommitted changes before the slot is
		// released, so wait for the worker to actually reach a terminal state.
		await manager.waitFor([first.id], 5000);
		await flush();

		// Second worker should now be running (it gets the second transport, after the read-only worker)
		const secondUpdated = manager.get(second.id);
		expect(secondUpdated.state).toBe("running");
		expect(transports[0].markedTerminal).toBe(true);
		expect(transports[0].killed).toBe(true);
		// transports[1] is the read-only worker, transports[2] is the dequeued second writer
		expect(transports[2].started).toBe(true);
		expect(transports[2].prompts[0]).toContain("queued behind another writer");
		expect(transports[2].prompts[0]).toContain("other change");
	});

	it("registers process groups for dequeued writers through the same transport callback", async () => {
		const groups: Array<{ workerId: string; pgid: number | undefined }> = [];
		const queueManager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config,
			channelAddress: "/tmp/neta-queued-process-group.sock",
			onEvent: () => {},
			onWorkerProcessGroup: (workerId, pgid) => groups.push({ workerId, pgid }),
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
		});
		try {
			const first = await queueManager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
			const second = await queueManager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });
			transports.at(-1)?.options.events.processGroup?.(101);
			transports.at(-1)?.finish({ ok: true, summary: "first done" });
			await queueManager.waitFor([first.id], 5000);
			await flush();
			transports.at(-1)?.options.events.processGroup?.(202);

			expect(queueManager.get(second.id).state).toBe("running");
			expect(groups).toContainEqual({ workerId: first.id, pgid: 101 });
			expect(groups).toContainEqual({ workerId: second.id, pgid: 202 });
		} finally {
			await queueManager.dispose();
			rmSync("/tmp/neta-queued-process-group.sock", { force: true });
		}
	});

	it("does not send writer notices to queued writers", async () => {
		const first = await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
		await manager.spawn({ role: "scout", tier: "senior", task: "inspect" });
		const queued = await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });

		transports[0].finish({ ok: true, summary: "first done" });
		await manager.waitFor([first.id], 5000);
		await flush();

		const queuedLog = manager
			.tailLog(queued.id)
			.entries.map((entry) => entry.text)
			.join("\n");
		expect(queuedLog).not.toContain("Neta system notice");
	});

	it("keeps the writer slot until the finished worker's process is dead", async () => {
		const first = await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
		const second = await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });
		const releaseKill = transports[0].delayKill();

		transports[0].finish({ ok: true, summary: "first done" });
		await flush();

		expect(manager.get(first.id).state).toBe("running");
		expect(manager.get(second.id).state).toBe("queued");
		expect(transports).toHaveLength(1);

		releaseKill();
		await manager.waitFor([first.id], 5000);
		await flush();

		expect(manager.get(second.id).state).toBe("running");
	});

	it("pushes a done event when a worker finishes", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it" });
		transports[0].finish({ ok: true, summary: "all done" });
		await flush();

		expect(events).toEqual([{ type: "done", workerId: summary.id, summary: "all done", dirtyFiles: undefined }]);
		expect(manager.get(summary.id).state).toBe("done");
	});

	it("pushes a failed event and keeps the reason", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it" });
		transports[0].finish({ ok: false, summary: "backend not installed" });
		await flush();

		expect(events).toEqual([{ type: "failed", workerId: summary.id, error: "backend not installed" }]);
		expect(manager.get(summary.id).state).toBe("failed");
		expect(transports[0].markedTerminal).toBe(true);
		expect(transports[0].killed).toBe(true);
	});

	it("collects progress milestones into a log the leader drains once", async () => {
		const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look around" });

		expect(manager.progress(summary.id, "reading auth.ts")).toEqual({ ok: true });
		expect(manager.progress(summary.id, "found it")).toEqual({ ok: true });

		const drained = manager.drainLog(summary.id).filter((entry) => entry.kind === "progress");
		expect(drained.map((entry) => entry.text)).toEqual(["reading auth.ts", "found it"]);
		expect(manager.drainLog(summary.id)).toEqual([]);
	});

	it("keeps watch cursors continuous after trimming more than 500 log entries", async () => {
		const summary = await manager.spawn({ role: "scout", tier: "senior", task: "watch" });
		for (let index = 0; index < 100; index += 1) manager.progress(summary.id, `entry ${index}`);
		const beforeTrim = manager.tailLog(summary.id, 0);
		for (let index = 100; index < 601; index += 1) manager.progress(summary.id, `entry ${index}`);

		const afterTrim = manager.tailLog(summary.id, beforeTrim.cursor);
		expect(afterTrim.entries[0]?.text).toBe("…1 earlier entries trimmed");
		expect(afterTrim.entries.slice(1).map((entry) => entry.text)).toEqual(
			Array.from({ length: 500 }, (_, index) => `entry ${index + 101}`),
		);

		manager.progress(summary.id, "entry 601");
		const continued = manager.tailLog(summary.id, afterTrim.cursor);
		expect(continued.entries.map((entry) => entry.text)).toEqual(["entry 601"]);
	});

	it("includes dirty writer handoff warnings in the wait result and finish event", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neta-dirty-writer-"));
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, "first.txt"), "first");
		writeFileSync(join(cwd, "second.txt"), "second");
		const dirtyEvents: WorkerEvent[] = [];
		const dirtyManager = new WorkerManager({
			cwd,
			agentDir: "/nonexistent-agent-dir",
			config,
			channelAddress: "/tmp/neta-dirty-writer.sock",
			onEvent: (event) => dirtyEvents.push(event),
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
		});
		try {
			const summary = await dirtyManager.spawn({ role: "worker", tier: "senior", task: "write", writer: true });
			const transport = transports.at(-1);
			if (!transport) throw new Error("Writer transport was not created.");
			transport.finish({ ok: true, summary: "finished work" });
			const [finished] = await dirtyManager.waitFor([summary.id], 5000);
			expect(finished.result).toContain("uncommitted changes: 2 files");
			const waitOutput = await dirtyManager.leader(
				{ type: "wait", token: dirtyManager.leaderToken, workerIds: [summary.id], timeoutMs: 5000 },
				new AbortController().signal,
			);
			expect(waitOutput.ok && waitOutput.text).toContain("uncommitted changes: 2 files");
			expect(dirtyEvents).toEqual([
				{
					type: "done",
					workerId: summary.id,
					summary: "finished work\nuncommitted changes: 2 files",
					dirtyFiles: ["?? first.txt", "?? second.txt"],
				},
			]);
		} finally {
			await dirtyManager.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps the latest progress milestone on the worker summary", async () => {
		const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look around" });
		expect(manager.get(summary.id).lastProgress).toBeUndefined();

		manager.progress(summary.id, "reading auth.ts");
		manager.progress(summary.id, "found it");

		expect(manager.get(summary.id).lastProgress?.text).toBe("found it");
	});

	it("blocks a senior on ask until the leader answers", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it" });
		const abort = new AbortController();

		const pending = manager.ask(summary.id, "which database?", abort.signal);
		await flush();

		expect(manager.get(summary.id).state).toBe("waiting");
		expect(events).toEqual([{ type: "ask", workerId: summary.id, question: "which database?" }]);

		manager.answer(summary.id, "postgres");
		expect(await pending).toEqual({ ok: true, text: "postgres" });
		expect(manager.get(summary.id).state).toBe("running");
	});

	it("refuses ask for juniors and tells them what to do instead", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "junior", task: "rename it" });

		const response = await manager.ask(summary.id, "which one?", new AbortController().signal);

		expect(response).toEqual({
			ok: false,
			error: "Junior workers cannot ask the leader. Stop and finish with a report describing what is missing.",
		});
		expect(manager.get(summary.id).state).toBe("running");
	});

	it("shares a room transcript between its members", async () => {
		const first = await manager.spawn({ role: "debater", tier: "staff", task: "argue for", room: "db" });
		const second = await manager.spawn({ role: "debater", tier: "staff", task: "argue against", room: "db" });

		manager.postToRoom("db", "leader", "leader", "Postgres or SQLite?");
		manager.say(first.id, "Postgres: we already run it");
		const seen = manager.room(second.id, undefined);

		expect(seen.ok).toBe(true);
		expect(seen.ok && seen.text).toContain("Postgres or SQLite?");
		expect(seen.ok && seen.text).toContain("[debater/staff] Postgres: we already run it");
	});

	it("does not let a worker outside a room post to one", async () => {
		const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look" });

		expect(manager.say(summary.id, "hello")).toEqual({ ok: false, error: "You are not in a room." });
	});

	describe("writer queue", () => {
		it("reserves the writer slot before asynchronous spawn setup", async () => {
			let releaseSetup: (() => void) | undefined;
			const setupGate = new Promise<void>((resolve) => {
				releaseSetup = resolve;
			});
			const parallelTransports: FakeTransport[] = [];
			const parallel = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config,
				channelAddress: "/tmp/neta-parallel-test.sock",
				onEvent: () => {},
				prepareEnv: async () => {
					await setupGate;
					return {};
				},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					parallelTransports.push(transport);
					return transport;
				},
			});

			const firstSpawn = parallel.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
			const secondSpawn = parallel.spawn({ role: "worker", tier: "senior", task: "second", writer: true });
			await flush();
			releaseSetup?.();
			const [first, second] = await Promise.all([firstSpawn, secondSpawn]);

			expect(first.state).toBe("running");
			expect(second.state).toBe("queued");
			expect(parallelTransports).toHaveLength(1);
			await parallel.dispose();
			rmSync("/tmp/neta-parallel-test.sock", { force: true });
		});

		it("queues third writer in FIFO order", async () => {
			const first = await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
			const second = await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });
			const third = await manager.spawn({ role: "worker", tier: "senior", task: "third", writer: true });

			expect(first.state).toBe("running");
			expect(second.state).toBe("queued");
			expect(third.state).toBe("queued");

			// Finish first
			transports[0].finish({ ok: true, summary: "first done" });
			await manager.waitFor([first.id], 5000);
			await flush();

			// Second should be running now
			expect(manager.get(second.id).state).toBe("running");
			expect(manager.get(third.id).state).toBe("queued");

			// Finish second
			transports[1].finish({ ok: true, summary: "second done" });
			await manager.waitFor([second.id], 5000);
			await flush();

			// Third should be running now
			expect(manager.get(third.id).state).toBe("running");
		});

		it("starts next queued worker when active writer is killed", async () => {
			const first = await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
			const second = await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });

			expect(second.state).toBe("queued");

			await manager.kill(first.id);
			await flush();

			expect(manager.get(second.id).state).toBe("running");
		});

		it("cancels queued worker when killed without starting it", async () => {
			const first = await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
			const second = await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });

			expect(second.state).toBe("queued");

			await manager.kill(second.id);

			expect(manager.get(second.id).state).toBe("killed");
			expect(transports.length).toBe(1); // Only first transport started

			// Now finish first and nothing should dequeue
			transports[0].finish({ ok: true, summary: "first done" });
			await manager.waitFor([first.id], 5000);
			await flush();

			// No second transport should have started
			expect(transports.length).toBe(1);
		});

		it("delivers messages to queued worker as pending brief", async () => {
			const first = await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
			const second = await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });

			expect(second.state).toBe("queued");

			// Send messages to queued worker
			manager.send(second.id, "also fix the tests");
			manager.send(second.id, "and update docs");

			// Finish first to dequeue second
			transports[0].finish({ ok: true, summary: "first done" });
			await manager.waitFor([first.id], 5000);
			await flush();

			// Second should be running with messages delivered in the first prompt
			expect(manager.get(second.id).state).toBe("running");
			expect(transports[1].prompts).toHaveLength(1);
			expect(transports[1].prompts[0]).toContain("second");
			expect(transports[1].prompts[0]).toContain("also fix the tests");
			expect(transports[1].prompts[0]).toContain("and update docs");
		});

		// The spawn-time queue notice used to be stored in record.result, so every
		// listing showed it as the worker's output long after the worker started.
		it("keeps result empty until a queued worker actually finishes", async () => {
			const first = await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
			const second = await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });

			expect(second.result).toBeUndefined();

			transports[0].finish({ ok: true, summary: "first done" });
			await manager.waitFor([first.id], 5000);
			await flush();

			const running = manager.get(second.id);
			expect(running.state).toBe("running");
			expect(running.result).toBeUndefined();
			expect(running.queuedBehind).toBeUndefined();

			transports[1].finish({ ok: true, summary: "second done" });
			await manager.waitFor([second.id], 5000);
			expect(manager.get(second.id).result).toContain("second done");
		});

		it("allows read-only workers to spawn while queue exists", async () => {
			await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
			await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });

			const reader = await manager.spawn({ role: "scout", tier: "senior", task: "read" });

			expect(reader.state).toBe("running");
			expect(reader.writer).toBe(false);
		});
	});

	describe("notes ledger", () => {
		it("creates and lists open notes", () => {
			const note1 = manager.createNote("models.dev cost estimate");
			const _note2 = manager.createNote("docs pass");

			expect(note1.id).toBe("n1");
			expect(note1.text).toBe("models.dev cost estimate");
			expect(note1.open).toBe(true);

			const openNotes = manager.getOpenNotes();
			expect(openNotes).toHaveLength(2);
			expect(openNotes.map((n) => n.id)).toEqual(["n1", "n2"]);
		});

		it("closes a note and removes it from open list", () => {
			const note = manager.createNote("pending work");
			manager.closeNote(note.id);

			const closed = manager.listNotes().find((n) => n.id === note.id);
			expect(closed?.open).toBe(false);
			expect(closed?.closedAt).toBeDefined();
			expect(manager.getOpenNotes()).toHaveLength(0);
		});

		it("errors on unknown note id when closing", () => {
			expect(() => manager.closeNote("n99")).toThrow(/Unknown note id/);
		});

		it("links worker to note and records terminal state", async () => {
			const note = manager.createNote("implement auth");
			const summary = await manager.spawn({
				role: "worker",
				tier: "senior",
				task: "implement auth flow",
				note: note.id,
			});

			transports[0].finish({ ok: true, summary: "done" });
			await manager.waitFor([summary.id], 5000);

			const updatedNote = manager.listNotes().find((n) => n.id === note.id);
			expect(updatedNote?.workers).toHaveLength(1);
			expect(updatedNote?.workers[0]).toEqual({ workerId: summary.id, state: "done" });
		});

		it("links worker to note at spawn and tracks its live state", async () => {
			const note = manager.createNote("implement auth");
			const summary = await manager.spawn({
				role: "worker",
				tier: "senior",
				task: "implement auth flow",
				note: note.id,
			});

			expect(manager.getOpenNotes()[0].workers).toEqual([{ workerId: summary.id, state: "running" }]);
		});

		it("shows a queued linked worker as queued on the note", async () => {
			await manager.spawn({ role: "worker", tier: "senior", task: "hold the slot", writer: true });
			const note = manager.createNote("follow-up change");
			const queued = await manager.spawn({
				role: "worker",
				tier: "senior",
				task: "next change",
				writer: true,
				note: note.id,
			});

			expect(queued.state).toBe("queued");
			expect(manager.getOpenNotes()[0].workers).toEqual([{ workerId: queued.id, state: "queued" }]);
		});

		it("errors when spawning with unknown note id", async () => {
			await expect(manager.spawn({ role: "worker", tier: "senior", task: "do it", note: "n99" })).rejects.toThrow(
				/Unknown note id/,
			);
		});

		it("records worker state on note even when worker fails", async () => {
			const note = manager.createNote("risky task");
			const _summary = await manager.spawn({
				role: "worker",
				tier: "senior",
				task: "try something",
				note: note.id,
			});

			transports[0].finish({ ok: false, summary: "backend error" });
			await flush();

			const updatedNote = manager.listNotes().find((n) => n.id === note.id);
			expect(updatedNote?.workers).toHaveLength(1);
			expect(updatedNote?.workers[0].state).toBe("failed");
		});
	});

	it("kills a worker, releases the slot and reports it", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it", writer: true });

		const killed = await manager.kill(summary.id);

		expect(killed.state).toBe("killed");
		expect(transports[0].killed).toBe(true);
		await expect(
			manager.spawn({ role: "worker", tier: "senior", task: "next", writer: true }),
		).resolves.toBeDefined();
	});

	it("reports a running turn killed instead of failed when the leader stops it", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it", writer: true });
		const releaseKill = transports[0].delayKill();

		const killing = manager.kill(summary.id);
		await flush();
		transports[0].finish({ ok: false, summary: "transport closed" });
		releaseKill();
		await killing;
		await flush();

		expect(manager.get(summary.id).state).toBe("killed");
		expect(events).not.toContainEqual({ type: "failed", workerId: summary.id, error: "transport closed" });
	});

	it("shuts down a running and queued writer without starting the queued worker", async () => {
		await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
		await manager.spawn({ role: "worker", tier: "senior", task: "second", writer: true });
		const releaseKill = transports[0].delayKill();
		let disposed = false;
		const shutdown = manager.dispose().then(() => {
			disposed = true;
		});

		await flush();
		expect(disposed).toBe(false);
		expect(transports[0].killed).toBe(true);
		releaseKill();
		await shutdown;

		expect(transports).toHaveLength(1);
	});

	it("waits for the named workers and returns their results", async () => {
		const first = await manager.spawn({ role: "scout", tier: "senior", task: "a" });
		const second = await manager.spawn({ role: "scout", tier: "senior", task: "b" });

		const waiting = manager.waitFor([first.id, second.id], 5000);
		transports[0].finish({ ok: true, summary: "found a" });
		transports[1].finish({ ok: true, summary: "found b" });

		const summaries = await waiting;
		expect(summaries.map((summary) => summary.result)).toEqual(["found a", "found b"]);
	});

	it("returns the first finished worker in first mode while the other still runs", async () => {
		const first = await manager.spawn({ role: "scout", tier: "senior", task: "a" });
		const second = await manager.spawn({ role: "scout", tier: "senior", task: "b" });

		const waiting = manager.wait([first.id, second.id], 5000, { first: true });
		transports[0].finish({ ok: true, summary: "found a" });

		const result = await waiting;
		expect(result.reason).toBe("first");
		expect(result.wokeBy?.id).toBe(first.id);
		expect(result.wokeBy?.result).toBe("found a");
		expect(result.workers.find((worker) => worker.id === second.id)?.state).toBe("running");
	});

	it("returns immediately in first mode when a watched worker is already terminal", async () => {
		const first = await manager.spawn({ role: "scout", tier: "senior", task: "a" });
		const second = await manager.spawn({ role: "scout", tier: "senior", task: "b" });
		transports[0].finish({ ok: true, summary: "found a" });
		await manager.waitFor([first.id], 5000);

		const result = await manager.wait([first.id, second.id], 5000, { first: true });

		expect(result.reason).toBe("first");
		expect(result.wokeBy?.id).toBe(first.id);
		expect(manager.get(second.id).state).toBe("running");
	});

	// A blocked worker's question used to sit until every watched worker finished
	// or the timeout fired: waiters were only resolved in the terminal transition,
	// never when a worker entered "waiting" through ask.
	it("wakes a wait when a watched worker blocks on a question", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it" });

		const waiting = manager.wait([summary.id], 5000);
		const pending = manager.ask(summary.id, "which database?", new AbortController().signal);

		const result = await waiting;
		expect(result.reason).toBe("ask");
		expect(result.wokeBy?.id).toBe(summary.id);
		expect(result.wokeBy?.pendingQuestion).toBe("which database?");

		manager.answer(summary.id, "postgres");
		expect(await pending).toEqual({ ok: true, text: "postgres" });
	});

	it("wakes a wait on room activity when opted in", async () => {
		const member = await manager.spawn({ role: "debater", tier: "staff", task: "argue", room: "db" });
		manager.postToRoom("db", "leader", "leader", "old post");

		const waiting = manager.wait([member.id], 5000, { rooms: ["db"] });
		manager.postToRoom("db", "leader", "leader", "new evidence");

		const result = await waiting;
		expect(result.reason).toBe("room");
		expect(result.roomActivity?.room).toBe("db");
		// Only posts that landed after the wait began; the older transcript is
		// the leader's to pull through neta_room.
		expect(result.roomActivity?.posts.map((post) => post.text)).toEqual(["new evidence"]);
	});

	it("ignores room activity without the opt-in", async () => {
		const member = await manager.spawn({ role: "debater", tier: "staff", task: "argue", room: "db" });

		const waiting = manager.wait([member.id], 50);
		manager.postToRoom("db", "leader", "leader", "new evidence");

		expect((await waiting).reason).toBe("timeout");
	});

	it("rejects follow-up messages to a finished worker", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it" });
		transports[0].finish({ ok: true, summary: "done" });
		await flush();

		expect(() => manager.send(summary.id, "one more thing")).toThrow(/already finished/);
	});

	// A message sent to a running worker used to be logged, queued behind the
	// current turn, and then dropped: the turn's end marked the worker done, and
	// the queued prompt hit the terminal-state check and returned without ever
	// reaching the model.
	it("delivers a message sent mid-turn instead of finishing the worker under it", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it" });
		manager.send(summary.id, "also update the docs");

		transports[0].finish({ ok: true, summary: "code done" });
		await flush();

		// The first turn ended, but the worker has a queued instruction: still running.
		expect(manager.get(summary.id).state).toBe("running");
		expect(events).toHaveLength(0);
		expect(transports[0].prompts.at(-1)).toBe("also update the docs");

		transports[0].finish({ ok: true, summary: "docs done" });
		await flush();

		expect(manager.get(summary.id).state).toBe("done");
		expect(manager.get(summary.id).result).toBe("docs done");
		expect(events).toEqual([{ type: "done", workerId: summary.id, summary: "docs done", dirtyFiles: undefined }]);
	});

	// The channel is opened on demand rather than at startup, so a leader session
	// that never delegates never creates a socket. Deduplication is the caller's
	// job; the manager just asks before every spawn.
	it("prepares the worker runtime before spawning, and not before that", async () => {
		let prepared = 0;
		const lazyTransports: FakeTransport[] = [];
		const lazy = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config,
			channelAddress: "/tmp/neta-test.sock",
			onEvent: () => {},
			prepareEnv: async () => {
				prepared += 1;
				return { PATH: "/shim:/usr/bin" };
			},
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				lazyTransports.push(transport);
				return transport;
			},
		});

		expect(prepared).toBe(0);
		await lazy.spawn({ role: "scout", tier: "senior", task: "a" });
		await lazy.spawn({ role: "scout", tier: "senior", task: "b" });
		expect(prepared).toBe(2);

		// Workers reach the leader by running the `neta` CLI, so the prepared PATH
		// has to arrive in their environment.
		expect(lazyTransports[0].options.env.PATH).toBe("/shim:/usr/bin");

		await lazy.dispose();
	});

	it("names the known roles when asked for one that does not exist", async () => {
		await expect(manager.spawn({ role: "architect", tier: "senior", task: "x" })).rejects.toThrow(
			/Unknown role "architect".*scout, worker, reviewer, debater/s,
		);
	});

	// The leader normally drives the manager through MCP tools; the same
	// operations are reachable over the socket with the leader token.
	describe("leader channel commands", () => {
		const signal = new AbortController().signal;

		it("refuses every command without the leader token", async () => {
			const response = await manager.leader({ type: "workers", token: "wrong" }, signal);

			expect(response).toEqual({
				ok: false,
				error: "Invalid leader token. Worker processes cannot use leader commands.",
			});
		});

		it("spawns a worker and reports what was started", async () => {
			const response = await manager.leader(
				{ type: "spawn", token: manager.leaderToken, role: "scout", tier: "senior", task: "map auth" },
				signal,
			);

			expect(response.ok).toBe(true);
			expect(response.ok && response.text).toContain("scout/senior, read-only");
			expect(transports[0].prompts[0]).toBe("map auth");
		});

		it("rejects an unknown tier by name instead of spawning", async () => {
			const response = await manager.leader(
				{ type: "spawn", token: manager.leaderToken, role: "scout", tier: "principal", task: "x" },
				signal,
			);

			expect(response).toEqual({ ok: false, error: 'Unknown tier "principal". Tiers: junior, senior, staff.' });
			expect(transports).toHaveLength(0);
		});

		it("queues a second writer through the channel and reports queued status", async () => {
			await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });

			const response = await manager.leader(
				{ type: "spawn", token: manager.leaderToken, role: "worker", tier: "senior", task: "second", writer: true },
				signal,
			);

			expect(response.ok).toBe(true);
			expect(response.ok && response.text).toContain("Queued");
			expect(response.ok && response.text).toContain("rw1");
		});

		it("lists workers, drains a log, and answers a blocked worker", async () => {
			const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it" });
			manager.progress(summary.id, "reading auth.ts");

			const listed = await manager.leader({ type: "workers", token: manager.leaderToken }, signal);
			expect(listed.ok && listed.text).toContain(`${summary.id} [worker/senior`);
			expect(listed.ok && listed.text).toContain("last: reading auth.ts");

			const log = await manager.leader({ type: "log", token: manager.leaderToken, workerId: summary.id }, signal);
			expect(log.ok && log.text).toContain("[progress] reading auth.ts");

			const pending = manager.ask(summary.id, "which database?", signal);
			await flush();
			const answered = await manager.leader(
				{ type: "answer", token: manager.leaderToken, workerId: summary.id, text: "postgres" },
				signal,
			);

			expect(answered.ok).toBe(true);
			expect(await pending).toEqual({ ok: true, text: "postgres" });
		});

		it("waits for the named workers and returns their results", async () => {
			const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look" });
			const waiting = manager.leader(
				{ type: "wait", token: manager.leaderToken, workerIds: [summary.id], timeoutMs: 5000 },
				signal,
			);
			transports[0].finish({ ok: true, summary: "found the bug in auth.ts" });

			const response = await waiting;
			expect(response.ok && response.text).toContain("found the bug in auth.ts");
		});

		it("reports an unknown worker id with the ones that exist", async () => {
			const response = await manager.leader({ type: "kill", token: manager.leaderToken, workerId: "ro9" }, signal);

			expect(response.ok).toBe(false);
			expect(response.ok === false && response.error).toContain('Unknown worker "ro9"');
		});
	});

	describe("backend assignment policy", () => {
		it("spreads workers across installed backends deterministically within a session", async () => {
			// Mock multiple backends as installed
			const multiConfig = new NetaConfig();
			const _mockEnv = { PATH: "/usr/bin:/bin", npx: "/usr/bin/npx", opencode: "/usr/bin/opencode" };
			const mockInstalledBackends = () => ["claude", "codex", "opencode"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-spread.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			// Spawn 3 workers with same tier, no explicit backend
			const first = await multiManager.spawn({ role: "scout", tier: "senior", task: "task1" });
			const second = await multiManager.spawn({ role: "scout", tier: "senior", task: "task2" });
			const third = await multiManager.spawn({ role: "scout", tier: "senior", task: "task3" });

			// They should spread across backends
			const backends = [first.backend, second.backend, third.backend];
			expect(new Set(backends).size).toBeGreaterThan(1); // At least 2 different backends

			// Spawn 3 more workers in the same session - should get the same pattern
			const fourth = await multiManager.spawn({ role: "scout", tier: "senior", task: "task4" });
			const fifth = await multiManager.spawn({ role: "scout", tier: "senior", task: "task5" });
			const sixth = await multiManager.spawn({ role: "scout", tier: "senior", task: "task6" });

			expect(fourth.backend).toBe(first.backend);
			expect(fifth.backend).toBe(second.backend);
			expect(sixth.backend).toBe(third.backend);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-spread.sock", { force: true });
		});

		it("assigns reviewer/debater roles to a different backend than the writer when multiple backends installed", async () => {
			// Mock two backends as installed
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-diversity.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			// Spawn a writer
			const writer = await multiManager.spawn({ role: "worker", tier: "senior", task: "implement", writer: true });

			// Spawn a reviewer - should get a different backend
			const reviewer = await multiManager.spawn({ role: "reviewer", tier: "staff", task: "review" });

			expect(reviewer.backend).not.toBe(writer.backend);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-diversity.sock", { force: true });
		});

		it("keeps reviewers diverse from a writer that started after queueing", async () => {
			const multiConfig = new NetaConfig();
			multiConfig.installedBackends = () => ["claude", "codex"];
			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-queued-diversity.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});
			try {
				const first = await multiManager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });
				const queued = await multiManager.spawn({ role: "worker", tier: "senior", task: "queued", writer: true });
				transports.at(-1)?.finish({ ok: true, summary: "first done" });
				await multiManager.waitFor([first.id], 5000);
				await flush();
				const reviewer = await multiManager.spawn({ role: "reviewer", tier: "staff", task: "review" });

				expect(multiManager.get(queued.id).state).toBe("running");
				expect(reviewer.backend).not.toBe(queued.backend);
			} finally {
				await multiManager.dispose();
				rmSync("/tmp/neta-test-queued-diversity.sock", { force: true });
			}
		});

		it("passes explicit backend override to resolve and returns it in spawn result", async () => {
			const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look", backend: "codex" });

			expect(summary.backend).toBe("codex");
			expect(transports[transports.length - 1].options.model).toBe("gpt-5.6-terra[high]");
		});

		it("rejects an explicit override for a disabled backend without starting a worker", async () => {
			manager.configure({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: new NetaConfig({ backends: { opencode: { disabled: true } } }),
			});

			await expect(
				manager.spawn({ role: "scout", tier: "senior", task: "look", backend: "opencode" }),
			).rejects.toThrow('Backend "opencode" is disabled in settings.');
			expect(transports).toHaveLength(0);
		});

		it("resolves unconfigured tiers when only one backend is installed", async () => {
			// This should not throw even though DEFAULT_TIERS is empty
			const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look" });

			expect(summary.backend).toBeTruthy();
			expect(["claude", "codex", "opencode"]).toContain(summary.backend);
		});

		it("planAssignments followed by spawning the exact list yields the same backends per worker", async () => {
			// Mock multiple backends as installed
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-invariant.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			const requestList = [
				{ role: "scout", tier: "senior" as const },
				{ role: "worker", tier: "senior" as const, writer: true },
				{ role: "reviewer", tier: "senior" as const },
				{ role: "worker", tier: "junior" as const },
			];

			// Plan the assignments
			const plan = multiManager.planAssignments(requestList);

			// Spawn the exact same list in order
			const spawned = [];
			for (const request of requestList) {
				spawned.push(
					await multiManager.spawn({
						...request,
						task: "task",
					}),
				);
			}

			// Verify each spawned worker's backend matches the plan
			for (let i = 0; i < plan.length; i++) {
				expect(spawned[i].backend).toBe(plan[i].backend);
			}

			await multiManager.dispose();
			rmSync("/tmp/neta-test-invariant.sock", { force: true });
		});

		it("planAssignments is idempotent for the same request list", async () => {
			// Mock multiple backends as installed
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-idempotent.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			const requestList = [
				{ role: "scout", tier: "senior" as const },
				{ role: "worker", tier: "senior" as const, writer: true },
				{ role: "reviewer", tier: "senior" as const },
			];

			// Call planAssignments twice with the same list
			const plan1 = multiManager.planAssignments(requestList);
			const plan2 = multiManager.planAssignments(requestList);

			// Verify both plans are identical
			expect(plan1).toEqual(plan2);

			// Verify spawning after planning still matches the first plan
			const spawned = [];
			for (const request of requestList) {
				spawned.push(
					await multiManager.spawn({
						...request,
						task: "task",
					}),
				);
			}

			for (let i = 0; i < plan1.length; i++) {
				expect(spawned[i].backend).toBe(plan1[i].backend);
			}

			await multiManager.dispose();
			rmSync("/tmp/neta-test-idempotent.sock", { force: true });
		});

		it("planAssignments shows reviewer on different backend than planned writer", async () => {
			// Mock two backends as installed
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-diversity-plan.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			const requestList = [
				{ role: "worker", tier: "senior" as const, writer: true },
				{ role: "reviewer", tier: "senior" as const },
			];

			// Plan the assignments
			const plan = multiManager.planAssignments(requestList);

			// Verify the reviewer is planned on a different backend than the writer
			expect(plan[1].backend).not.toBe(plan[0].backend);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-diversity-plan.sock", { force: true });
		});

		it("assigns debaters in one room to different backends automatically", async () => {
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-room-mix.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			// Spawn two debaters in the same room
			const debater1 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "argue for postgres",
				room: "db-debate",
			});
			const debater2 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "argue for sqlite",
				room: "db-debate",
			});

			// They should be on different backends
			expect(debater1.backend).not.toBe(debater2.backend);
			expect([debater1.backend, debater2.backend].sort()).toEqual(["claude", "codex"]);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-room-mix.sock", { force: true });
		});

		it("cycles backends when all are used by debaters in one room", async () => {
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-room-cycle.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			// Spawn three debaters in the same room (more than available backends)
			const debater1 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "first",
				room: "multi-debate",
			});
			const debater2 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "second",
				room: "multi-debate",
			});
			const debater3 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "third",
				room: "multi-debate",
			});

			// First two should use different backends
			expect(debater1.backend).not.toBe(debater2.backend);

			// Third cycles back
			expect(debater3.backend).toBe(debater1.backend);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-room-cycle.sock", { force: true });
		});

		it("tracks room debater backends independently for different rooms", async () => {
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-room-independent.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			// Spawn debaters in room A
			const roomA1 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "a1",
				room: "room-a",
			});
			const roomA2 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "a2",
				room: "room-a",
			});

			// Spawn debaters in room B
			const roomB1 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "b1",
				room: "room-b",
			});
			const roomB2 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "b2",
				room: "room-b",
			});

			// Room A debaters should use different backends
			expect(roomA1.backend).not.toBe(roomA2.backend);

			// Room B debaters should use different backends
			expect(roomB1.backend).not.toBe(roomB2.backend);

			// Both rooms should have gotten both backends (independent mixing)
			expect([roomA1.backend, roomA2.backend].sort()).toEqual(["claude", "codex"]);
			expect([roomB1.backend, roomB2.backend].sort()).toEqual(["claude", "codex"]);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-room-independent.sock", { force: true });
		});

		it("respects explicit backend override for debaters over room mixing", async () => {
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-room-override.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			// First debater gets explicit override
			const debater1 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "first",
				room: "override-room",
				backend: "codex",
			});

			// Second debater uses room mixing
			const debater2 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "second",
				room: "override-room",
			});

			// First should use the override
			expect(debater1.backend).toBe("codex");

			// Second may still end up on codex (explicit override doesn't affect room state)
			// but should follow normal assignment logic
			expect(["claude", "codex"]).toContain(debater2.backend);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-room-override.sock", { force: true });
		});

		it("respects tier-configured backend for debaters over room mixing", async () => {
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;
			// Configure staff tier to always use codex
			multiConfig.tierMapping = () => ({ staff: { backend: "codex" } });

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-room-tier-config.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			// Both debaters should use configured tier backend
			const debater1 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "first",
				room: "tier-room",
			});
			const debater2 = await multiManager.spawn({
				role: "debater",
				tier: "staff",
				task: "second",
				room: "tier-room",
			});

			// Both should use codex (tier config wins)
			expect(debater1.backend).toBe("codex");
			expect(debater2.backend).toBe("codex");

			await multiManager.dispose();
			rmSync("/tmp/neta-test-room-tier-config.sock", { force: true });
		});

		it("degrades gracefully with single installed backend for debaters", async () => {
			// Single backend installed
			const singleConfig = new NetaConfig();
			const mockSingleBackend = () => ["claude"];
			singleConfig.installedBackends = mockSingleBackend;

			const singleManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: singleConfig,
				channelAddress: "/tmp/neta-test-room-single.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			const debater1 = await singleManager.spawn({
				role: "debater",
				tier: "staff",
				task: "first",
				room: "single-room",
			});
			const debater2 = await singleManager.spawn({
				role: "debater",
				tier: "staff",
				task: "second",
				room: "single-room",
			});

			// Both should use the only available backend
			expect(debater1.backend).toBe("claude");
			expect(debater2.backend).toBe("claude");

			await singleManager.dispose();
			rmSync("/tmp/neta-test-room-single.sock", { force: true });
		});

		it("does not apply room mixing to non-debater roles in a room", async () => {
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-room-non-debater.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			// Spawn a scout and a worker in a room (not debaters)
			const scout = await multiManager.spawn({
				role: "scout",
				tier: "senior",
				task: "explore",
				room: "mixed-room",
			});
			const worker = await multiManager.spawn({
				role: "worker",
				tier: "senior",
				task: "implement",
				room: "mixed-room",
			});

			// They may end up on same or different backends (regular spread policy)
			expect(["claude", "codex"]).toContain(scout.backend);
			expect(["claude", "codex"]).toContain(worker.backend);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-room-non-debater.sock", { force: true });
		});

		it("plan/spawn parity: planning and spawning debaters in same room produces identical backends", async () => {
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-room-parity.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			const requestList = [
				{ role: "debater", tier: "staff" as const, room: "debate-x" },
				{ role: "debater", tier: "staff" as const, room: "debate-x" },
				{ role: "debater", tier: "senior" as const, room: "debate-y" },
				{ role: "debater", tier: "senior" as const, room: "debate-y" },
			];

			// Plan the assignments
			const plan = multiManager.planAssignments(requestList);

			// Spawn the exact same list
			const spawned = [];
			for (const request of requestList) {
				spawned.push(
					await multiManager.spawn({
						...request,
						task: "task",
					}),
				);
			}

			// Verify backends match position by position
			for (let i = 0; i < plan.length; i++) {
				expect(spawned[i].backend).toBe(plan[i].backend);
			}

			// Verify room mixing worked: room-x debaters differ, room-y debaters differ
			expect(plan[0].backend).not.toBe(plan[1].backend);
			expect(plan[2].backend).not.toBe(plan[3].backend);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-room-parity.sock", { force: true });
		});

		it("planAssignments is idempotent for debaters with rooms", async () => {
			const multiConfig = new NetaConfig();
			const mockInstalledBackends = () => ["claude", "codex"];
			multiConfig.installedBackends = mockInstalledBackends;

			const multiManager = new WorkerManager({
				cwd: process.cwd(),
				agentDir: "/nonexistent-agent-dir",
				config: multiConfig,
				channelAddress: "/tmp/neta-test-room-idempotent.sock",
				onEvent: () => {},
				createTransport: (options) => {
					const transport = new FakeTransport(options);
					transports.push(transport);
					return transport;
				},
			});

			const requestList = [
				{ role: "debater", tier: "staff" as const, room: "room-z" },
				{ role: "debater", tier: "staff" as const, room: "room-z" },
			];

			// Call planAssignments twice
			const plan1 = multiManager.planAssignments(requestList);
			const plan2 = multiManager.planAssignments(requestList);

			// Verify both plans are identical
			expect(plan1).toEqual(plan2);

			// Verify room mixing worked
			expect(plan1[0].backend).not.toBe(plan1[1].backend);

			await multiManager.dispose();
			rmSync("/tmp/neta-test-room-idempotent.sock", { force: true });
		});
	});
});
