import { nowIso } from "../core/time.ts";
import type { Mission } from "../core/types.ts";
import { NodeError } from "./protocol.ts";
import type { NodeContext } from "./server.ts";

/** Archive durable work without deleting worktrees or conversation history. */
export async function archiveWorkspace(
	ctx: NodeContext,
	workspaceId: string,
	ports: {
		save(mission: Mission): Promise<void>;
		release(workspaceId: string, holder: string): Promise<void>;
	},
): Promise<void> {
	const leader = ctx.store.getLeader(workspaceId);
	const workspace = ctx.store.getWorkspace(workspaceId);
	if (!leader || !workspace) throw new NodeError("NOT_FOUND", "workspace leader not found");
	const missions = ctx.store.listMissions(workspaceId);
	// Close every queue before stopping actors or releasing leases, so release
	// cannot promote a queued worker during reset. Retain every worktree.
	for (const mission of missions) {
		if (mission.state === "closed") continue;
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
	if (ctx.acp.isTurnActive?.(leader.sessionId)) await ctx.acp.cancel(leader.sessionId);
	for (const agent of ctx.store
		.listAgents()
		.filter((item) => item.workspaceId === workspaceId && item.state !== "archived")) {
		if (agent.provider === "pi" && ctx.pi) ctx.pi.closeSession(agent.sessionId);
		else await ctx.acp.close(agent.sessionId);
		const archived = { ...agent, state: "archived" as const, endedAt: agent.endedAt ?? nowIso() };
		await ctx.store.putAgent(archived);
		await ports.release(workspaceId, agent.id);
		ctx.hub.broadcast("state", { kind: "agent", record: archived });
	}
	for (const mission of missions) await ports.release(workspaceId, mission.id);
	const root = workspace.roots.find((item) => item.machineId === leader.machineId)?.path;
	if (!root) throw new NodeError("NOT_FOUND", "workspace path not found");
	const fresh = await ctx.acp.ensureSession({
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
