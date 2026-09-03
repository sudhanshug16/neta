import { describe, expect, test } from "bun:test";
import { canTransitionAgent, deriveMissionState, isWaiting, needsPerson } from "../src/core/state.ts";
import type { Agent, AgentState, Mission } from "../src/core/types.ts";

function mission(over: Partial<Mission> = {}): Mission {
	return {
		id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		number: 1,
		workspaceId: "git:github.com/org/repo",
		machineId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		name: "fix the flaky specs",
		objective: "Make the suite green.",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readWrite",
		state: "running",
		createdAt: "2026-09-03T17:00:00.000Z",
		...over,
	};
}

function agent(over: Partial<Agent> = {}): Agent {
	return {
		id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		missionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		workspaceId: "git:github.com/org/repo",
		name: "Ember",
		task: "Reproduce the flake.",
		access: "readOnly",
		provider: "claude",
		model: "sonnet",
		skills: [],
		sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		canSpawn: false,
		state: "running",
		startedAt: "2026-09-03T17:00:00.000Z",
		...over,
	};
}

describe("deriveMissionState", () => {
	test("a fresh mission with no agents is running", () => {
		expect(deriveMissionState(mission(), [])).toBe("running");
	});

	test("closedAt wins over everything", () => {
		const m = mission({
			state: "failed",
			closedAt: "2026-09-03T18:00:00.000Z",
			disposition: "abandoned",
			integration: { mergedAt: "2026-09-03T18:00:00.000Z", commit: "abc", base: "main" },
		});
		expect(deriveMissionState(m, [agent({ state: "failed" })])).toBe("closed");
	});

	test("integration, observed or stored, means mergedNotClosed", () => {
		const m = mission();
		const integration = { mergedAt: "2026-09-03T18:00:00.000Z", commit: "abc", base: "main" };
		expect(deriveMissionState(m, [agent({ state: "failed" })], integration)).toBe("mergedNotClosed");
		expect(deriveMissionState(mission({ integration }), [agent({ state: "blocked" })])).toBe("mergedNotClosed");
	});

	test("a failed agent with no running agent means failed", () => {
		expect(deriveMissionState(mission(), [agent({ state: "failed" })])).toBe("failed");
		expect(deriveMissionState(mission(), [agent({ state: "failed" }), agent({ state: "blocked" })])).toBe("failed");
	});

	test("a running agent alongside a failed one keeps the mission out of failed", () => {
		expect(
			deriveMissionState(mission(), [
				agent({ state: "failed" }),
				agent({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", state: "running" }),
			]),
		).toBe("running");
	});

	test("a blocked agent, or a lead with a pending question, means blocked", () => {
		expect(deriveMissionState(mission(), [agent({ state: "blocked" })])).toBe("blocked");
		expect(deriveMissionState(mission(), [agent({ pendingQuestion: "Which key?" })])).toBe("blocked");
	});

	test("the marked-ready flag sticks until something outranks it", () => {
		expect(deriveMissionState(mission({ state: "readyToClose" }), [agent()])).toBe("readyToClose");
		expect(deriveMissionState(mission({ state: "readyToClose" }), [agent({ state: "failed" })])).toBe("failed");
	});

	test("every agent completed with the lead done means readyToClose", () => {
		const leadAgent = agent({ id: "lead1", canSpawn: true, state: "completed" });
		const m = mission({ lead: { kind: "agent", agentId: "lead1" } });
		expect(deriveMissionState(m, [leadAgent])).toBe("readyToClose");
	});

	test("completed agents without the lead done stay running", () => {
		const m = mission({ lead: { kind: "agent", agentId: "lead1" } });
		const agents = [agent({ id: "lead1", canSpawn: true, state: "running" })];
		expect(deriveMissionState(m, agents)).toBe("running");
	});
});

describe("canTransitionAgent", () => {
	const valid: [AgentState, AgentState][] = [
		["starting", "running"],
		["starting", "failed"],
		["starting", "interrupted"],
		["running", "blocked"],
		["running", "failed"],
		["running", "completed"],
		["running", "interrupted"],
		["blocked", "running"],
		["blocked", "failed"],
		["blocked", "interrupted"],
		["blocked", "archived"],
		["failed", "archived"],
		["completed", "archived"],
		["interrupted", "running"],
		["interrupted", "archived"],
	];
	test.each(valid)("allows %s -> %s", (from, to) => {
		expect(canTransitionAgent(from, to)).toBe(true);
	});

	const invalid: [AgentState, AgentState][] = [
		["starting", "blocked"],
		["starting", "completed"],
		["starting", "archived"],
		["running", "starting"],
		["running", "running"],
		["running", "archived"],
		["blocked", "completed"],
		["failed", "running"],
		["completed", "running"],
		["interrupted", "completed"],
		["interrupted", "failed"],
		["archived", "running"],
	];
	test.each(invalid)("rejects %s -> %s", (from, to) => {
		expect(canTransitionAgent(from, to)).toBe(false);
	});
});

describe("needsPerson", () => {
	test.each(["blocked", "failed", "readyToClose", "mergedNotClosed"] as const)("waits on %s", (state) => {
		expect(needsPerson(mission({ state }))).toBe(true);
		expect(isWaiting(mission({ state }))).toBe(true);
	});

	test.each(["running", "closed"] as const)("does not wait on %s", (state) => {
		expect(needsPerson(mission({ state }))).toBe(false);
	});
});
