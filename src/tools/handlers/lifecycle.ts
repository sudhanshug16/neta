// `neta_scope`, `neta_ready`, `neta_close`, `neta_pin`, `neta_status`,
// `neta_mode`: the six mission lifecycle and mode tools. Closeout belongs to
// 06 and Lead++ to 07; both are ports the Node wires in T5.9, and the input
// and outcome shapes below mirror their plan contracts.
import { deriveMissionState, needsPerson } from "../../core/state.ts";
import { nowIso } from "../../core/time.ts";
import type {
	Agent,
	DecisionRecord,
	Disposition,
	LeaderMode,
	Mission,
	MissionId,
	WorkspaceId,
} from "../../core/types.ts";
import { resolveMission } from "../mission-reference.ts";
import type { ToolContext, ToolDeps, ToolHandlers, ToolResult } from "../router.ts";
import type {
	CloseParams,
	HistoryParams,
	MissionRef,
	ModeParams,
	PinParams,
	ReadyParams,
	ScopeParams,
	StatusParams,
} from "../schemas.ts";

export interface CloseMissionInput {
	mission: Mission;
	disposition: Disposition;
	reason: string;
	evidence?: string;
	repositoryRoot?: string;
}

export type CloseOutcome = { ok: true; mission: Mission } | { ok: false; attention: string; mission: Mission };

export type ModeSubject =
	| { kind: "leader"; workspaceId: WorkspaceId }
	| { kind: "lead"; workspaceId: WorkspaceId; missionId: MissionId; agentId: string };

// The five denial reasons are 07's grant rule: a denial is data, not an
// error. `unavailable` is the sixth and different in kind — the Node cannot
// answer the request at all — so it leaves this tool as an error instead.
export type ModeApproval =
	| { approved: true }
	| {
			approved: false;
			reason:
				| "incompleteRecord"
				| "missionMissing"
				| "missionClosed"
				| "notAuthorised"
				| "reservedByCharter"
				| "unavailable";
			detail: string;
	  };

