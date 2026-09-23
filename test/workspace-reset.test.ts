import { expect, test } from "bun:test";
import type { Agent, Leader, Mission, Workspace } from "../src/core/types.ts";
import type { CloseMissionInput, CloseOutcome } from "../src/tools/handlers/lifecycle.ts";
import type { NodeContext } from "../src/node/server.ts";
import { archiveWorkspace } from "../src/node/workspace-reset.ts";

function fixture(
	close?: (input: CloseMissionInput) => Promise<CloseOutcome>,
	turnActive?: (sessionId: string) => boolean,
) {
	const calls: string[] = [];
	const closes: CloseMissionInput[] = [];
	let leader = {
		workspaceId: "w",
		machineId: "m",
		sessionId: "leader",
		name: "Leader",
		provider: "fake",
		model: "test",
		mode: "leadPlus",
		modeSince: "0",
		modeActiveMs: 10,
		state: "running",
		activeMissionId: "one",
	} as Leader;
	const workspace = {
		id: "w",
		name: "Workspace",
		kind: "folder",
		createdAt: "0",
		roots: [{ machineId: "m", path: "/workspace" }],
	} as Workspace;
	const missions: Mission[] = ["one", "two"].map(
		(id) =>
			({
				id,
				workspaceId: "w",
				machineId: "m",
				changes: [],
				number: 1,
				name: id,
				objective: "test",
				access: "readWrite",
				lead: { kind: "leader" },
				agentIds: [],
				state: "running",
				createdAt: "0",
				worktree: { path: `/worktrees/${id}`, provider: "worktrunk", branch: id, base: "main" },
			}) as Mission,
	);
	const agents: Agent[] = ["running", "queued", "failed"].map(
		(state, index) =>
			({
				id: `agent-${index}`,
				sessionId: `session-${index}`,
				workspaceId: "w",
				missionId: "one",
				name: "Worker",
				task: "test",
				access: "readWrite",
				provider: "fake",
				model: "test",
				skills: [],
				canSpawn: false,
				startedAt: "0",
				state,
			}) as Agent,
	);
	agents.push({ ...agents[0], id: "unrelated", sessionId: "other", workspaceId: "other" } as Agent);
	const context = {
		store: {
			getLeader: () => leader,
			getWorkspace: () => workspace,
			listMissions: () => missions,
			listAgents: () => agents,
			putAgent: async (agent: Agent) => {
				calls.push(`archive:${agent.id}`);
				agents[agents.findIndex((a) => a.id === agent.id)] = agent;
			},
			putLeader: async (value: Leader) => {
				leader = value;
				calls.push("leader");
			},
		},
		runtime: {
			isTurnActive: (sessionId: string) => (turnActive === undefined ? sessionId === "leader" : turnActive(sessionId)),
			cancel: async () => {
				calls.push("cancel");
			},
			close: async (id: string) => {
				calls.push(`stop:${id}`);
			},
			ensureSession: async (input: { access: string; cwd: string }) => {
				expect(input.access).toBe("readOnly");
				expect(input.cwd).toBe("/workspace");
				return { sessionId: "new" };
			},
		},
		hub: { broadcast: () => {} },
	} as unknown as NodeContext;
	const ports = {
		save: async (mission: Mission) => {
			calls.push(`close:${mission.id}`);
			missions[missions.findIndex((m) => m.id === mission.id)] = mission;
		},
		release: async (_workspace: string, holder: string) => {
			calls.push(`release:${holder}`);
		},
		close:
			close ??
			(async (input: CloseMissionInput) => {
				closes.push(input);
				return {
					ok: true,
					mission: {
						...input.mission,
						worktree: undefined,
						state: "closed" as const,
						closedAt: "0",
						disposition: "abandoned" as const,
						closeReason: `Archived by workspace reset; worktree reclaimed, branch ${input.mission.worktree?.branch} retained`,
					},
				};
			}),
	};
	return { context, ports, missions, agents, calls, closes, leader: () => leader };
}

