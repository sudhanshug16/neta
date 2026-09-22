// Steering and reporting tools. Parent wake-up is owned by the Node runtime.

import { createHash } from "node:crypto";
import { nowIso } from "../../core/time.ts";
import type { Agent, InboxMessage, Mission, SessionId } from "../../core/types.ts";
import { resolveMission } from "../mission-reference.ts";
import type { ToolContext, ToolDeps, ToolHandlers, ToolResult } from "../router.ts";
import type { AskParams, DoneParams, ProgressParams, SendParams } from "../schemas.ts";

export interface CoordinationPorts {
	missions?: { save(mission: Mission): Promise<void> };
	sessions: {
		send?(agent: Agent, text: string, sourceId: string): Promise<InboxMessage>;
		release?(agent: Agent): Promise<void>;
		resume?(agent: Agent): Promise<Agent>;
		startQueued?(agent: Agent, text: string): Promise<Agent>;
		cancel(sessionId: SessionId): Promise<void>;
		prompt(sessionId: SessionId, text: string): Promise<void>;
	};
}

export interface CoordinationToolContext extends ToolContext {
	deps: ToolDeps & CoordinationPorts;
}

function refused(message: string): ToolResult {
	return { ok: false, code: "refused", message };
}

function notFound(message: string): ToolResult {
	return { ok: false, code: "notFound", message };
}

async function sendToAgent(ctx: CoordinationToolContext, params: SendParams): Promise<ToolResult> {
	const agent = ctx.deps.store.getAgent(params.agentId);
	if (agent === undefined || agent.workspaceId !== ctx.actor.workspaceId) {
		return notFound(`no such agent: ${params.agentId}`);
	}
	if (agent.sessionId === ctx.actor.sessionId || (ctx.actor.kind !== "leader" && agent.id === ctx.actor.agentId)) {
		return refused(
			`You are ${agent.name} (${agent.id}). neta_send targets another agent; sending to yourself would create an unnecessary continuation. Continue your own task, or use neta_agent to create a separate worker and use its returned agentId. No message was saved.`,
		);
	}
	if (ctx.actor.kind === "lead" && agent.missionId !== ctx.actor.missionId) {
		return { ok: false, code: "notAuthorised", message: "a lead steers its own mission only" };
	}
	const mission = ctx.deps.store.getMission(agent.missionId);
	if (!mission || mission.state === "closed" || mission.closedAt || agent.state === "archived")
		return refused("The mission or agent is archived. Continue it explicitly before sending new work.");
	if (ctx.deps.sessions.send) {
		const sender =
			ctx.actor.kind === "leader"
				? ctx.deps.store.getLeader(ctx.actor.workspaceId)
				: ctx.deps.store.getAgent(ctx.actor.agentId);
		const sourceId = `followup:${createHash("sha256")
			.update(JSON.stringify([ctx.actor.sessionId, sender?.currentTurnId, agent.id, params.text]))
			.digest("hex")}`;
		const receipt = await ctx.deps.sessions.send(agent, params.text, sourceId);
		return {
			ok: true,
			data: {
				agentId: agent.id,
				sessionId: agent.sessionId,
				messageId: receipt.id,
				status: receipt.status,
				message: "Follow-up saved. Busy recipients receive it at the next turn boundary; no turn was interrupted.",
			},
		};
	}
	return { ok: false, code: "unavailable", message: "Durable follow-up inbox is unavailable; no message was sent." };
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
		const open = ctx.deps.store.listMissions(ctx.actor.workspaceId).filter((mission) => mission.state !== "closed");
		const mission =
			resolveMission(ctx, params.missionId) ??
			(params.missionId === undefined && open.length === 1 ? open[0] : undefined);
		if (!mission)
			return refused("Choose the numeric missionId from neta_status; no unambiguous mission for this question.");
		if (mission.state === "closed") return refused("The mission is closed.");
		if (mission.lead.kind === "agent") {
			const lead = ctx.deps.store.getAgent(mission.lead.agentId);
			if (!lead || lead.state === "archived") return notFound("The mission lead is unavailable.");
			await ctx.deps.store.putAgent({ ...lead, pendingQuestion: params.question, state: "blocked" });
		} else {
			if (!ctx.deps.missions)
				return { ok: false, code: "unavailable", message: "Cannot persist the pending question." };
			await ctx.deps.missions.save({ ...mission, state: "blocked", attention: params.question });
		}
		await ctx.deps.store.appendEvent({
			workspaceId: ctx.actor.workspaceId,
			kind: "mission.blocked",
			missionId: mission.id,
			data: { question: params.question },
		});
		return { ok: true, data: { missionId: mission.number } };
	}
	if (ctx.actor.kind !== "lead") {
		return { ok: false, code: "notAuthorised", message: "only a lead or the leader asks" };
	}
	if (params.missionId !== undefined && resolveMission(ctx, params.missionId)?.id !== ctx.actor.missionId)
		return { ok: false, code: "notAuthorised", message: "A lead asks about its own mission only." };
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
	const finished = {
		...agent,
		pendingQuestion: undefined,
		outcome: params.outcome,
		state: "completed" as const,
		endedAt: nowIso(),
	};
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

export const coordinationHandlers: Pick<ToolHandlers, "neta_send" | "neta_progress" | "neta_ask" | "neta_done"> = {
	neta_send: (ctx, args) => sendToAgent(ctx as CoordinationToolContext, args),
	neta_progress: (ctx, args) => recordProgress(ctx as CoordinationToolContext, args),
	neta_ask: (ctx, args) => askUser(ctx as CoordinationToolContext, args),
	neta_done: (ctx, args) => recordDone(ctx as CoordinationToolContext, args),
};
