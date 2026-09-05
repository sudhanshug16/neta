// `neta_wait`, `neta_send`, `neta_progress`, `neta_ask`, `neta_done`: the
// waiting, steering and reporting tools. Session control and the wait
// subscription are ports the Node wires in T5.9; tests stub them against a
// fake agent.
import { nowIso } from "../../core/time.ts";
import type { Agent, AgentId, MissionId, SessionId } from "../../core/types.ts";
import type { ToolContext, ToolDeps, ToolHandlers, ToolResult } from "../router.ts";
import type { AskParams, DoneParams, ProgressParams, SendParams, WaitParams } from "../schemas.ts";

export interface CoordinationPorts {
	sessions: {
		release?(agent: Agent): Promise<void>;
		resume?(agent: Agent): Promise<Agent>;
		startQueued?(agent: Agent, text: string): Promise<Agent>;
		cancel(sessionId: SessionId): Promise<void>;
		prompt(sessionId: SessionId, text: string): Promise<void>;
		wait(input: {
			missionId: MissionId;
			agentIds?: AgentId[];
			timeoutMs: number;
		}): Promise<{ changed: Agent[]; timedOut: boolean }>;
	};
}

export interface CoordinationToolContext extends ToolContext {
	deps: ToolDeps & CoordinationPorts;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 600_000;

function refused(message: string): ToolResult {
	return { ok: false, code: "refused", message };
}

function notFound(message: string): ToolResult {
	return { ok: false, code: "notFound", message };
}

// The mission a wait, ask or done call scopes to: explicit, else the caller's.
function callerMission(ctx: CoordinationToolContext, missionId?: MissionId): MissionId | undefined {
	if (missionId !== undefined) {
		return missionId;
	}
	if (ctx.actor.kind === "lead") {
		return ctx.actor.missionId;
	}
	if (ctx.actor.kind === "leader") {
		return ctx.deps.store.getLeader(ctx.actor.workspaceId)?.activeMissionId;
	}
	return undefined;
}

async function waitForAgents(ctx: CoordinationToolContext, params: WaitParams): Promise<ToolResult> {
	const missionId = callerMission(ctx, params.missionId);
	if (missionId === undefined) {
		return refused("no mission: pass missionId or agentIds");
	}
	if (ctx.actor.kind === "lead" && missionId !== ctx.actor.missionId) {
		return { ok: false, code: "notAuthorised", message: "a lead waits on its own mission only" };
	}
	const mission = ctx.deps.store.getMission(missionId);
	if (mission === undefined || mission.workspaceId !== ctx.actor.workspaceId) {
		return notFound(`no such mission: ${missionId}`);
	}
	const known = new Set(ctx.deps.store.listAgents(mission.id).map((agent) => agent.id));
	const agentIds = params.agentIds?.filter((id) => known.has(id));
	const { changed, timedOut } = await ctx.deps.sessions.wait({
		missionId: mission.id,
		agentIds,
		timeoutMs: params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
	});
	// A wait never errors on timeout: it reports what changed, if anything.
	return { ok: true, data: { changed, timedOut } };
}

async function sendToAgent(ctx: CoordinationToolContext, params: SendParams): Promise<ToolResult> {
	const agent = ctx.deps.store.getAgent(params.agentId);
	if (agent === undefined || agent.workspaceId !== ctx.actor.workspaceId) {
		return notFound(`no such agent: ${params.agentId}`);
	}
	if (ctx.actor.kind === "lead" && agent.missionId !== ctx.actor.missionId) {
		return { ok: false, code: "notAuthorised", message: "a lead steers its own mission only" };
	}
	if (agent.state === "blocked") {
		// Answer: resolve the pending question, run again, deliver the text,
		// then announce the mission is unblocked.
		await ctx.deps.store.putAgent({ ...agent, pendingQuestion: undefined, state: "running" });
		await ctx.deps.sessions.prompt(agent.sessionId, params.text);
		await ctx.deps.store.appendEvent({
			workspaceId: agent.workspaceId,
			kind: "mission.unblocked",
			missionId: agent.missionId,
			agentId: agent.id,
			sessionId: agent.sessionId,
			data: {},
		});
		return { ok: true, data: { agentId: agent.id, delivered: "answered" } };
	}
	if (agent.state === "queued" && ctx.deps.sessions.startQueued !== undefined) {
		const started = await ctx.deps.sessions.startQueued(agent, params.text);
		return { ok: true, data: { agentId: started.id, delivered: "started" } };
	}
	if (agent.state === "starting" || agent.state === "running" || agent.state === "interrupted") {
		const live =
			agent.state === "interrupted" && ctx.deps.sessions.resume !== undefined
				? await ctx.deps.sessions.resume(agent)
				: agent;
		// Resteer: cancel the turn, wait for the cancellation boundary, then
		// prompt the same session.
		if (agent.state !== "interrupted") {
			await ctx.deps.sessions.cancel(live.sessionId);
		}
		await ctx.deps.sessions.prompt(live.sessionId, params.text);
		if (agent.state === "interrupted") {
			await ctx.deps.store.putAgent({ ...live, state: "running", stateBefore: undefined });
		}
		return { ok: true, data: { agentId: agent.id, delivered: "resteered" } };
	}
	return refused(`agent ${agent.id} is ${agent.state}`);
}

async function recordProgress(ctx: CoordinationToolContext, params: ProgressParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "lead" && ctx.actor.kind !== "agent") {
		return { ok: false, code: "notAuthorised", message: "only an agent or lead reports progress" };
	}
	const agent = ctx.deps.store.getAgent(ctx.actor.agentId);
	if (agent === undefined) {
		return notFound(`no such agent: ${ctx.actor.agentId}`);
	}
	await ctx.deps.store.putAgent({ ...agent, activity: { text: params.text, at: nowIso() } });
	return { ok: true, data: { agentId: agent.id } };
}

