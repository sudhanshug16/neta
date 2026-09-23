// `neta_mission` and `neta_agent`: one call creates, isolates, starts work.
// The Node wires the ports in T5.9 (06 supplies worktrees and leases, 03 the
// sessions, T5.8 the skills); tests stub them. Everything validated before
// anything is spawned, so a refusal leaves no sessions behind.

import { ulid } from "../../core/ids.ts";
import { distinctMissionLead } from "../../core/mission-lead.ts";
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
import type { Effort, RoutingDecision } from "../../routing/types.ts";
import { WorktreeSetupError } from "../../worktrees/setup-diagnostics.ts";
import { resolveMission } from "../mission-reference.ts";
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
	fallbackModels?: string[];
	skills: string[];
	canSpawn: boolean;
	name: string;
	worktreePath?: string;
}

export interface MissionPorts {
	numbers: {
		allocateNumber(workspaceId: WorkspaceId): Promise<number>;
		isAllocated?(workspaceId: WorkspaceId, number: number): Promise<boolean>;
	};
	missions: { save(mission: Mission): Promise<void> };
	sessions: {
		pi?: boolean;
		routeModel?(input: {
			workspaceId: WorkspaceId;
			provider: string;
			model?: string;
			task: string;
			objective: string;
			effort?: Effort;
		}): Promise<{ provider: string; model: string; routing?: RoutingDecision } | undefined>;
		selectModel?(input: {
			workspaceId: WorkspaceId;
			provider: string;
			model: string;
		}): Promise<{ provider: string; model: string }>;
		// Two steps, in this order: the session exists, then the Agent record
		// is on file, then the context prompt goes out. A fast agent's first
		// `tools/call` has to find its own record, and the first prompt is
		// what makes it call.
		launch(input: SessionLaunch): Promise<{ sessionId: SessionId }>;
		brief(input: SessionLaunch & { sessionId: SessionId }): Promise<void>;
		close(sessionId: SessionId): Promise<void>;
		failed(agent: Agent): Promise<void>;
	};
	worktrees: {
		prepare(
			mission: Mission,
			workspace: Workspace,
			opts?: { recovery?: NonNullable<MissionParams["recoverWorktree"]>; deferSave?: boolean },
		): Promise<Mission>;
	};
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

class MissionLeadSessionAliasError extends Error {}

// An agent may work at the mission's access or below it, never above.
function aboveMission(spec: Access, mission: Access): boolean {
	return spec === "readWrite" && mission === "readOnly";
}

function allSkills(lead: LeadSpec, agents: AgentSpec[]): string[] {
	const names: string[] = [...(lead.skills ?? [])];
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
		fallbackModels?: string[];
		skills: string[];
		canSpawn: boolean;
		taken: Set<string>;
		routing?: RoutingDecision;
	},
	onReserved?: (agent: Agent) => Promise<void>,
	identity?: { id: AgentId; sessionId: SessionId },
): Promise<Agent> {
	if (ctx.deps.sessions.selectModel !== undefined) {
		const provider = input.provider;
		const selected = await ctx.deps.sessions.selectModel({ workspaceId: workspace.id, provider, model: input.model });
		const fallbackModels: string[] = [];
		for (const model of input.fallbackModels ?? []) {
			fallbackModels.push(
				(await ctx.deps.sessions.selectModel({ workspaceId: workspace.id, provider, model })).model,
			);
		}
		input = {
			...input,
			...selected,
			fallbackModels,
		};
	}
	const id = identity?.id ?? ulid();
	const sessionId = identity?.sessionId ?? ulid();
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
		fallbackModels: input.fallbackModels ?? [],
		skills: input.skills,
		canSpawn: input.canSpawn,
		name,
		worktreePath: mission.worktree?.path,
	};
	const agent: Agent = {
		requestedModel: input.model,
		routing: input.routing,
		id,
		missionId: mission.id,
		workspaceId: mission.workspaceId,
		name,
		task: input.task,
		access: input.access,
		provider: input.provider,
		model: input.model,
		fallbackModels: input.fallbackModels ?? [],
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
		let aliasedSession = false;
		try {
			const created = await ctx.deps.sessions.launch(launch);
			if (input.canSpawn && created.sessionId === ctx.deps.store.getLeader(workspace.id)?.sessionId) {
				aliasedSession = true;
				throw new MissionLeadSessionAliasError(
					"Mission lead session aliases the workspace leader; use a separate lead session.",
				);
			}
			live = created.sessionId === sessionId ? reserved : { ...reserved, sessionId: created.sessionId };
			if (live.sessionId !== reserved.sessionId) await ctx.deps.store.putAgent(live);
			await ctx.deps.sessions.brief({ ...launch, sessionId: live.sessionId });
			return ctx.deps.store.getAgent(live.id) ?? live;
		} catch (error) {
			// The returned identity might belong to the workspace leader. Never
			// close or brief that session, or bind the mission actor to it.
			if (!aliasedSession) await ctx.deps.sessions.close(live.sessionId).catch(() => undefined);
			const failed = { ...live, state: "failed" as const, endedAt: nowIso(), outcome: String(error) };
			await ctx.deps.store.putAgent(failed);
			await ctx.deps.sessions.failed(failed);
			if (aliasedSession) throw error;
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

async function createMissionUnlocked(ctx: MissionToolContext, params: MissionParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "leader") {
		return { ok: false, code: "notAuthorised", message: "only the leader starts missions" };
	}
	// Old clients can bypass the published schema. Refuse before routing, number
	// allocation, worktree preparation, reservation or launch.
	if (params.lead === "self" || typeof params.lead !== "object" || params.lead === null) {
		return refused(
			"lead: self is no longer supported. Supply a separate mission lead with a task and effort (1–5 unless a model is explicit).",
		);
	}
	const leadSpec = params.lead;
	const workspace = ctx.deps.store.getWorkspace(ctx.actor.workspaceId);
	if (workspace === undefined) {
		return notFound(`no such workspace: ${ctx.actor.workspaceId}`);
	}
	if ([leadSpec, ...(params.agents ?? [])].some((spec) => spec.fallbackModels?.length))
		return refused("fallbackModels is deprecated: automatic model switching is disabled. Omit it or pass [].");
	if (params.recoverWorktree !== undefined && workspace.kind !== "git")
		return refused("worktree recovery is available only for Git workspaces");
	if (params.continues !== undefined) {
		const prev = resolveMission(ctx, params.continues);
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
		names: allSkills(leadSpec, params.agents ?? []),
	});
	if (!skillCheck.ok) {
		return { ok: false, code: "missingSkill", message: `unknown skill: ${skillCheck.missing}` };
	}
	const leader = ctx.deps.store.getLeader(workspace.id);
	if (leader === undefined) {
		return notFound(`no leader for workspace: ${workspace.id}`);
	}

	// Resolve once before side effects. The launch path only validates the resolved ID.
	const resolved = new Map<LeadSpec | AgentSpec, { provider: string; model: string; routing?: RoutingDecision }>();
	if (ctx.deps.sessions.routeModel) {
		for (const spec of [leadSpec, ...(params.agents ?? [])]) {
			const selection = await ctx.deps.sessions.routeModel({
				workspaceId: workspace.id,
				provider: spec.provider ?? leader.provider,
				model: spec.model,
				task: spec.task,
				objective: params.objective,
				effort: spec.effort,
			});
			if (selection) resolved.set(spec, selection);
		}
	}
	// Validate the entire staffing plan before creating a worktree or mission.
	if (ctx.deps.sessions.selectModel) {
		const specs = [leadSpec, ...(params.agents ?? [])];
		for (const spec of specs) {
			await ctx.deps.sessions.selectModel({
				workspaceId: workspace.id,
				provider: resolved.get(spec)?.provider ?? spec.provider ?? leader.provider,
				model: resolved.get(spec)?.model ?? spec.model ?? leader.model,
			});
			for (const model of spec.fallbackModels ?? []) {
				await ctx.deps.sessions.selectModel({
					workspaceId: workspace.id,
					provider: resolved.get(spec)?.provider ?? spec.provider ?? leader.provider,
					model,
				});
			}
		}
	}
	if (params.recoverWorktree !== undefined && resolveMission(ctx, params.recoverWorktree.number) !== undefined) {
		return refused(`mission #${params.recoverWorktree.number} already exists and cannot be recovered`);
	}
	if (
		params.recoverWorktree !== undefined &&
		(ctx.deps.numbers.isAllocated === undefined ||
			!(await ctx.deps.numbers.isAllocated(workspace.id, params.recoverWorktree.number)))
	)
		return refused(`mission #${params.recoverWorktree.number} is not an unused historical mission number`);
	const leadIdentity = { id: ulid(), sessionId: ulid() };
	if (
		leadIdentity.id === leader.sessionId ||
		leadIdentity.sessionId === leader.sessionId ||
		leadIdentity.id === leadIdentity.sessionId
	)
		return refused(
			"Mission lead must have a distinct actor and session from the workspace leader. Retry with a separate lead task and effort.",
		);
	const number = params.recoverWorktree?.number ?? (await ctx.deps.numbers.allocateNumber(workspace.id));
	const createdAt = nowIso();
	let mission: Mission = {
		id: ulid(),
		number,
		workspaceId: workspace.id,
		machineId: ctx.deps.store.machine().id,
		name: params.name,
		objective: params.objective,
		changes: [],
		lead: { kind: "agent", agentId: leadIdentity.id },
		agentIds: [],
		access: params.access,
		state: "running",
		createdAt,
		continuesMissionId: params.continues === undefined ? undefined : resolveMission(ctx, params.continues)?.id,
	};
	if (workspace.kind === "git") {
		try {
			mission = await ctx.deps.worktrees.prepare(mission, workspace, {
				recovery: params.recoverWorktree,
				deferSave: true,
			});
		} catch (error) {
			if (error instanceof WorktreeSetupError) {
				const { diagnostic } = error;
				return {
					ok: false,
					code: "setupFailed",
					message: JSON.stringify({
						kind: "worktreeSetup",
						number: diagnostic.number,
						branch: diagnostic.branch,
						partialWorktree: diagnostic.partialWorktree?.path,
						exitCode: diagnostic.exitCode,
						diagnostic: error.diagnosticPath,
						persistenceError: error.persistenceError,
						stdout: diagnostic.stdout,
						stderr: diagnostic.stderr,
						missionRegistered: false,
						agentsLaunched: false,
					}),
				};
			}
			if (params.recoverWorktree !== undefined)
				return refused(error instanceof Error ? error.message : "worktree recovery failed");
			throw error;
		}
	}
	// The leader's own name is spoken for: two "Halden"s in the mission bar
	// and on the spine would name one person twice.
	const taken = new Set<string>([leader.name]);
	const launched: Agent[] = [];
	{
		let lead: Agent;
		try {
			lead = await launchAgent(
				ctx,
				mission,
				workspace,
				{
					task: leadSpec.task,
					// Mission leads begin in Lead. The mission's write allowance is a
					// ceiling; it does not grant effective writer access until Lead++.
					access: "readOnly",
					provider: resolved.get(leadSpec)?.provider ?? leadSpec.provider ?? leader.provider,
					model: resolved.get(leadSpec)?.model ?? leadSpec.model ?? leader.model,
					routing: resolved.get(leadSpec)?.routing,
					fallbackModels: leadSpec.fallbackModels,
					skills: leadSpec.skills ?? [],
					canSpawn: true,
					taken,
				},
				async (reserved) => {
					mission.agentIds.push(reserved.id);
					await ctx.deps.missions.save(mission);
				},
				leadIdentity,
			);
		} catch (error) {
			if (!(error instanceof MissionLeadSessionAliasError)) throw error;
			mission = { ...mission, state: "failed", attention: error.message };
			await ctx.deps.missions.save(mission);
			await ctx.deps.store.appendEvent({
				workspaceId: workspace.id,
				kind: "mission.created",
				missionId: mission.id,
				data: { number: mission.number, name: mission.name },
			});
			return refused(
				`${error.message} Mission #${mission.number} remains failed and can be closed without touching the workspace leader's session.`,
			);
		}
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
				provider: resolved.get(spec)?.provider ?? spec.provider ?? leader.provider,
				model: resolved.get(spec)?.model ?? spec.model ?? leader.model,
				routing: resolved.get(spec)?.routing,
				fallbackModels: spec.fallbackModels,
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
			missionId: mission.number,
			id: mission.id, // Legacy callers; new tools use the workspace mission number.
			worktree: mission.worktree?.path ?? null,
			agents: launched.map((agent) => ({
				id: agent.id,
				name: agent.name,
				model: agent.model,
				routing: agent.routing,
			})),
			...(queued ? { queued: true as const } : {}),
		},
	};
}

