import { expect, test } from "bun:test";
import type { Agent, Block, Leader, Mission } from "../src/core/types.ts";
import { deliverParentReport, reportAgentRuntime } from "../src/node/agent-runtime.ts";
import type { ParentReport, ParentReportStore } from "../src/store/parent-reports.ts";

function fixture(canSpawn = true) {
	const at = new Date(0).toISOString();
	const agent: Agent = {
		id: "child",
		sessionId: "child-session",
		workspaceId: "w",
		missionId: "m",
		name: "Cove",
		task: "inspect",
		access: "readOnly",
		provider: "opencode",
		model: "anthropic/haiku",
		skills: [],
		canSpawn,
		state: "starting",
		startedAt: at,
	};
	const lead: Agent = { ...agent, id: "lead", sessionId: "lead-session", canSpawn: true };
	const agents = new Map([
		[agent.id, agent],
		[lead.id, lead],
	]);
	const leader: Leader = {
		workspaceId: "w",
		machineId: "host",
		name: "Leader",
		sessionId: "workspace-session",
		provider: "opencode",
		model: "astra",
		mode: "lead",
		modeSince: at,
		modeActiveMs: 0,
		state: "idle",
	};
	const mission: Mission = {
		id: "m",
		number: 1,
		workspaceId: "w",
		machineId: "host",
		name: "Review",
		objective: "inspect",
		changes: [],
		lead: { kind: "agent", agentId: canSpawn ? "child" : "lead" },
		agentIds: [...agents.keys()],
		access: "readOnly",
		state: "running",
		createdAt: at,
	};
	const sent: Array<{ id: string; text: string }> = [];
	const blocks: Block[] = [{ seq: 1, turnId: "turn", role: "agent", kind: "text", text: "Branch needs one fix.", at }];
	const results = new Map<string, ParentReport>();
	const reports: ParentReportStore = {
		get: async (id) => results.get(id),
		record: async (report) => {
			const current = results.get(report.id);
			if (current) return current;
			results.set(report.id, report);
			return report;
		},
		pending: async () => [...results.values()].filter((item) => item.status === "pending"),
		settle: async (id, status, receiptId, parentSessionId) => {
			const item = results.get(id);
			if (item) results.set(id, { ...item, status, receiptId, parentSessionId });
		},
	};
	const ports = {
		reports,
		store: {
			listAgents: () => [...agents.values()],
			getAgent: (id: string) => agents.get(id),
			putAgent: async (value: Agent) => {
				agents.set(value.id, value);
			},
			getMission: () => mission,
			getLeader: () => leader,
			recentConversation: async () => blocks,
		},
		send: async (id: string, text: string, sourceId: string) => {
			sent.push({ id, text });
			return { id: sourceId, sessionId: id, text, attachments: [], createdAt: at, status: "queued" as const };
		},
		changed: () => {},
	};
	const end = {
		sessionId: agent.sessionId,
		turn: { id: "turn", sessionId: agent.sessionId, role: "user" as const, startedAt: at, endedAt: at },
	};
	return { agents, mission, sent, ports, end, reports, results };
}

test("mission leader stopping without neta_done wakes workspace leader with actual model and report", async () => {
	const f = fixture();
	await reportAgentRuntime({ sessionId: "child-session", model: "google/gemini-flash" }, f.ports);
	await reportAgentRuntime(f.end, f.ports);
	expect(f.agents.get("child")?.model).toBe("google/gemini-flash");
	expect(f.agents.get("child")?.state).toBe("idle");
	expect(f.sent[0]?.text).toContain("State: idle");
	expect(f.sent[0]?.id).toBe("workspace-session");
	expect(f.sent[0]?.text).toContain("google/gemini-flash");
	expect(f.sent[0]?.text).toContain("Branch needs one fix.");
	await reportAgentRuntime(f.end, f.ports);
	expect(f.sent).toHaveLength(1);
});
test("worker stops report to mission leader, including cancellation and explicit done", async () => {
	const f = fixture(false);
	const child = f.agents.get("child");
	if (!child) throw new Error("Missing fixture child");
	f.agents.set("child", { ...child, state: "completed", outcome: "Finished inspection" });
	await reportAgentRuntime({ ...f.end, turn: { ...f.end.turn, cancelled: true } }, f.ports);
	expect(f.sent[0]?.id).toBe("lead-session");
	expect(f.sent[0]?.text).toContain("Finished inspection");
	expect(f.sent[0]?.text).toContain("Turn interrupted.");
});

