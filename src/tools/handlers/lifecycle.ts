// `neta_scope`, `neta_ready`, `neta_close`, `neta_pin`, `neta_status`,
// `neta_mode`: the six mission lifecycle and mode tools. Closeout belongs to
// 06 and Lead++ to 07; both are ports the Node wires in T5.9, and the input
// and outcome shapes below mirror their plan contracts.
import { needsPerson } from "../../core/state.ts";
import { nowIso } from "../../core/time.ts";
import type { DecisionRecord, Disposition, LeaderMode, Mission, MissionId, WorkspaceId } from "../../core/types.ts";
import type { ToolContext, ToolDeps, ToolHandlers, ToolResult } from "../router.ts";
import type { CloseParams, ModeParams, PinParams, ReadyParams, ScopeParams, StatusParams } from "../schemas.ts";

export interface CloseMissionInput {
	mission: Mission;
	disposition: Disposition;
	reason: string;
	evidence?: string;
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
	missionId: MissionId,
): Promise<{ ok: true; mission: Mission } | { ok: false; result: ToolResult }> {
	const mission = ctx.deps.store.getMission(missionId);
	if (mission === undefined || mission.workspaceId !== ctx.actor.workspaceId) {
		return { ok: false, result: notFound(`no such mission: ${missionId}`) };
	}
	if (ctx.actor.kind === "lead" && missionId !== ctx.actor.missionId) {
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
	return { ok: true, data: { missionId: updated.id } };
}

async function markReady(ctx: LifecycleToolContext, params: ReadyParams): Promise<ToolResult> {
	const scoped = await scopedMission(ctx, params.missionId);
	if (!scoped.ok) {
		return scoped.result;
	}
	if (scoped.mission.state === "closed") {
		return refused("the mission is closed");
	}
	const updated: Mission = { ...scoped.mission, state: "readyToClose", attention: params.summary };
	await ctx.deps.missions.save(updated);
	await ctx.deps.store.appendEvent({
		workspaceId: updated.workspaceId,
		kind: "mission.readyToClose",
		missionId: updated.id,
		data: {},
	});
	return { ok: true, data: { missionId: updated.id, state: updated.state } };
}

async function closeMission(ctx: LifecycleToolContext, params: CloseParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "leader") {
		return { ok: false, code: "notAuthorised", message: "only the leader closes missions" };
	}
	const mission = ctx.deps.store.getMission(params.missionId);
	if (mission === undefined || mission.workspaceId !== ctx.actor.workspaceId) {
		return notFound(`no such mission: ${params.missionId}`);
	}
	if (mission.state === "closed") {
		return refused("the mission is already closed");
	}
	if (params.disposition === "merged" && params.evidence === undefined) {
		return refused("merged needs evidence");
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
	return { ok: true, data: { missionId: outcome.mission.id, disposition: params.disposition } };
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
	const open = ctx.deps.store.listMissions(ctx.actor.workspaceId).filter((mission) => mission.state !== "closed");
	const needsYou = open.filter((mission) => needsPerson(mission)).sort((a, b) => b.number - a.number);
	const running = open.filter((mission) => !needsPerson(mission)).sort((a, b) => b.number - a.number);
	const leader = ctx.deps.store.getLeader(ctx.actor.workspaceId);
	const snapshot = await ctx.deps.modes.snapshot?.(subject);
	return {
		ok: true,
		data: {
			missions: [...needsYou, ...running].map((mission) => ({
				number: mission.number,
				name: mission.name,
				state: mission.state,
				...(mission.attention === undefined ? {} : { attention: mission.attention }),
				agents: ctx.deps.store.listAgents(mission.id).length,
			})),
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
	const approval = await ctx.deps.modes.requestMode({ subject, mode: params.mode, record: params.record });
	if (!approval.approved && approval.reason === "unavailable") {
		return { ok: false, code: "unavailable", message: approval.detail };
	}
	return { ok: true, data: { ...approval } };
}

export const lifecycleHandlers: Pick<
	ToolHandlers,
	"neta_scope" | "neta_ready" | "neta_close" | "neta_pin" | "neta_status" | "neta_mode"
> = {
	neta_scope: (ctx, args) => recordScope(ctx as LifecycleToolContext, args),
	neta_ready: (ctx, args) => markReady(ctx as LifecycleToolContext, args),
	neta_close: (ctx, args) => closeMission(ctx as LifecycleToolContext, args),
	neta_pin: (ctx, args) => pinTurn(ctx as LifecycleToolContext, args),
	neta_status: (ctx, args) => missionStatus(ctx as LifecycleToolContext, args),
	neta_mode: (ctx, args) => switchMode(ctx as LifecycleToolContext, args),
};
