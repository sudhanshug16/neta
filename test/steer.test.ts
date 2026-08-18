/**
 * Steering a running worker.
 *
 * ACP's `session/prompt` owns a whole prompt turn: there is no request in 1.3.0
 * that appends to a turn already in flight. The supported equivalent is to
 * cancel the turn and prompt the same session again, which keeps the session,
 * its history, its model selection and its writer slot, and ends only the turn.
 *
 * What these tests pin down is the honesty of the report. "Queued" and
 * "delivered" are different facts, and a leader acts on the difference.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import { formatSteerResult } from "../src/orchestrator/status.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { isTerminalState, type WorkerEvent } from "../src/types.ts";
import { fixtureBackendConfig, waitFor } from "./helpers.ts";

/**
 * A backend that answers `session/cancel` the way a real one does: it finishes
 * whatever it was mid-way through, then resolves the in-flight prompt with
 * stopReason "cancelled". Never synchronously — the race is the point.
 */
class FakeTransport implements WorkerTransportDriver {
	readonly options: TransportOptions;
	readonly prompts: string[] = [];
	cancels = 0;
	/** Set false to model a backend that ignores the cancel notification. */
	honorCancel = true;
	/** Set false to model a transport whose session is already gone. */
	liveSession = true;
	/** Set to throw from cancel(), the way a broken transport would. */
	cancelError: Error | undefined;
	/** Model a bridge that accepted no more stdin and never settles its write. */
	cancelNeverResolves = false;
	killed = false;
	terminal = false;
	private cancelGate: Promise<void> | undefined;
	private releaseCancelGate: (() => void) | undefined;
	private pending: Array<(outcome: PromptOutcome) => void> = [];

	constructor(options: TransportOptions) {
		this.options = options;
	}
	start(): Promise<void> {
		return Promise.resolve();
	}
	prompt(text: string): Promise<PromptOutcome> {
		this.prompts.push(text);
		return new Promise((resolve) => this.pending.push(resolve));
	}
	async cancel(): Promise<boolean> {
		this.cancels += 1;
		if (this.cancelNeverResolves) return new Promise<boolean>(() => {});
		await this.cancelGate;
		if (this.cancelError) throw this.cancelError;
		if (!this.liveSession) return false;
		if (!this.honorCancel) return true;
		const resolve = this.pending.shift();
		if (resolve)
			queueMicrotask(() => resolve({ ok: false, cancelled: true, summary: "Turn cancelled. half a thought" }));
		return true;
	}
	delayCancelDispatch(): () => void {
		this.cancelGate = new Promise<void>((resolve) => {
			this.releaseCancelGate = resolve;
		});
		return () => this.releaseCancelGate?.();
	}
	async kill(): Promise<void> {
		this.killed = true;
	}
	markTerminal(): void {
		this.terminal = true;
	}

	/** End the current turn the way a backend that finished normally would. */
	finish(outcome: PromptOutcome): void {
		const resolve = this.pending.shift();
		if (!resolve) throw new Error("No prompt is running");
		resolve(outcome);
	}
	get running(): number {
		return this.pending.length;
	}
}

