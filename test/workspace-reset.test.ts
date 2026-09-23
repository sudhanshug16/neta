import { expect, test } from "bun:test";
import type { Agent, Leader, Mission, Workspace } from "../src/core/types.ts";
import type { NodeContext } from "../src/node/server.ts";
import { archiveWorkspace } from "../src/node/workspace-reset.ts";
import type { RemoveResult } from "../src/worktrees/driver.ts";

function fixture(
	failClose = false,
	removeWorktree?: (mission: Mission, repoRoot: string) => Promise<RemoveResult>,
) {
	const calls: string[] = [];
	const removals: string[] = [];
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
			calls.push(`release:${holder}`);
		},
		removeWorktree:
			removeWorktree ??
			(async (mission: Mission, repoRoot: string) => {
				removals.push(`${mission.id}:${repoRoot}`);
				return { ok: true, branchOutcome: "retained_unmerged", path: mission.worktree?.path ?? "" };
			}),
	};
	return { context, ports, missions, agents, calls, removals, leader: () => leader };
}

test("reset reclaims clean inactive worktrees and leaves active ones open with a visible reason", async () => {
	const f = fixture();
	await archiveWorkspace(f.context, "w", f.ports);
	// Mission one still has running and queued agents: it stays open with its
	// worktree intact and a retryable reason instead of a fabricated success.
	expect(f.missions[0]).toMatchObject({ id: "one", state: "running" });
	expect(f.missions[0]?.worktree?.path).toBe("/worktrees/one");
	expect(f.missions[0]?.attention).toContain("agents still active");
	expect(f.removals).not.toContain("one:/workspace");
	// Mission two is inactive and clean: its directory is reclaimed with the
	// branch retained, and only then is it closed.
	expect(f.missions[1]).toMatchObject({
		id: "two",
		state: "closed",
		disposition: "abandoned",
		worktree: undefined,
	});
	expect(f.missions[1]?.closeReason).toContain("worktree reclaimed at /worktrees/two");
	expect(f.missions[1]?.closeReason).toContain("branch two retained");
	expect(f.removals).toContain("two:/workspace");
	expect(f.agents.filter((a) => a.workspaceId === "w").every((a) => a.state === "archived")).toBe(true);
	expect(f.agents.find((a) => a.id === "unrelated")?.state).toBe("running");
	expect(f.calls).not.toContain("stop:other");
	expect(f.leader().activeMissionId).toBeUndefined();
	expect(f.leader().mode).toBe("lead");
	expect(f.leader().sessionId).toBe("new");
});

test("a refused removal stays open with the refusal reason and keeps its work", async () => {
	const f = fixture(false, async () => ({
		ok: false,
		refusal: "dirty" as const,
		reason: "worktree two has uncommitted changes",
	}));
	await archiveWorkspace(f.context, "w", f.ports);
	// The inactive mission stays open: reset never discards dirty data.
	expect(f.missions[1]).toMatchObject({ id: "two", state: "running" });
	expect(f.missions[1]?.worktree?.path).toBe("/worktrees/two");
	expect(f.missions[1]?.attention).toContain("worktree two has uncommitted changes");
	expect(f.missions[1]?.closedAt).toBeUndefined();
});

test("stop failure does not report a worker archived or release its lease", async () => {
	const f = fixture(true);
	await expect(archiveWorkspace(f.context, "w", f.ports)).rejects.toThrow("stop failed");
	expect(f.agents[0]?.state).toBe("running");
	expect(f.calls.some((call) => call.startsWith("release:"))).toBe(false);
	expect(f.leader().sessionId).toBe("leader");
});