export interface LifecyclePorts {
	sessions?: { release?(agent: Agent): Promise<void> };
	modelCatalog?(workspaceId: WorkspaceId): Promise<{ provider: string; id: string; name: string }[]>;
	missions: { save(mission: Mission): Promise<void> };
	worktrees: { close(input: CloseMissionInput): Promise<CloseOutcome> };
	modes: {
		requestMode(input: { subject: ModeSubject; mode: LeaderMode; record?: DecisionRecord }): Promise<ModeApproval>;
		// The caller's own mode. A mission lead's lives on its own record
		// (07), never on the workspace leader's, so `neta_status` asks for
		// the subject that called it. Unset (a Node with no mode service)
		// falls back to the leader record.
		snapshot?(subject: ModeSubject): Promise<{ mode: LeaderMode; modeActiveMs: number }>;
	};
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

async function recordScope(ctx: LifecycleToolContext, params: ScopeParams): Promise<ToolResult> {
	const scoped = await scopedMission(ctx, params.missionId);
	if (!scoped.ok) {
		return scoped.result;
	}
	if (scoped.mission.state === "closed") {
		return refused("the mission is closed");
	}
	// Append-only: the objective is never touched.
	const updated: Mission = {
		...scoped.mission,
		changes: [...scoped.mission.changes, { at: nowIso(), text: params.text }],
	};
	await ctx.deps.missions.save(updated);
	await ctx.deps.store.appendEvent({
		workspaceId: updated.workspaceId,
		kind: "mission.changed",
		missionId: updated.id,
		data: {},
	});
	return { ok: true, data: { missionId: updated.number } };
}

async function markReady(ctx: LifecycleToolContext, params: ReadyParams): Promise<ToolResult> {
	const scoped = await scopedMission(ctx, params.missionId);
	if (!scoped.ok) {
		return scoped.result;
	}
	if (scoped.mission.state === "closed") {
		return refused("the mission is closed");
	}
	const active = ctx.deps.store
		.listAgents(scoped.mission.id)
		.some(
			(agent) =>
				["queued", "starting", "running"].includes(agent.state) &&
				!(ctx.actor.kind === "lead" && agent.id === ctx.actor.agentId),
		);
	if (active)
		return refused(
			"Agents are still active in this mission. Wait for their automatic reports before marking it ready.",
		);
	const updated: Mission = { ...scoped.mission, state: "readyToClose", attention: params.summary };
	await ctx.deps.missions.save(updated);
	await ctx.deps.store.appendEvent({
		workspaceId: updated.workspaceId,
		kind: "mission.readyToClose",
		missionId: updated.id,
		data: {},
	});
	if (updated.lead.kind === "agent") {
		const agent = ctx.deps.store.getAgent(updated.lead.agentId);
		if (agent && !["completed", "archived"].includes(agent.state)) {
			const finished: Agent = {
				...agent,
				pendingQuestion: undefined,
				state: "completed",
				outcome: params.summary,
				endedAt: nowIso(),
			};
			await ctx.deps.store.putAgent(finished);
			await ctx.deps.store.appendEvent({
				workspaceId: updated.workspaceId,
				kind: "agent.finished",
				missionId: updated.id,
				agentId: agent.id,
				sessionId: agent.sessionId,
				data: {},
			});
			await ctx.deps.sessions?.release?.(finished);
		}
	}
	return { ok: true, data: { missionId: updated.number, state: updated.state } };
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
	if (
		params.disposition !== "abandoned" &&
		ctx.deps.store.listAgents(mission.id).some((agent) => ["queued", "starting", "running"].includes(agent.state))
	) {
		return refused("Agents are still active in this mission. Review their automatic reports before closing it.");
	}
	const outcome = await ctx.deps.worktrees.close({
		mission,
		disposition: params.disposition,
		reason: params.reason,
		evidence: params.evidence,
	});
	await ctx.deps.missions.save(outcome.mission);
	if (!outcome.ok) {
		return refused(outcome.attention);
	}
	return { ok: true, data: { missionId: outcome.mission.number, disposition: params.disposition } };
}

async function pinTurn(ctx: LifecycleToolContext, params: PinParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "leader") {
		return { ok: false, code: "notAuthorised", message: "only the leader pins turns" };
	}
	await ctx.deps.store.appendEvent({
		workspaceId: ctx.actor.workspaceId,
		kind: "user.pinned",
		turnId: params.turnId,
		data: { text: params.text },
	});
	return { ok: true, data: { turnId: params.turnId, pinned: true } };
}

// The subject a leadership tool acts for: the workspace leader, or the
// mission lead that called it.
function subjectOf(actor: LifecycleToolContext["actor"]): ModeSubject | undefined {
	if (actor.kind === "leader") {
		return { kind: "leader", workspaceId: actor.workspaceId };
	}
	if (actor.kind === "lead") {
		return { kind: "lead", workspaceId: actor.workspaceId, missionId: actor.missionId, agentId: actor.agentId };
	}
	return undefined;
}