async function createAgentUnlocked(ctx: MissionToolContext, params: AgentParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "lead" && ctx.actor.kind !== "leader") {
		return { ok: false, code: "notAuthorised", message: "only a lead or the leader adds agents" };
	}
	const mission = resolveMission(ctx, params.missionId);
	if (mission === undefined) {
		return params.missionId === undefined
			? refused(
					"No active mission. Use neta_mission with a lead task to create and start a new delegation, or pass an existing mission number as missionId.",
				)
			: notFound(`no such mission in this workspace: ${params.missionId}`);
	}
	if (ctx.actor.kind === "lead" && mission.id !== ctx.actor.missionId) {
		return refused("a lead adds agents to its own mission only");
	}
	if (params.fallbackModels?.length)
		return refused("fallbackModels is deprecated: automatic model switching is disabled. Omit it or pass [].");
	if (mission.state === "closed") {
		return refused("the mission is closed");
	}
	if (
		!distinctMissionLead(
			mission,
			ctx.deps.store.getLeader(mission.workspaceId),
			mission.lead.kind === "agent" ? ctx.deps.store.getAgent(mission.lead.agentId) : undefined,
		)
	) {
		return refused(
			"This legacy self-led mission cannot resume active work. Close it and create a new mission with a separate lead task and effort.",
		);
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
	const selection = await ctx.deps.sessions.routeModel?.({
		workspaceId: workspace.id,
		provider: params.provider ?? caller?.provider ?? "unknown",
		model: params.model,
		task: params.task,
		objective: mission.objective,
		effort: params.effort,
	});
	const spawned = await launchAgent(ctx, mission, workspace, {
		task: params.task,
		access: params.access,
		provider: selection?.provider ?? params.provider ?? caller?.provider ?? "unknown",
		model: selection?.model ?? params.model ?? caller?.model ?? "unknown",
		routing: selection?.routing,
		fallbackModels: params.fallbackModels,
		skills: params.skills ?? [],
		canSpawn: false,
		taken,
	});
	await ctx.deps.missions.save({ ...mission, agentIds: [...mission.agentIds, spawned.id] });
	await announceSpawn(ctx, spawned);
	return {
		ok: true,
		data: {
			agentId: spawned.id,
			name: spawned.name,
			missionId: mission.number,
			model: spawned.model,
			routing: spawned.routing,
		},
	};
}

const agentMutations = new Map<string, Promise<void>>();
const missionMutations = new Map<string, Promise<void>>();
async function createMission(ctx: MissionToolContext, params: MissionParams): Promise<ToolResult> {
	const key = ctx.actor.workspaceId;
	const previous = missionMutations.get(key) ?? Promise.resolve();
	let release = (): void => undefined;
	const current = new Promise<void>((done) => {
		release = done;
	});
	const tail = previous.then(() => current);
	missionMutations.set(key, tail);
	await previous;
	try {
		return await createMissionUnlocked(ctx, params);
	} finally {
		release();
		if (missionMutations.get(key) === tail) missionMutations.delete(key);
	}
}
async function createAgent(ctx: MissionToolContext, params: AgentParams): Promise<ToolResult> {
	const key = resolveMission(ctx, params.missionId)?.id ?? ctx.actor.workspaceId;
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