describe("steering a worker", () => {
	let manager: WorkerManager;
	let transports: FakeTransport[];
	let events: WorkerEvent[];

	beforeEach(() => {
		transports = [];
		events = [];
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: fixtureBackendConfig(),
			channelAddress: "/tmp/neta-steer-test.sock",
			leaderToken: "leader-token",
			steerTimeoutMs: 20,
			onEvent: (event) => events.push(event),
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
		});
	});

	async function runningWorker(writer = false) {
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "read the auth flow", writer });
		const transport = transports[0];
		await waitFor(() => transport.prompts.length === 1);
		return { worker, transport };
	}

	it("interrupts the running turn and hands the worker the new message", async () => {
		const { transport } = await runningWorker();
		const result = await manager.steer("ro1", "stop, look at the session store instead");

		expect(result.delivery).toBe("interrupted");
		expect(transport.cancels).toBe(1);
		expect(transport.prompts[1]).toBe("stop, look at the session store instead");
		// Same session throughout: nothing was restarted, nothing was killed.
		expect(transports).toHaveLength(1);
	});

	// A cancelled turn is Neta's own doing. Treating it as a crash would fail a
	// healthy worker and hand its writer slot to whoever is next in the queue.
	it("does not fail the worker or release its writer slot", async () => {
		await runningWorker(true);
		expect(manager.statusSnapshot().writerSlot?.id).toBe("rw1");

		await manager.steer("rw1", "different approach");

		expect(manager.get("rw1").state).toBe("running");
		expect(manager.statusSnapshot().writerSlot?.id).toBe("rw1");
		expect(events.filter((event) => event.type === "failed")).toEqual([]);
	});

	// The steering message is queued before the cancel is sent, so a turn that
	// ends on its own in the gap still cannot finish the worker.
	it("delivers, without cutting anything short, when the turn beat the interrupt", async () => {
		const { transport } = await runningWorker();
		transport.honorCancel = false;
		const steering = manager.steer("ro1", "one more thing");
		// The backend ignores the cancel and completes the turn it was on.
		await waitFor(() => transport.cancels === 1);
		transport.finish({ ok: true, summary: "here is the auth flow" });

		const result = await steering;
		expect(result.delivery).toBe("turn-ended");
		expect(result.note).toContain("already ended");
		expect(transport.prompts[1]).toBe("one more thing");
		expect(manager.get("ro1").state).toBe("running");
	});

	// The one thing that must never be claimed: that a worker has read something
	// it has not.
	it("says the message is only queued when the worker has not taken it", async () => {
		const { transport } = await runningWorker();
		transport.honorCancel = false;
		const result = await manager.steer("ro1", "change course", { timeoutMs: 20 });

		expect(result.delivery).toBe("cancel-pending");
		expect(formatSteerResult(result)).toContain("has NOT read your message yet");
		expect(transport.prompts).toHaveLength(1);
		expect(manager.tailLog("ro1").entries.map((entry) => entry.text)).not.toContain(
			"Leader interrupted the current turn to deliver a message.",
		);
	});

	it("keeps whatever the worker managed to say before it stopped", async () => {
		await runningWorker();
		await manager.steer("ro1", "change course");
		const log = manager.tailLog("ro1").entries.map((entry) => entry.text);
		expect(log).toContain("Turn interrupted to deliver the leader's message.");
	});

	it("warns that completed tool calls are not undone", async () => {
		await runningWorker();
		const result = await manager.steer("ro1", "change course");
		expect(result.note).toContain("already completed were not undone");
	});

	// A worker that has not started has no turn to interrupt, and a follow-up
	// must not become prompt one and push the task to prompt two.
	it("appends to the brief of a worker that has not started", async () => {
		await manager.spawn({ role: "worker", tier: "expert", task: "first", writer: true });
		const queued = await manager.spawn({ role: "worker", tier: "expert", task: "second", writer: true });
		expect(queued.state).toBe("queued");

		const result = await manager.steer(queued.id, "and also update the changelog");
		expect(result.delivery).toBe("pending-brief");
		expect(transports).toHaveLength(1);
	});

	it("reports honestly when the transport has no session left to cancel", async () => {
		const { transport } = await runningWorker();
		transport.liveSession = false;
		const result = await manager.steer("ro1", "change course", { timeoutMs: 20 });
		expect(result.delivery).toBe("next-turn");
		expect(result.note).toContain("no live session to interrupt");
	});

	it("fails closed when cancelling throws", async () => {
		const { transport } = await runningWorker();
		transport.cancelError = new Error("transport is closed");
		const result = await manager.steer("ro1", "change course", { timeoutMs: 20 });
		expect(result.delivery).toBe("cancel-failed");
		expect(result.note).toContain("unsafe for later prompts");
		expect(result.worker.promptBlockedReason).toContain("transport is closed");
		expect(transport.prompts).toEqual(["read the auth flow"]);
		await expect(manager.steer("ro1", "try again")).rejects.toThrow(/cannot accept another prompt/);
	});

	it("bounds send and watch input when cancel dispatch never resolves, then remains killable", async () => {
		const first = await manager.spawn({ role: "scout", tier: "expert", task: "first" });
		const second = await manager.spawn({ role: "scout", tier: "expert", task: "second" });
		await waitFor(() => transports.every((transport) => transport.prompts.length === 1));
		for (const transport of transports) transport.cancelNeverResolves = true;

		for (const [type, worker] of [
			["send", first],
			["pane-input", second],
		] as const) {
			const started = Date.now();
			const response = await manager.leader(
				{ type, token: "leader-token", workerId: worker.id, text: `${type} correction` },
				new AbortController().signal,
			);
			expect(Date.now() - started).toBeLessThan(250);
			expect(response.ok).toBe(true);
			expect(response.ok && response.text).toContain("NOT delivered");
		}

		expect(transports.map((transport) => transport.prompts)).toEqual([["first"], ["second"]]);
		for (const worker of [first, second]) await manager.kill(worker.id);
		expect([first.id, second.id].map((id) => manager.get(id).state)).toEqual(["killed", "killed"]);
		expect(transports.every((transport) => transport.killed && transport.terminal)).toBe(true);
	});

	// Two steers in quick succession: both messages arrive, in order, and the
	// second does not cancel the first one's turn before it has begun.
	it("delivers both of two steers, in order", async () => {
		const { transport } = await runningWorker();
		const first = await manager.steer("ro1", "first correction");
		expect(first.delivery).toBe("interrupted");
		const second = await manager.steer("ro1", "second correction");

		expect(transport.prompts).toEqual(["read the auth flow", "first correction", "second correction"]);
		expect(second.delivery).toBe("interrupted");
		expect(manager.get("ro1").state).toBe("running");
	});

	// `session/cancel` names a session, not a turn. If the turn we aimed at ends
	// on its own and the next one starts before our notification reaches the
	// agent, the cancel lands on a turn nobody aimed at. That must not be booked
	// as this steer's success, and above all must not leave the worker running
	// with an empty queue and nothing to wake anyone.
	it("does not book a late cancel that hit the wrong turn as a success", async () => {
		const { transport } = await runningWorker();
		transport.honorCancel = false;
		const steering = manager.steer("ro1", "one more thing", { timeoutMs: 200 });
		await waitFor(() => transport.cancels === 1);

		// The turn we aimed at ends normally, and the steering prompt starts.
		transport.finish({ ok: true, summary: "here is the auth flow" });
		expect(await steering).toMatchObject({ delivery: "turn-ended" });
		await waitFor(() => transport.prompts.length === 2);

		// Now the stale cancel arrives and stops that new turn instead.
		transport.finish({ ok: false, cancelled: true, summary: "Turn cancelled." });

		// The worker ends visibly rather than sitting in "running" forever with an
		// empty queue, which nothing would ever wake the leader from.
		await waitFor(() => isTerminalState(manager.get("ro1").state));
	});

	// ACP cancel names the session, not the turn. If writing the notification is
	// delayed while the old turn ends, the replacement prompt must wait behind
	// that write or the stale cancel could stop the message it was meant to send.
	it("holds the replacement prompt until its turn-specific cancel is dispatched", async () => {
		const { transport } = await runningWorker();
		transport.honorCancel = false;
		const releaseCancel = transport.delayCancelDispatch();
		const steering = manager.steer("ro1", "inspect the session store", { timeoutMs: 200 });
		await waitFor(() => transport.cancels === 1);

		transport.finish({ ok: true, summary: "old turn ended naturally" });
		await Bun.sleep(5);
		expect(transport.prompts).toEqual(["read the auth flow"]);

		releaseCancel();
		expect(await steering).toMatchObject({ delivery: "turn-ended" });
		expect(transport.prompts).toEqual(["read the auth flow", "inspect the session store"]);
	});

	it("requires a recorded vendor session to revive a finished worker", async () => {
		const { transport } = await runningWorker();
		transport.finish({ ok: true, summary: "done reading" });
		await waitFor(() => manager.get("ro1").state === "done");

		await expect(manager.steer("ro1", "one more thing")).rejects.toThrow(/no recorded vendor session id/);
	});

	it("refuses a killed worker", async () => {
		await runningWorker();
		await manager.kill("ro1");
		await expect(manager.steer("ro1", "one more thing")).rejects.toThrow(/conversation cannot be resumed safely/);
	});

	it("refuses an unknown worker", async () => {
		await expect(manager.steer("ro9", "hello")).rejects.toThrow(/Unknown worker/);
	});

	// After a steer, the worker's own turn still ends the worker: the interrupt
	// changes the instruction, not the lifecycle.
	it("still finishes normally after the steering turn ends", async () => {
		const { transport } = await runningWorker();
		await manager.steer("ro1", "look at the session store instead");
		transport.finish({ ok: true, summary: "the session store keys on user id" });

		await waitFor(() => manager.get("ro1").state === "done");
		expect(manager.get("ro1").result).toBe("the session store keys on user id");
	});

	it("is the same operation over the worker socket", async () => {
		const { transport } = await runningWorker();
		const response = await manager.leader(
			{ type: "send", token: "leader-token", workerId: "ro1", text: "change course" },
			new AbortController().signal,
		);
		expect(response.ok).toBe(true);
		expect(response.ok && response.text).toContain("Interrupted ro1's running turn");
		expect(transport.prompts[1]).toBe("change course");
	});

	it("uses the same immediate steering primitive for typed watch input", async () => {
		const { transport } = await runningWorker();
		const response = await manager.leader(
			{ type: "pane-input", token: "leader-token", workerId: "ro1", text: "typed correction" },
			new AbortController().signal,
		);

		expect(response.ok).toBe(true);
		expect(response.ok && response.text).toContain("Interrupted ro1's running turn");
		expect(transport.cancels).toBe(1);
		expect(transport.prompts).toEqual(["read the auth flow", "typed correction"]);
	});
});

