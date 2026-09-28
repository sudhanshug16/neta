import { deriveMissionState } from "../../core/state.ts";
import type { Agent, Disposition, Mission, WorkspaceId } from "../../core/types.ts";
import { netaDir } from "../../store/paths.ts";
import { readSetupDiagnostic } from "../../worktrees/setup-diagnostics.ts";
import { resolveMission } from "../mission-reference.ts";
import { DEFAULT_READ_BYTES, fitPage, scopedTextPage, utf8Excerpt } from "../paging.ts";
import type { ToolContext, ToolDeps, ToolHandlers, ToolResult } from "../router.ts";
import type { CloseParams, MissionRef, ModelsParams, SetupDiagnosticParams, StatusParams } from "../schemas.ts";

export interface CloseMissionInput {
	writerSessionId?: string;
	mission: Mission;
	disposition: Disposition;
	reason: string;
	evidence?: string;
	discardUncommitted?: boolean;
	repositoryRoot?: string;
}

export type CloseOutcome = { ok: true; mission: Mission } | { ok: false; attention: string; mission: Mission };

export interface LifecyclePorts {
	sessions?: { release?(agent: Agent): Promise<void> };
	modelCatalog?(
		workspaceId: WorkspaceId,
	): Promise<{ provider: string; id: string; name: string; variants?: string[] }[]>;
	missions: { save(mission: Mission): Promise<void> };
	worktrees: { close(input: CloseMissionInput): Promise<CloseOutcome> };
}

export interface LifecycleToolContext extends ToolContext {
	deps: ToolDeps & LifecyclePorts;
}

function refused(message: string): ToolResult {
	return { ok: false, code: "refused", message };
}

function notFound(message: string): ToolResult {
	return { ok: false, code: "notFound", message };
}

// A lead works its own mission; the leader works any mission in the workspace.
async function scopedMission(
	ctx: LifecycleToolContext,
	missionId: MissionRef | undefined,
): Promise<{ ok: true; mission: Mission } | { ok: false; result: ToolResult }> {
	const mission = resolveMission(ctx, missionId);
	if (mission === undefined || mission.workspaceId !== ctx.actor.workspaceId) {
		return { ok: false, result: notFound(`no such mission: ${missionId}`) };
	}
	if (ctx.actor.kind === "lead" && mission.id !== ctx.actor.missionId) {
		return { ok: false, result: { ok: false, code: "notAuthorised", message: "a lead works its own mission only" } };
	}
	if (ctx.actor.kind !== "lead" && ctx.actor.kind !== "leader") {
		return { ok: false, result: { ok: false, code: "notAuthorised", message: "only a lead or the leader" } };
	}
	return { ok: true, mission };
}

async function closeMission(ctx: LifecycleToolContext, params: CloseParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "leader") {
		return { ok: false, code: "notAuthorised", message: "only the leader closes missions" };
	}
	const mission = resolveMission(ctx, params.missionId);
	if (mission === undefined || mission.workspaceId !== ctx.actor.workspaceId) {
		return notFound(`no such mission: ${params.missionId}`);
	}
	if (mission.state === "closed") {
		return mission.disposition === params.disposition
			? { ok: true, data: { missionId: mission.number, disposition: mission.disposition, alreadyClosed: true } }
			: refused("the mission is already closed with a different disposition");
	}
	if (params.disposition === "merged" && params.evidence === undefined) {
		return refused("merged needs evidence");
	}
	if (ctx.deps.store.listAgents(mission.id).some((agent) => ["queued", "starting", "running"].includes(agent.state))) {
		return refused("Agents are still active in this mission. Review their automatic reports before closing it.");
	}
	const outcome = await ctx.deps.worktrees.close({
		mission,
		disposition: params.disposition,
		reason: params.reason,
		evidence: params.evidence,
		...(params.discardUncommitted === true ? { discardUncommitted: true as const } : {}),
	});
	await ctx.deps.missions.save(outcome.mission);
	if (!outcome.ok) {
		return refused(outcome.attention);
	}
	return { ok: true, data: { missionId: outcome.mission.number, disposition: params.disposition } };
}