async function askUser(ctx: CoordinationToolContext, params: AskParams): Promise<ToolResult> {
	if (ctx.actor.kind === "leader") {
		const missionId = ctx.deps.store.getLeader(ctx.actor.workspaceId)?.activeMissionId;
		if (missionId === undefined) {
			return refused("no mission: the leader asks from an active mission");
		}
		await ctx.deps.store.appendEvent({
			workspaceId: ctx.actor.workspaceId,
			kind: "mission.blocked",
			missionId,
			data: { question: params.question },
		});
		return { ok: true, data: {} };
	}
	if (ctx.actor.kind !== "lead") {
		return { ok: false, code: "notAuthorised", message: "only a lead or the leader asks" };
	}
	const agent = ctx.deps.store.getAgent(ctx.actor.agentId);
	if (agent === undefined) {
		return notFound(`no such agent: ${ctx.actor.agentId}`);
	}
	await ctx.deps.store.putAgent({ ...agent, pendingQuestion: params.question, state: "blocked" });
	await ctx.deps.store.appendEvent({
		workspaceId: agent.workspaceId,
		kind: "mission.blocked",
		missionId: agent.missionId,
		agentId: agent.id,
		sessionId: agent.sessionId,
		data: { question: params.question },
	});
	return { ok: true, data: {} };
}

async function recordDone(ctx: CoordinationToolContext, params: DoneParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "lead" && ctx.actor.kind !== "agent") {
		return { ok: false, code: "notAuthorised", message: "only an agent or lead reports done" };
	}
	const agent = ctx.deps.store.getAgent(ctx.actor.agentId);
	if (agent === undefined) {
		return notFound(`no such agent: ${ctx.actor.agentId}`);
	}
	if (agent.state === "completed" || agent.state === "archived") {
		return refused(`agent ${agent.id} already finished`);
	}
	const finished = { ...agent, outcome: params.outcome, state: "completed" as const, endedAt: nowIso() };
	await ctx.deps.store.putAgent(finished);
	await ctx.deps.store.appendEvent({
		workspaceId: agent.workspaceId,
		kind: "agent.finished",
		missionId: agent.missionId,
		agentId: agent.id,
		sessionId: agent.sessionId,
		data: {},
	});
	await ctx.deps.sessions.release?.(finished);
	// A lead's mission stays open: closing is the leader's `neta_close`.
	return { ok: true, data: { agentId: agent.id, state: finished.state } };
}

export const coordinationHandlers: Pick<
	ToolHandlers,
	"neta_wait" | "neta_send" | "neta_progress" | "neta_ask" | "neta_done"
> = {
	neta_wait: (ctx, args) => waitForAgents(ctx as CoordinationToolContext, args),
	neta_send: (ctx, args) => sendToAgent(ctx as CoordinationToolContext, args),
	neta_progress: (ctx, args) => recordProgress(ctx as CoordinationToolContext, args),
	neta_ask: (ctx, args) => askUser(ctx as CoordinationToolContext, args),
	neta_done: (ctx, args) => recordDone(ctx as CoordinationToolContext, args),
};
