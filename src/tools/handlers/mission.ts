// `neta_mission` and `neta_agent`: one call creates, isolates, starts work.
// The Node wires the ports in T5.9 (06 supplies worktrees and leases, 03 the
// sessions, T5.8 the skills); tests stub them. Everything validated before
// anything is spawned, so a refusal leaves no sessions behind.
import { ulid } from "../../core/ids.ts";
import { pickName } from "../../core/names.ts";
import { nowIso } from "../../core/time.ts";
import type {
	Access,
	Agent,
	AgentId,
	Mission,
	MissionId,
	SessionId,
	Workspace,
	WorkspaceId,
} from "../../core/types.ts";
import type { ToolContext, ToolDeps, ToolHandlers, ToolResult } from "../router.ts";
import type { AgentParams, AgentSpec, LeadSpec, MissionParams } from "../schemas.ts";

export interface SessionLaunch {
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	missionId: MissionId;
	// The actor id 05 names for an agent: the token for this session is
	// minted under it, so the agent's own `agentId` reaches the router.
	agentId: AgentId;
	task: string;
	access: Access;
	provider: string;
	model: string;
	skills: string[];
	canSpawn: boolean;
	name: string;
	worktreePath?: string;
}

export interface MissionPorts {
	numbers: { allocateNumber(workspaceId: WorkspaceId): Promise<number> };
	missions: { save(mission: Mission): Promise<void> };
	sessions: {
		// Two steps, in this order: the session exists, then the Agent record
		// is on file, then the context prompt goes out. A fast agent's first
		// `tools/call` has to find its own record, and the first prompt is
		// what makes it call.
		launch(input: SessionLaunch): Promise<{ sessionId: SessionId }>;
		brief(input: SessionLaunch & { sessionId: SessionId }): Promise<void>;
		close(sessionId: SessionId): Promise<void>;
		failed(agent: Agent): Promise<void>;
	};
	worktrees: { prepare(mission: Mission, workspace: Workspace): Promise<Mission> };
	// The names resolve under the workspace root (`<root>/.neta/skills`, then
	// `~/.neta/skills`), so the workspace travels with the request rather than
	// the port guessing at a working directory.
	skills: {
		check(input: { workspaceId: WorkspaceId; names: string[] }):
			| {
					ok: true;
			  }
			| { ok: false; missing: string; available: string[] };
	};
	// 06 keys a writer lease on the worktree path for a Git mission and on the
	// workspace root otherwise, so the mission and its workspace travel with
	// the request rather than a key the caller had to derive.
	leases: {
		acquire(input: { mission: Mission; workspace: Workspace; holder: AgentId }): Promise<"active" | "queued">;
		release(workspaceId: WorkspaceId, holder: AgentId): Promise<void>;
	};
}

export interface MissionToolContext extends ToolContext {
	deps: ToolDeps & MissionPorts;
}

function refused(message: string): ToolResult {
	return { ok: false, code: "refused", message };
}

function notFound(message: string): ToolResult {
	return { ok: false, code: "notFound", message };
}

// An agent may work at the mission's access or below it, never above.
function aboveMission(spec: Access, mission: Access): boolean {
	return spec === "readWrite" && mission === "readOnly";
}

function allSkills(lead: "self" | LeadSpec, agents: AgentSpec[]): string[] {
	const names: string[] = [];
	if (lead !== "self" && lead.skills !== undefined) {
		names.push(...lead.skills);
	}
	for (const spec of agents) {
		if (spec.skills !== undefined) {
			names.push(...spec.skills);
		}
	}
	return names;
}

async function launchAgent(
	ctx: MissionToolContext,
	mission: Mission,
	workspace: Workspace,
	input: {
		task: string;
		access: Access;
		provider: string;
		model: string;
		skills: string[];
		canSpawn: boolean;
		taken: Set<string>;
	},
	onReserved?: (agent: Agent) => Promise<void>,
): Promise<Agent> {
	const id = ulid();
	const sessionId = ulid();
	const name = pickName(input.taken, id);
	input.taken.add(name);
	const startedAt = nowIso();
	const launch: SessionLaunch = {
		sessionId,
		workspaceId: mission.workspaceId,
		missionId: mission.id,
		agentId: id,
		task: input.task,
		access: input.access,
		provider: input.provider,
		model: input.model,
		skills: input.skills,
		canSpawn: input.canSpawn,
		name,
		worktreePath: mission.worktree?.path,
	};
	const agent: Agent = {
		id,
		missionId: mission.id,
		workspaceId: mission.workspaceId,
		name,
		task: input.task,
		access: input.access,
		provider: input.provider,
		model: input.model,
		skills: input.skills,
		sessionId,
		canSpawn: input.canSpawn,
		state: "starting",
		startedAt,
	};
	// On file before the first prompt: the context prompt is what sets the
	// agent working, and its first tool call resolves through this record.
	const admitted =
		input.access !== "readWrite" || (await ctx.deps.leases.acquire({ mission, workspace, holder: id })) === "active";
	const reserved = admitted ? agent : { ...agent, state: "queued" as const };
	await ctx.deps.store.putAgent(reserved);
	await onReserved?.(reserved);
	if (admitted) {
		let live = reserved;
		try {
			const created = await ctx.deps.sessions.launch(launch);
			live = created.sessionId === sessionId ? reserved : { ...reserved, sessionId: created.sessionId };
			if (live.sessionId !== reserved.sessionId) await ctx.deps.store.putAgent(live);
			await ctx.deps.sessions.brief({ ...launch, sessionId: live.sessionId });
			return live;
		} catch (error) {
			await ctx.deps.sessions.close(live.sessionId).catch(() => undefined);
			const failed = { ...live, state: "failed" as const, endedAt: nowIso(), outcome: String(error) };
			await ctx.deps.store.putAgent(failed);
			await ctx.deps.sessions.failed(failed);
			return failed;
		}
	}
	return reserved;
}