test.each([true, false])(
	"failed %s actor reports selected model and cause once to the correct parent",
	async (canSpawn) => {
		const f = fixture(canSpawn);
		f.ports.store.recentConversation = async () => [
			{
				seq: 1,
				turnId: "turn",
				role: "agent",
				kind: "status",
				text: "anthropic/haiku failed: DNS lookup timed out. The selected model and session are retained.",
				at: f.end.turn.endedAt,
			},
		];
		const ended = { ...f.end, turn: { ...f.end.turn, failed: true, model: "anthropic/haiku" } };
		await reportAgentRuntime(ended, f.ports);
		await reportAgentRuntime(ended, f.ports);
		expect(f.agents.get("child")?.state).toBe("failed");
		expect(f.agents.get("child")?.model).toBe("anthropic/haiku");
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0]?.id).toBe(canSpawn ? "workspace-session" : "lead-session");
		expect(f.sent[0]?.text).toContain("DNS lookup timed out");
		expect(f.sent[0]?.text).toContain("Actual model: anthropic/haiku. State: failed");
		expect(f.sent[0]?.text).not.toContain("/connect");
	},
);

test("an idle mission lead cannot hide missing workers behind its final prose", async () => {
	const f = fixture();
	f.agents.delete("lead");
	f.ports.store.recentConversation = async () => [
		{
			seq: 1,
			turnId: "turn",
			role: "agent",
			kind: "text",
			text: "The worker is still running.",
			at: f.end.turn.endedAt,
		},
	];
	await reportAgentRuntime(f.end, f.ports);
	expect(f.sent[0]?.text).toContain("0 other agents executing, 0 queued");
	expect(f.sent[0]?.text).toContain("No other agents exist in this mission");
	expect(f.sent[0]?.text).toContain("idle with unfinished work");
	expect(f.sent[0]?.text).toContain("Agent-reported result");
	expect(f.sent[0]?.text).toContain("The worker is still running.");
});

test.each(["running", "queued"] as const)("reports preserve genuine %s child work", async (state) => {
	const f = fixture();
	const peer = f.agents.get("lead");
	if (!peer) throw new Error("Missing peer");
	f.agents.set(peer.id, { ...peer, canSpawn: false, name: "Worker", state });
	await reportAgentRuntime(f.end, f.ports);
	expect(f.sent[0]?.text).toContain(
		state === "running" ? "1 other agents executing, 0 queued" : "0 other agents executing, 1 queued",
	);
	expect(f.sent[0]?.text).toContain(`Worker (lead): ${state}`);
	expect(f.sent[0]?.text).not.toContain("idle with unfinished work");
});
test("closed missions and archived workers never wake parents", async () => {
	const f = fixture();
	f.mission.state = "closed";
	await reportAgentRuntime(f.end, f.ports);
	expect(f.sent).toHaveLength(0);
});
test("failed delivery remains retryable and subsequent turn reactivates the actor", async () => {
	const f = fixture();
	await expect(
		reportAgentRuntime(f.end, {
			...f.ports,
			send: async () => {
				throw new Error("unavailable");
			},
		}),
	).rejects.toThrow("unavailable");
	expect(f.agents.get("child")?.lastReportedTurnId).toBeUndefined();
	expect((await f.reports.pending())[0]?.turnId).toBe("turn");
	await reportAgentRuntime(f.end, f.ports);
	await reportAgentRuntime(
		{ sessionId: "child-session", turn: { ...f.end.turn, id: "next", endedAt: undefined } },
		f.ports,
	);
	expect(f.agents.get("child")?.state).toBe("running");
	expect(f.sent).toHaveLength(1);
});