describe("what a steer reports", () => {
	const worker = {
		id: "ro1",
		name: "scout",
		role: "scout",
		tier: "expert" as const,
		backend: "fake",
		writer: false,
		state: "running" as const,
		task: "read",
		startedAt: 0,
	};

	it("never says delivered when it means queued", () => {
		expect(formatSteerResult({ worker, delivery: "cancel-pending" })).toContain("NOT read your message yet");
		expect(formatSteerResult({ worker, delivery: "interrupted" })).toContain("now working on your message");
		expect(formatSteerResult({ worker, delivery: "turn-ended" })).toContain("now working on your message");
		expect(formatSteerResult({ worker, delivery: "pending-brief" })).toContain("has not started yet");
		expect(formatSteerResult({ worker, delivery: "next-turn" })).toContain("next prompt");
		expect(formatSteerResult({ worker, delivery: "cancel-failed" })).toContain("NOT delivered");
	});

	it("does not claim no turn was running for blocked or failed cancellation paths", () => {
		const waiting = { ...worker, state: "waiting" as const };
		expect(
			formatSteerResult({ worker: waiting, delivery: "next-turn", note: "blocked on a question" }),
		).not.toContain("no turn running");
		expect(formatSteerResult({ worker, delivery: "cancel-failed", note: "cancel dispatch failed" })).not.toContain(
			"no turn running",
		);
	});
});