// `mission.created` precedes every `agent.spawned`, so launches stay silent
// until the mission exists.
async function announceSpawn(ctx: MissionToolContext, agent: Agent): Promise<void> {
	await ctx.deps.store.appendEvent({
		workspaceId: agent.workspaceId,
		kind: "agent.spawned",
		missionId: agent.missionId,
		agentId: agent.id,
		sessionId: agent.sessionId,
		data: { name: agent.name },
	});
}

async function createMission(ctx: MissionToolContext, params: MissionParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "leader") {
		return { ok: false, code: "notAuthorised", message: "only the leader starts missions" };
	}
	const workspace = ctx.deps.store.getWorkspace(ctx.actor.workspaceId);
	if (workspace === undefined) {
		return notFound(`no such workspace: ${ctx.actor.workspaceId}`);
	}
	if (params.continues !== undefined) {
		const prev = ctx.deps.store.getMission(params.continues);
		if (prev === undefined || prev.workspaceId !== workspace.id) {
			return notFound(`no such mission: ${params.continues}`);
		}
	}
	for (const spec of params.agents ?? []) {
		if (aboveMission(spec.access, params.access)) {
			return refused("a readWrite agent in a readOnly mission");
		}
	}
	const skillCheck = ctx.deps.skills.check({
		workspaceId: workspace.id,
		names: allSkills(params.lead, params.agents ?? []),
	});
	if (!skillCheck.ok) {
		return { ok: false, code: "missingSkill", message: `unknown skill: ${skillCheck.missing}` };
	}
	const leader = ctx.deps.store.getLeader(workspace.id);
	if (leader === undefined) {
		return notFound(`no leader for workspace: ${workspace.id}`);
	}

	const number = await ctx.deps.numbers.allocateNumber(workspace.id);
	const createdAt = nowIso();
	let mission: Mission = {
		id: ulid(),
		number,
		workspaceId: workspace.id,
		machineId: ctx.deps.store.machine().id,
		name: params.name,
		objective: params.objective,
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: params.access,
		state: "running",
		createdAt,
		continuesMissionId: params.continues,
	};
	if (workspace.kind === "git") {
		mission = await ctx.deps.worktrees.prepare(mission, workspace);
	}
	// The mission exists before any agent receives its first prompt, so that
	// its first tool call can resolve both the actor and its owning mission.
	await ctx.deps.missions.save(mission);

	// The leader's own name is spoken for: two "Halden"s in the mission bar
	// and on the spine would name one person twice.
	const taken = new Set<string>([leader.name]);
	const launched: Agent[] = [];
	if (params.lead === "self") {
		mission.lead = { kind: "leader" };
		await ctx.deps.store.putLeader({ ...leader, activeMissionId: mission.id });
	} else {
		const lead = await launchAgent(
			ctx,
			mission,
			workspace,
			{
				task: params.lead.task,
				// Mission leads begin in Lead. The mission's write allowance is a
				// ceiling; it does not grant effective writer access until Lead++.
				access: "readOnly",
				provider: params.lead.provider ?? leader.provider,
				model: params.lead.model ?? leader.model,
				skills: params.lead.skills ?? [],
				canSpawn: true,
				taken,
			},
			async (reserved) => {
				mission.lead = { kind: "agent", agentId: reserved.id };
				mission.agentIds.push(reserved.id);
				await ctx.deps.missions.save(mission);
			},
		);
		launched.push(lead);
	}
	for (const spec of params.agents ?? []) {
		const spawned = await launchAgent(
			ctx,
			mission,
			workspace,
			{
				task: spec.task,
				access: spec.access,
				provider: spec.provider ?? leader.provider,
				model: spec.model ?? leader.model,
				skills: spec.skills ?? [],
				canSpawn: false,
				taken,
			},
			async (reserved) => {
				mission.agentIds.push(reserved.id);
				await ctx.deps.missions.save(mission);
			},
		);
		launched.push(spawned);
	}
	await ctx.deps.missions.save(mission);
	await ctx.deps.store.appendEvent({
		workspaceId: workspace.id,
		kind: "mission.created",
		missionId: mission.id,
		data: { number: mission.number, name: mission.name },
	});
	for (const agent of launched) {
		await announceSpawn(ctx, agent);
	}

	// A readWrite mission in a folder workspace shares the checkout, so it
	// takes the folder lease; when the lease is held it is still created,
	// only marked queued.
	const queued = launched.some((agent) => agent.state === "queued");
	return {
		ok: true,
		data: {
			number: mission.number,
			id: mission.id,
			worktree: mission.worktree?.path ?? null,
			...(queued ? { queued: true as const } : {}),
		},
	};
}