test("retrying an old result cannot interrupt a newer turn or replace its result", async () => {
	const f = fixture();
	const unavailable = {
		...f.ports,
		send: async () => {
			throw new Error("offline");
		},
	};
	await expect(reportAgentRuntime(f.end, unavailable)).rejects.toThrow("offline");
	const old = (await f.reports.pending())[0];
	if (!old) throw new Error("Missing pending result");
	await reportAgentRuntime(
		{ sessionId: "child-session", turn: { ...f.end.turn, id: "B", endedAt: undefined } },
		f.ports,
	);
	await deliverParentReport(old, f.ports);
	expect(f.agents.get("child")?.state).toBe("running");
	expect(f.agents.get("child")?.currentTurnId).toBe("B");
	await expect(
		reportAgentRuntime({ ...f.end, turn: { ...f.end.turn, id: "B", model: "small/model" } }, unavailable),
	).rejects.toThrow("offline");
	expect([...f.results.values()].map((item) => item.turnId)).toEqual(["turn", "B"]);
	expect((await f.reports.pending())[0]?.model).toBe("small/model");
});
test("two undelivered turns survive independently and use their historical models", async () => {
	const f = fixture();
	const unavailable = {
		...f.ports,
		send: async () => {
			throw new Error("offline");
		},
	};
	for (const id of ["A", "B"]) {
		await reportAgentRuntime(
			{ sessionId: "child-session", turn: { ...f.end.turn, id, endedAt: undefined } },
			f.ports,
		);
		await expect(
			reportAgentRuntime({ ...f.end, turn: { ...f.end.turn, id, model: `model/${id}` } }, unavailable),
		).rejects.toThrow("offline");
	}
	await reportAgentRuntime({ sessionId: "child-session", model: "new/model" }, f.ports);
	const pending = await f.reports.pending();
	expect(pending.map((item) => [item.turnId, item.model])).toEqual([
		["A", "model/A"],
		["B", "model/B"],
	]);
	for (const report of pending) await deliverParentReport(report, f.ports);
	expect(f.sent).toHaveLength(2);
});

test("cancelled turns remain interrupted rather than successful idle", async () => {
	const f = fixture(false);
	await reportAgentRuntime({ ...f.end, turn: { ...f.end.turn, cancelled: true } }, f.ports);
	expect(f.agents.get("child")?.state).toBe("interrupted");
	expect(f.sent[0]?.id).toBe("lead-session");
	expect(f.sent[0]?.text).toContain("State: interrupted");
});

test("a continued agent cannot report a previous turn's completion as its new result", async () => {
	const f = fixture();
	const agent = f.agents.get("child");
	if (!agent) throw new Error("Missing fixture child");
	f.agents.set(agent.id, { ...agent, state: "completed", outcome: "Old result" });
	await reportAgentRuntime({ ...f.end, turn: { ...f.end.turn, endedAt: undefined } }, f.ports);
	await reportAgentRuntime(f.end, f.ports);
	expect(f.sent[0]?.text).toContain("Branch needs one fix.");
	expect(f.sent[0]?.text).not.toContain("Old result");
});

test("execution errors remain failures and notify the parent without an explicit done tool", async () => {
	const f = fixture(false);
	await reportAgentRuntime({ ...f.end, turn: { ...f.end.turn, failed: true } }, f.ports);
	expect(f.agents.get("child")?.state).toBe("failed");
	expect(f.sent[0]?.text).toContain("Turn failed.");
	expect(f.sent[0]?.text).toContain("State: failed");
});

test.each([true, false])("only resuming the mission lead clears blocked state (lead: %s)", async (isLead) => {
	const f = fixture(isLead);
	f.mission.state = "blocked";
	const resumed: Mission[] = [];
	await reportAgentRuntime(
		{ ...f.end, turn: { ...f.end.turn, endedAt: undefined } },
		{
			...f.ports,
			resumed: async (mission) => {
				resumed.push(mission);
			},
		},
	);
	expect(resumed).toHaveLength(isLead ? 1 : 0);
	if (isLead) expect(resumed[0]?.state).toBe("running");
});
