import { expect, test } from "bun:test";
import type { Agent, Leader, Mission, Workspace } from "../src/core/types.ts";
import type { NodeContext } from "../src/node/server.ts";
import { archiveWorkspace } from "../src/node/workspace-reset.ts";

function fixture(failClose = false) {
	const calls: string[] = [];
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
		acp: {
			isTurnActive: () => true,
			cancel: async () => {
				calls.push("cancel");
			},
			close: async (id: string) => {
				calls.push(`stop:${id}`);
				if (failClose) throw new Error("stop failed");
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
			expect(missions.every((m) => m.state === "closed")).toBe(true);
			calls.push(`release:${holder}`);
		},
	};
	return { context, ports, missions, agents, calls, leader: () => leader };
}

test("workspace reset archives all work before releasing queues and preserves other workspaces and files", async () => {
	const f = fixture();
	await archiveWorkspace(f.context, "w", f.ports);
	expect(f.calls.slice(0, 2)).toEqual(["close:one", "close:two"]);
	expect(f.agents.filter((a) => a.workspaceId === "w").every((a) => a.state === "archived")).toBe(true);
	expect(f.agents.find((a) => a.id === "unrelated")?.state).toBe("running");
	expect(f.calls).not.toContain("stop:other");
	expect(f.missions[0]?.worktree?.path).toBe("/worktrees/one");
	expect(f.leader().activeMissionId).toBeUndefined();
	expect(f.leader().mode).toBe("lead");
	expect(f.leader().sessionId).toBe("new");
});

test("stop failure does not report a worker archived or release its lease", async () => {
	const f = fixture(true);
	await expect(archiveWorkspace(f.context, "w", f.ports)).rejects.toThrow("stop failed");
	expect(f.agents[0]?.state).toBe("running");
	expect(f.calls.some((call) => call.startsWith("release:"))).toBe(false);
	expect(f.leader().sessionId).toBe("leader");
});
