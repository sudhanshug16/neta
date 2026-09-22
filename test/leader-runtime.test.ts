import { expect, test } from "bun:test";
import type { Leader, Turn } from "../src/core/types.ts";
import { recordLeaderRuntime } from "../src/node/leader-runtime.ts";

function fixture() {
	const at = new Date(0).toISOString();
	let leader: Leader = {
		workspaceId: "workspace",
		machineId: "host",
		name: "Mace",
		sessionId: "session",
		provider: "fake",
		model: "test-model",
		mode: "lead",
		modeSince: at,
		modeActiveMs: 0,
		state: "idle",
	};
	const changed: Leader[] = [];
	const store = {
		listLeaders: () => [leader],
		getLeader: () => leader,
		putLeader: async (next: Leader) => {
			leader = next;
		},
	};
	const turn: Turn = {
		id: "turn",
		sessionId: leader.sessionId,
		role: "user",
		startedAt: at,
		bindingGeneration: "binding",
	};
	const ports = { store, changed: (next: Leader) => changed.push(next) };
	return { store, turn, ports, changed };
}

test("leader activity starts before any output and duplicate notifications do not rebroadcast", async () => {
	const f = fixture();
	const notification = { sessionId: f.turn.sessionId, turn: f.turn };
	await recordLeaderRuntime(notification, f.ports);
	expect(f.store.getLeader().state).toBe("running");
	expect(f.changed.map((leader) => leader.state)).toEqual(["running"]);
	await recordLeaderRuntime(notification, f.ports);
	expect(f.changed).toHaveLength(1);
	await recordLeaderRuntime({ ...notification, turn: { ...f.turn, endedAt: f.turn.startedAt } }, f.ports);
	expect(f.changed.map((leader) => leader.state)).toEqual(["running", "idle"]);
});

test.each([
	[{ cancelled: true }, "idle"],
	[{ failed: true }, "failed"],
] as const)("leader turn ending with %j becomes %s", async (ending, state) => {
	const f = fixture();
	await recordLeaderRuntime({ sessionId: f.turn.sessionId, turn: f.turn }, f.ports);
	await recordLeaderRuntime(
		{ sessionId: f.turn.sessionId, turn: { ...f.turn, endedAt: f.turn.startedAt, ...ending } },
		f.ports,
	);
	expect(f.store.getLeader().state).toBe(state);
	await recordLeaderRuntime({ sessionId: f.turn.sessionId, turn: { ...f.turn, id: "retry" } }, f.ports);
	expect(f.store.getLeader().state).toBe("running");
});

test("a late turn ending or old model event cannot overwrite a newer leader execution", async () => {
	const f = fixture();
	await recordLeaderRuntime({ sessionId: f.turn.sessionId, turn: f.turn }, f.ports);
	await recordLeaderRuntime(
		{ sessionId: f.turn.sessionId, turn: { ...f.turn, id: "next", bindingGeneration: "new-binding" } },
		f.ports,
	);
	for (const turn of [
		{ ...f.turn, bindingGeneration: "new-binding" },
		{ ...f.turn, id: "next" },
	]) {
		await recordLeaderRuntime(
			{ sessionId: turn.sessionId, turn: { ...turn, endedAt: turn.startedAt, failed: true } },
			f.ports,
		);
	}
	await recordLeaderRuntime(
		{ sessionId: f.turn.sessionId, model: "old-model", bindingGeneration: "binding" },
		f.ports,
	);
	expect(f.store.getLeader().state).toBe("running");
	expect(f.store.getLeader().model).toBe("test-model");
	expect(f.changed).toHaveLength(2);
});

test("reset leader ignores events from its previous session", async () => {
	const f = fixture();
	await f.store.putLeader({ ...f.store.getLeader(), sessionId: "reset-session" });
	await recordLeaderRuntime({ sessionId: f.turn.sessionId, turn: f.turn }, f.ports);
	expect(f.store.getLeader().state).toBe("idle");
	expect(f.changed).toHaveLength(0);
});

test("leader model changes preserve running activity and valid starts clear startup failures", async () => {
	const f = fixture();
	await f.store.putLeader({ ...f.store.getLeader(), state: "failed", startupError: "provider unavailable" });
	await recordLeaderRuntime({ sessionId: f.turn.sessionId, turn: f.turn }, f.ports);
	await recordLeaderRuntime(
		{ sessionId: f.turn.sessionId, model: "selected-model", bindingGeneration: "binding" },
		f.ports,
	);
	expect(f.store.getLeader()).toMatchObject({ state: "running", model: "selected-model" });
	expect(f.store.getLeader().startupError).toBeUndefined();
});