test("reset quiesces actors before closing, reclaims clean inactive worktrees, leaves active ones open", async () => {
	const f = fixture();
	await archiveWorkspace(f.context, "w", f.ports);
	// Actors were stopped and archived before any removal ran.
	expect(f.calls).toContain("stop:session-0");
	expect(f.agents.filter((a) => a.workspaceId === "w").every((a) => a.state === "archived")).toBe(true);
	expect(f.agents.find((a) => a.id === "unrelated")?.state).toBe("running");
	expect(f.calls).not.toContain("stop:other");
	// Mission one had running and queued agents (and the leader's active
	// mission): it stays open with its worktree intact and a retryable reason,
	// and the authoritative close was never invoked for it.
	expect(f.missions[0]).toMatchObject({ id: "one", state: "running" });
	expect(f.missions[0]?.worktree?.path).toBe("/worktrees/one");
	expect(f.missions[0]?.attention).toContain("agents were active");
	expect(f.closes.map((input) => input.mission.id)).not.toContain("one");
	// Mission two was inactive: it closed through the pipeline with its
	// branch retained.
	expect(f.missions[1]).toMatchObject({ id: "two", state: "closed", worktree: undefined });
	expect(f.missions[1]?.closeReason).toContain("branch two retained");
	expect(f.closes.map((input) => input.mission.id)).toEqual(["two"]);
	expect(f.leader().activeMissionId).toBeUndefined();
	expect(f.leader().mode).toBe("lead");
	expect(f.leader().sessionId).toBe("new");
});

test("a refused removal stays open with the refusal reason and keeps its work", async () => {
	const f = fixture(async (input) => ({
		ok: false,
		attention: "worktree two has uncommitted changes",
		mission: { ...input.mission, attention: "worktree two has uncommitted changes" },
	}));
	await archiveWorkspace(f.context, "w", f.ports);
	expect(f.missions[1]).toMatchObject({ id: "two", state: "running" });
	expect(f.missions[1]?.worktree?.path).toBe("/worktrees/two");
	expect(f.missions[1]?.attention).toContain("worktree two has uncommitted changes");
	expect(f.missions[1]?.closedAt).toBeUndefined();
});

test("a throwing removal is contained per mission and persisted retryably", async () => {
	const f = fixture(async () => {
		throw new Error("wt list failed: I/O error");
	});
	await archiveWorkspace(f.context, "w", f.ports);
	expect(f.missions[1]).toMatchObject({ id: "two", state: "running" });
	expect(f.missions[1]?.worktree?.path).toBe("/worktrees/two");
	expect(f.missions[1]?.attention).toContain("Reset cleanup failed: wt list failed: I/O error");
	expect(f.missions[1]?.attention).toContain("retry the close");
});

test("the leader's active mission stays open even with no stored active agents", async () => {
	const f = fixture();
	for (const agent of f.agents) {
		if (agent.workspaceId === "w") agent.state = "completed";
	}
	await archiveWorkspace(f.context, "w", f.ports);
	// activeMissionId still names mission one: Lead++-held work is active.
	expect(f.missions[0]).toMatchObject({ id: "one", state: "running" });
	expect(f.missions[0]?.worktree?.path).toBe("/worktrees/one");
	expect(f.missions[1]).toMatchObject({ id: "two", state: "closed", worktree: undefined });
});

test("a runtime-executing idle session counts as active", async () => {
	const f = fixture(undefined, (sessionId) => sessionId === "leader" || sessionId === "session-9");
	f.agents.push({
		id: "agent-9",
		sessionId: "session-9",
		workspaceId: "w",
		missionId: "two",
		name: "Worker",
		task: "test",
		access: "readWrite",
		provider: "fake",
		model: "test",
		skills: [],
		canSpawn: false,
		startedAt: "0",
		state: "idle",
	} as Agent);
	await archiveWorkspace(f.context, "w", f.ports);
	expect(f.missions[1]).toMatchObject({ id: "two", state: "running" });
	expect(f.missions[1]?.worktree?.path).toBe("/worktrees/two");
	expect(f.missions[1]?.attention).toContain("agents were active");
});

test("stop failure does not report a worker archived or release its lease", async () => {
	const f = fixture();
	(f.context.runtime as unknown as { close: (id: string) => Promise<void> }).close = async () => {
		throw new Error("stop failed");
	};
	await expect(archiveWorkspace(f.context, "w", f.ports)).rejects.toThrow("stop failed");
	expect(f.agents[0]?.state).toBe("running");
	expect(f.calls.some((call) => call.startsWith("release:"))).toBe(false);
	expect(f.leader().sessionId).toBe("leader");
});