async function missionStatus(ctx: LifecycleToolContext, _params: StatusParams): Promise<ToolResult> {
	const subject = subjectOf(ctx.actor);
	if (subject === undefined) {
		return { ok: false, code: "notAuthorised", message: "only a lead or the leader reads status" };
	}
	const open = ctx.deps.store
		.listMissions(ctx.actor.workspaceId)
		.filter((mission) => mission.state !== "closed")
		.map((mission) => ({ ...mission, state: deriveMissionState(mission, ctx.deps.store.listAgents(mission.id)) }));
	const needsYou = open.filter((mission) => needsPerson(mission)).sort((a, b) => b.number - a.number);
	const running = open.filter((mission) => !needsPerson(mission)).sort((a, b) => b.number - a.number);
	const leader = ctx.deps.store.getLeader(ctx.actor.workspaceId);
	const snapshot = await ctx.deps.modes.snapshot?.(subject);
	return {
		ok: true,
		data: {
			self: {
				role: ctx.actor.kind,
				actorId: ctx.actor.kind === "leader" ? ctx.actor.sessionId : ctx.actor.agentId,
				name: ctx.actor.kind === "leader" ? leader?.name : ctx.deps.store.getAgent(ctx.actor.agentId)?.name,
			},
			...(ctx.deps.modelCatalog ? { modelCatalog: await ctx.deps.modelCatalog(ctx.actor.workspaceId) } : {}),
			missions: [...needsYou, ...running].map((mission) => ({
				number: mission.number,
				missionId: mission.number,
				name: mission.name,
				state: mission.state,
				executingAgents: ctx.deps.store
					.listAgents(mission.id)
					.filter((agent) => ["running", "starting"].includes(agent.state)).length,
				queuedAgents: ctx.deps.store.listAgents(mission.id).filter((agent) => agent.state === "queued").length,
				...(mission.attention === undefined ? {} : { attention: mission.attention }),
				agents: ctx.deps.store.listAgents(mission.id).length,
			})),
			agentDetails: open.flatMap((mission) =>
				ctx.deps.store.listAgents(mission.id).map((agent) => ({
					agentId: agent.id,
					role: agent.canSpawn ? "lead" : "agent",
					isSelf: ctx.actor.kind !== "leader" && ctx.actor.agentId === agent.id,
					name: agent.name,
					mission: mission.number,
					state: agent.state,
					model: agent.model,
					requestedModel: agent.requestedModel,
					...(agent.routing
						? {
								routing: {
									effort: agent.routing.effort,
									method: agent.routing.method,
									selectedModel: agent.routing.selectedModel,
									reason: agent.routing.reason,
									warnings: agent.routing.warnings,
								},
							}
						: {}),
				})),
			),
			mode: snapshot?.mode ?? leader?.mode ?? "lead",
			modeActiveMs: snapshot?.modeActiveMs ?? leader?.modeActiveMs ?? 0,
		},
	};
}

async function switchMode(ctx: LifecycleToolContext, params: ModeParams): Promise<ToolResult> {
	const subject = subjectOf(ctx.actor);
	if (subject === undefined) {
		return { ok: false, code: "notAuthorised", message: "only a lead or the leader switches mode" };
	}
	let record: DecisionRecord | undefined;
	if (params.record) {
		const scoped = await scopedMission(ctx, params.record.missionId);
		if (!scoped.ok) return scoped.result;
		record = { ...params.record, missionId: scoped.mission.id };
	}
	const approval = await ctx.deps.modes.requestMode({ subject, mode: params.mode, record });
	if (!approval.approved && approval.reason === "unavailable") {
		return { ok: false, code: "unavailable", message: approval.detail };
	}
	return { ok: true, data: { ...approval } };
}

async function conversationHistory(ctx: LifecycleToolContext, params: HistoryParams): Promise<ToolResult> {
	if (ctx.deps.history === undefined) return { ok: false, code: "unavailable", message: "history is unavailable" };
	return {
		ok: true,
		data: await ctx.deps.history(ctx.actor.sessionId, { cursor: params.cursor, limit: params.limit ?? 20 }),
	};
}

export const lifecycleHandlers: Pick<
	ToolHandlers,
	"neta_scope" | "neta_ready" | "neta_close" | "neta_pin" | "neta_status" | "neta_history" | "neta_mode"
> = {
	neta_scope: (ctx, args) => recordScope(ctx as LifecycleToolContext, args),
	neta_ready: (ctx, args) => markReady(ctx as LifecycleToolContext, args),
	neta_close: (ctx, args) => closeMission(ctx as LifecycleToolContext, args),
	neta_pin: (ctx, args) => pinTurn(ctx as LifecycleToolContext, args),
	neta_status: (ctx, args) => missionStatus(ctx as LifecycleToolContext, args),
	neta_history: (ctx, args) => conversationHistory(ctx as LifecycleToolContext, args),
	neta_mode: (ctx, args) => switchMode(ctx as LifecycleToolContext, args),
};
