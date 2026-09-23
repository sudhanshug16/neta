import { nowIso } from "../core/time.ts";
import type { Agent, Mission } from "../core/types.ts";
import { type RemoveResult, WorktrunkDriver } from "../worktrees/driver.ts";
import { NodeError } from "./protocol.ts";
import type { NodeContext } from "./server.ts";

export interface WorkspaceResetPorts {
	save(mission: Mission): Promise<void>;
	release(workspaceId: string, holder: string): Promise<void>;
	// Optional removal hook (tests inject a stub). The default is a
	// branch-preserving driver removal anchored at the workspace root: clean
	// trees are reclaimed, dirty ones refuse, and no branch is ever deleted.
	removeWorktree?: (mission: Mission, repoRoot: string) => Promise<RemoveResult>;
}

function activeAgents(agents: Agent[], missionId: string): boolean {
	return agents.some(
		(agent) => agent.missionId === missionId && ["queued", "starting", "running"].includes(agent.state),
	);
}

/** Archive durable work without deleting conversation history. */
export async function archiveWorkspace(
	ctx: NodeContext,
	workspaceId: string,
	ports: WorkspaceResetPorts,
): Promise<void> {
	const leader = ctx.store.getLeader(workspaceId);
	const workspace = ctx.store.getWorkspace(workspaceId);
	if (!leader || !workspace) throw new NodeError("NOT_FOUND", "workspace leader not found");
	const root = workspace.roots.find((item) => item.machineId === leader.machineId)?.path;
	if (!root) throw new NodeError("NOT_FOUND", "workspace path not found");
	const missions = ctx.store.listMissions(workspaceId);
	const agents = ctx.store.listAgents().filter((item) => item.workspaceId === workspaceId);
	const driver = ports.removeWorktree === undefined ? new WorktrunkDriver() : undefined;
	const remove = ports.removeWorktree ?? ((mission: Mission) => driver?.remove({
		repoRoot: root,
		path: mission.worktree?.path ?? root,
		branch: mission.worktree?.branch ?? "",
		base: mission.worktree?.base ?? "",
	}) ?? Promise.reject(new Error("no worktree driver")));
	// Close every queue before stopping actors or releasing leases, so release
	// cannot promote a queued worker during reset. Clean inactive worktrees
	// are reclaimed with their branches retained; dirty or active ones stay
	// open with a visible retryable reason instead of a fabricated success.
	for (const mission of missions) {
		if (mission.state === "closed") continue;
		if (mission.worktree !== undefined && !activeAgents(agents, mission.id)) {
			const removed = await remove(mission, root);
			if (removed.ok) {
				const { path, branch } = mission.worktree;
				const closed: Mission = {
					...mission,
					worktree: undefined,
					state: "closed",
					closedAt: nowIso(),
					disposition: "abandoned",
					closeReason: `Archived by workspace reset; worktree reclaimed at ${path}, branch ${branch} retained`,
					attention: undefined,
				};
				await ports.save(closed);
				ctx.hub.broadcast("state", { kind: "mission", record: closed });
				continue;
			}
			const pending: Mission = {
				...mission,
				attention: `Reset could not reclaim worktree: ${removed.reason}; close the mission normally after review`,
			};
			await ports.save(pending);
			ctx.hub.broadcast("state", { kind: "mission", record: pending });
			continue;
		}
		if (mission.worktree !== undefined) {
			const pending: Mission = {
				...mission,
				attention: "Reset deferred worktree removal: agents still active; close the mission normally after review",
			};
			await ports.save(pending);
			ctx.hub.broadcast("state", { kind: "mission", record: pending });
			continue;
		}
		const closed: Mission = {
			...mission,
			state: "closed",
			closedAt: nowIso(),
			disposition: "abandoned",
			closeReason: "Archived by workspace reset",
		};
		await ports.save(closed);
		ctx.hub.broadcast("state", { kind: "mission", record: closed });
	}
	if (ctx.runtime.isTurnActive?.(leader.sessionId)) await ctx.runtime.cancel(leader.sessionId);
	for (const agent of ctx.store
		.listAgents()
		.filter((item) => item.workspaceId === workspaceId && item.state !== "archived")) {
		if (agent.provider === "pi" && ctx.pi) ctx.pi.closeSession(agent.sessionId);
		else await ctx.runtime.close(agent.sessionId);
		const archived = { ...agent, state: "archived" as const, endedAt: agent.endedAt ?? nowIso() };
		await ctx.store.putAgent(archived);
		await ports.release(workspaceId, agent.id);
		ctx.hub.broadcast("state", { kind: "agent", record: archived });
	}
	for (const mission of missions) await ports.release(workspaceId, mission.id);
	const fresh = await ctx.runtime.ensureSession({
		sessionId: leader.sessionId,
		workspaceId,
		cwd: root,
		provider: leader.provider,
		model: leader.model,
		access: "readOnly",
		unsandboxed: true,
		netaTools: true,
		forceRelaunch: true,
		allowFresh: true,
	});
	const { activeMissionId: _active, ...rest } = leader;
	const updated = {
		...rest,
		sessionId: fresh.sessionId,
		mode: "lead" as const,
		modeSince: nowIso(),
		modeActiveMs: 0,
		state: "idle" as const,
	};
	await ctx.store.putLeader(updated);
	ctx.hub.broadcast("state", { kind: "leader", record: updated });
}