async function missionStatus(ctx: LifecycleToolContext, params: StatusParams): Promise<ToolResult> {
	const open = ctx.deps.store
		.listMissions(ctx.actor.workspaceId)
		.filter((mission) => mission.state !== "closed")
		.map((mission) => ({ ...mission, state: deriveMissionState(mission) }));
	const ordered = open.sort((a, b) => b.number - a.number);
	const leader = ctx.deps.store.getLeader(ctx.actor.workspaceId);
	const common = {
		self: {
			role: ctx.actor.kind,
			actorId: ctx.actor.kind === "leader" ? ctx.actor.sessionId : ctx.actor.agentId,
			name: ctx.actor.kind === "leader" ? leader?.name : ctx.deps.store.getAgent(ctx.actor.agentId)?.name,
		},
	};
	const limit = params.limit ?? 10;
	const selectedMission = params.missionId ?? (ctx.actor.kind === "lead" ? ctx.actor.missionId : undefined);
	if (selectedMission !== undefined) {
		const scoped = await scopedMission(ctx, selectedMission);
		if (!scoped.ok) return scoped.result;
		const mission = scoped.mission;
		if (params.section === "attention") {
			try {
				return {
					ok: true,
					data: {
						...common,
						mission: { number: mission.number, name: mission.name },
						section: "attention",
						...scopedTextPage(mission.attention ?? "", `mission:${mission.id}:attention`, params.cursor),
					},
				};
			} catch {
				return refused("invalid attention cursor");
			}
		}
		const agents = ctx.deps.store.listAgents(mission.id).sort((a, b) => a.id.localeCompare(b.id));
		const start = params.cursor === undefined ? 0 : agents.findIndex((agent) => agent.id === params.cursor) + 1;
		if (params.cursor !== undefined && start === 0) return refused("unknown agent cursor");
		const rows = agents.map((agent) => ({
			agentId: agent.id,
			mission: mission.number,
			role: agent.canSpawn ? "lead" : "agent",
			isSelf: ctx.actor.kind !== "leader" && ctx.actor.agentId === agent.id,
			name: agent.name,
			state: agent.state,
			model: agent.model,
			requestedModel: agent.requestedModel,
			variant: agent.variant,
			...(agent.routing
				? {
						routing: {
							effort: agent.routing.effort,
							method: agent.routing.method,
							selectedModel: agent.routing.selectedModel,
							reason: utf8Excerpt(agent.routing.reason ?? "", 400).text,
							warnings: agent.routing.warnings?.map((warning) => utf8Excerpt(warning, 200).text),
						},
					}
				: {}),
		}));
		const envelope = (page: typeof rows, hasMore: boolean) => ({
			...common,
			mission: {
				number: mission.number,
				name: mission.name,
				state: mission.state,
				attention: utf8Excerpt(mission.attention ?? "", 400).text,
				attentionTruncated: Buffer.byteLength(mission.attention ?? "") > 400,
			},
			agentDetails: page,
			hasMore,
			...(hasMore ? { nextCursor: agents[start + page.length - 1]?.id } : {}),
		});
		const page = fitPage(rows, start, limit, DEFAULT_READ_BYTES, envelope);
		return { ok: true, data: envelope(page, start + page.length < rows.length) };
	}
	const start =
		params.cursor === undefined ? 0 : ordered.findIndex((mission) => String(mission.number) === params.cursor) + 1;
	if (params.cursor !== undefined && start === 0) return refused("unknown mission cursor");
	const rows = ordered.map((mission) => ({
		number: mission.number,
		missionId: mission.number,
		name: mission.name,
		state: mission.state,
		executingAgents: ctx.deps.store
			.listAgents(mission.id)
			.filter((agent) => ["running", "starting"].includes(agent.state)).length,
		queuedAgents: ctx.deps.store.listAgents(mission.id).filter((agent) => agent.state === "queued").length,
		agents: ctx.deps.store.listAgents(mission.id).length,
	}));
	const envelope = (page: typeof rows, hasMore: boolean) => ({
		...common,
		counts: { open: ordered.length },
		missions: page,
		hasMore,
		...(hasMore ? { nextCursor: String(rows[start + page.length - 1]?.number) } : {}),
	});
	const page = fitPage(rows, start, limit, DEFAULT_READ_BYTES, envelope);
	return { ok: true, data: envelope(page, start + page.length < rows.length) };
}

async function modelsPage(ctx: LifecycleToolContext, params: ModelsParams): Promise<ToolResult> {
	if (!ctx.deps.modelCatalog) return { ok: false, code: "unavailable", message: "model catalog is unavailable" };
	const query = params.query?.toLowerCase();
	const models = (await ctx.deps.modelCatalog(ctx.actor.workspaceId))
		.filter((model) => !query || `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query))
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	const key = (model: (typeof models)[number]) => `${model.provider}/${model.id}`;
	const cursorKey = (model: (typeof models)[number]) => JSON.stringify([query ?? "", key(model)]);
	const start = params.cursor === undefined ? 0 : models.findIndex((model) => cursorKey(model) === params.cursor) + 1;
	if (params.cursor !== undefined && start === 0) return refused("unknown model cursor");
	const envelope = (page: typeof models, hasMore: boolean) => ({
		models: page,
		total: models.length,
		hasMore,
		...(hasMore && models[start + page.length - 1] ? { nextCursor: cursorKey(models[start + page.length - 1]) } : {}),
	});
	const page = fitPage(models, start, params.limit ?? 10, DEFAULT_READ_BYTES, envelope);
	return { ok: true, data: envelope(page, start + page.length < models.length) };
}

async function setupDiagnostic(ctx: LifecycleToolContext, params: SetupDiagnosticParams): Promise<ToolResult> {
	const diagnostic = await readSetupDiagnostic(netaDir(), ctx.actor.workspaceId, params.number);
	if (!diagnostic) return notFound(`no setup diagnostic for mission #${params.number}`);
	try {
		const stream = params.stream ?? "stderr";
		const page = scopedTextPage(
			diagnostic[stream],
			`setup:${ctx.actor.workspaceId}:${params.number}:${stream}`,
			params.cursor,
		);
		return {
			ok: true,
			data: {
				number: diagnostic.number,
				stream,
				exitCode: diagnostic.exitCode,
				partialWorktree: diagnostic.partialWorktree?.path,
				sourceTruncated: diagnostic[stream].includes("[output truncated]"),
				storedTruncated: diagnostic[stream].includes("[output truncated before storage]"),
				...page,
			},
		};
	} catch {
		return refused("invalid diagnostic cursor");
	}
}

export const lifecycleHandlers: Pick<ToolHandlers, "close" | "mission_state" | "list_models" | "setup_diagnostic"> = {
	close: (ctx, args) => closeMission(ctx as LifecycleToolContext, args),
	mission_state: (ctx, args) => missionStatus(ctx as LifecycleToolContext, args),
	list_models: (ctx, args) => modelsPage(ctx as LifecycleToolContext, args),
	setup_diagnostic: (ctx, args) => setupDiagnostic(ctx as LifecycleToolContext, args),
};
