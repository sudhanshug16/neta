import { nowIso } from "../core/time.ts";
import type { Agent, Leader, Mission } from "../core/types.ts";
import type { CloseMissionInput, CloseOutcome } from "../tools/handlers/lifecycle.ts";
import { NodeError } from "./protocol.ts";
import type { NodeContext } from "./server.ts";

export interface WorkspaceResetPorts {
	save(mission: Mission): Promise<void>;
	release(workspaceId: string, holder: string): Promise<void>;
	// The authoritative mission-close pipeline (closeout locks, mode handling
	// and teardown included). Reset never removes a worktree itself.
	close(input: CloseMissionInput): Promise<CloseOutcome>;
}

// A mission is active when its stored agents are queued, starting or running,
// when the workspace leader still holds it as its Lead++ mission, or when a
// runtime turn is executing on one of its sessions even though the stored
// record already reads idle. Snapshotted before reset stops anything.
function missionIsActive(
	agents: Agent[],
	mission: Mission,
	leader: Leader | undefined,
	isTurnActive: ((sessionId: string) => boolean) | undefined,
): boolean {
	if (leader?.activeMissionId === mission.id) return true;
	return agents.some((agent) => {
		if (agent.missionId !== mission.id) return false;
		if (["queued", "starting", "running"].includes(agent.state)) return true;
		return isTurnActive?.(agent.sessionId) === true;
	});
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
	const isTurnActive =
		ctx.runtime.isTurnActive === undefined
			? undefined
			: (sessionId: string) => ctx.runtime.isTurnActive?.(sessionId) === true;
	const wasActive = new Map(
		missions.map((mission) => [mission.id, missionIsActive(agents, mission, leader, isTurnActive)]),
	);
	// Quiesce in strict phases. First stop every session and archive every
	// agent with NO lease released: releasing the first writer while a second
	// is still queued would promote (start) it mid-reset. Only once nothing
	// remains queued are the agent leases released, which makes promotion a
	// no-op. (Admission of new work is already blocked by the caller, which
	// clears this workspace's pending closes, modes and releases and rejects
	// new mission/agent/model calls while resetting.)
	if (ctx.runtime.isTurnActive?.(leader.sessionId)) await ctx.runtime.cancel(leader.sessionId);
	const quiesced: Agent[] = [];
	for (const agent of agents.filter((item) => item.state !== "archived")) {
		if (agent.provider === "pi" && ctx.pi) ctx.pi.closeSession(agent.sessionId);
		else await ctx.runtime.close(agent.sessionId);
		const archived = { ...agent, state: "archived" as const, endedAt: agent.endedAt ?? nowIso() };
		await ctx.store.putAgent(archived);
		quiesced.push(archived);
		ctx.hub.broadcast("state", { kind: "agent", record: archived });
	}
	for (const agent of quiesced) {
		await ports.release(workspaceId, agent.id);
	}
	// Clean inactive worktrees close through the authoritative pipeline with
	// their branches retained; dirty or active ones stay open with a visible
	// retryable reason instead of a fabricated success. A throwing removal is
	// contained per mission and persisted the same way.
	for (const mission of missions) {
		if (mission.state === "closed") continue;
		if (mission.worktree === undefined) {
			const closed: Mission = {
				...mission,
				state: "closed",
				closedAt: nowIso(),
				disposition: "abandoned",
				closeReason: "Archived by workspace reset",
			};
			await ports.save(closed);
			ctx.hub.broadcast("state", { kind: "mission", record: closed });
			continue;
		}
		if (wasActive.get(mission.id) === true) {
			const pending: Mission = {
				...mission,
				attention:
					"Reset deferred worktree removal: agents were active when reset stopped them; close the mission normally after review",
			};
			await ports.save(pending);
			ctx.hub.broadcast("state", { kind: "mission", record: pending });
			continue;
		}
		let outcome: CloseOutcome;
		try {
			outcome = await ports.close({
				mission,
				disposition: "abandoned",
				reason: "Archived by workspace reset",
				repositoryRoot: root,
			});
		} catch (error) {
			const failed: Mission = {
				...mission,
				attention: `Reset cleanup failed: ${error instanceof Error ? error.message : String(error)}; retry the close`,
			};
			outcome = { ok: false, attention: failed.attention ?? "", mission: failed };
		}
		await ports.save(outcome.mission);
		ctx.hub.broadcast("state", { kind: "mission", record: outcome.mission });
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
