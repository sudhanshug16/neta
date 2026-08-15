import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { NETA_SOCKET_ENV, NETA_WORKER_ENV } from "../src/channel/protocol.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { NetaConfig } from "../src/settings.ts";
import type { WorkerEvent } from "../src/types.ts";

class FakeTransport implements WorkerTransportDriver {
	readonly options: TransportOptions;
	readonly prompts: string[] = [];
	started = false;
	killed = false;
	private pending: Array<(outcome: PromptOutcome) => void> = [];

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
	}

	/** Finish the worker's current turn the way a real backend would. */
	finish(outcome: PromptOutcome): void {
		const resolve = this.pending.shift();
		if (!resolve) throw new Error("No prompt is running");
		resolve(outcome);
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
		expect(transport.prompts[0]).toBe("map the auth flow");
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

	it("surfaces the negotiated model and mode in the worker summary", async () => {
		const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look" });
		transports[0].options.events.session("negotiated-model", "negotiated-mode");

		const updated = manager.get(summary.id);
		expect(updated.model).toBe("negotiated-model");
		expect(updated.mode).toBe("negotiated-mode");
	});

	it("allows only one writer at a time and releases the slot when it finishes", async () => {
		const first = await manager.spawn({ role: "worker", tier: "senior", task: "fix the bug", writer: true });
		expect(first.writer).toBe(true);

		await expect(
			manager.spawn({ role: "worker", tier: "senior", task: "other change", writer: true }),
		).rejects.toThrow(/already holds the writer slot/);

		// A read-only worker alongside the writer is fine.
		await manager.spawn({ role: "scout", tier: "junior", task: "read the tests" });

		transports[0].finish({ ok: true, summary: "fixed and committed" });
		// A finishing writer is checked for uncommitted changes before the slot is
		// released, so wait for the worker to actually reach a terminal state.
		await manager.waitFor([first.id], 5000);

		await expect(
			manager.spawn({ role: "worker", tier: "senior", task: "next change", writer: true }),
		).resolves.toMatchObject({ writer: true });
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
	});

	it("collects notify lines into a log the leader drains once", async () => {
		const summary = await manager.spawn({ role: "scout", tier: "senior", task: "look around" });

		expect(manager.notify(summary.id, "reading auth.ts")).toEqual({ ok: true });
		expect(manager.notify(summary.id, "found it")).toEqual({ ok: true });

		const drained = manager.drainLog(summary.id).filter((entry) => entry.kind === "notify");
		expect(drained.map((entry) => entry.text)).toEqual(["reading auth.ts", "found it"]);
		expect(manager.drainLog(summary.id)).toEqual([]);
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

	it("kills a worker, releases the slot and reports it", async () => {
		const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it", writer: true });

		const killed = await manager.kill(summary.id);

		expect(killed.state).toBe("killed");
		expect(transports[0].killed).toBe(true);
		await expect(
			manager.spawn({ role: "worker", tier: "senior", task: "next", writer: true }),
		).resolves.toBeDefined();
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

		it("turns a spawn failure into an error response rather than throwing", async () => {
			await manager.spawn({ role: "worker", tier: "senior", task: "first", writer: true });

			const response = await manager.leader(
				{ type: "spawn", token: manager.leaderToken, role: "worker", tier: "senior", task: "second", writer: true },
				signal,
			);

			expect(response.ok).toBe(false);
			expect(response.ok === false && response.error).toContain("already holds the writer slot");
		});

		it("lists workers, drains a log, and answers a blocked worker", async () => {
			const summary = await manager.spawn({ role: "worker", tier: "senior", task: "do it" });
			manager.notify(summary.id, "reading auth.ts");

			const listed = await manager.leader({ type: "workers", token: manager.leaderToken }, signal);
			expect(listed.ok && listed.text).toContain(`${summary.id} [worker/senior`);

			const log = await manager.leader({ type: "log", token: manager.leaderToken, workerId: summary.id }, signal);
			expect(log.ok && log.text).toContain("[notify] reading auth.ts");

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
			const response = await manager.leader({ type: "kill", token: manager.leaderToken, workerId: "w9" }, signal);

			expect(response.ok).toBe(false);
			expect(response.ok === false && response.error).toContain('Unknown worker "w9"');
		});
	});
});