async function createAgentUnlocked(ctx: MissionToolContext, params: AgentParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "lead" && ctx.actor.kind !== "leader") {
		return { ok: false, code: "notAuthorised", message: "only a lead or the leader adds agents" };
	}
	let missionId = params.missionId;
	if (missionId === undefined) {
		if (ctx.actor.kind === "lead") {
			missionId = ctx.actor.missionId;
		} else {
			missionId = ctx.deps.store.getLeader(ctx.actor.workspaceId)?.activeMissionId;
		}
	}
	if (missionId === undefined) {
		return refused("no mission: pass missionId");
	}
	if (ctx.actor.kind === "lead" && missionId !== ctx.actor.missionId) {
		return refused("a lead adds agents to its own mission only");
	}
	const mission = ctx.deps.store.getMission(missionId);
	if (mission === undefined || mission.workspaceId !== ctx.actor.workspaceId) {
		return notFound(`no such mission: ${missionId}`);
	}
	if (mission.state === "closed") {
		return refused("the mission is closed");
	}
	if (aboveMission(params.access, mission.access)) {
		return refused("a readWrite agent in a readOnly mission");
	}
	const skillCheck = ctx.deps.skills.check({ workspaceId: mission.workspaceId, names: params.skills ?? [] });
	if (!skillCheck.ok) {
		return { ok: false, code: "missingSkill", message: `unknown skill: ${skillCheck.missing}` };
	}

	const caller =
		ctx.actor.kind === "lead"
			? ctx.deps.store.getAgent(ctx.actor.agentId)
			: ctx.deps.store.getLeader(ctx.actor.workspaceId);
	const taken = new Set(ctx.deps.store.listAgents(mission.id).map((agent) => agent.name));
	const workspaceLeader = ctx.deps.store.getLeader(mission.workspaceId);
	if (workspaceLeader !== undefined) {
		taken.add(workspaceLeader.name);
	}
	const workspace = ctx.deps.store.getWorkspace(mission.workspaceId);
	if (workspace === undefined) {
		return notFound(`no workspace for mission: ${mission.id}`);
	}
	const spawned = await launchAgent(ctx, mission, workspace, {
		task: params.task,
		access: params.access,
		provider: params.provider ?? caller?.provider ?? "unknown",
		model: params.model ?? caller?.model ?? "unknown",
		skills: params.skills ?? [],
		canSpawn: false,
		taken,
	});
	await ctx.deps.missions.save({ ...mission, agentIds: [...mission.agentIds, spawned.id] });
	await announceSpawn(ctx, spawned);
	return { ok: true, data: { agentId: spawned.id, name: spawned.name, missionId: mission.id } };
}

const agentMutations = new Map<string, Promise<void>>();
async function createAgent(ctx: MissionToolContext, params: AgentParams): Promise<ToolResult> {
	const key =
		params.missionId ??
		(ctx.actor.kind === "lead"
			? ctx.actor.missionId
			: ctx.deps.store.getLeader(ctx.actor.workspaceId)?.activeMissionId) ??
		ctx.actor.workspaceId;
	const previous = agentMutations.get(key) ?? Promise.resolve();
	let release = (): void => undefined;
	const current = new Promise<void>((done) => {
		release = done;
	});
	const tail = previous.then(() => current);
	agentMutations.set(key, tail);
	await previous;
	try {
		return await createAgentUnlocked(ctx, params);
	} finally {
		release();
		if (agentMutations.get(key) === tail) agentMutations.delete(key);
	}
}

export const missionHandlers: Pick<ToolHandlers, "neta_mission" | "neta_agent"> = {
	neta_mission: (ctx, args) => createMission(ctx as MissionToolContext, args),
	neta_agent: (ctx, args) => createAgent(ctx as MissionToolContext, args),
};
