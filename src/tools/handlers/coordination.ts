// Steering and reporting tools. Parent wake-up is owned by the Node runtime.

import { createHash } from "node:crypto";
import { isUlid, ulid } from "../../core/ids.ts";
import { nowIso } from "../../core/time.ts";
import type { Agent, InboxMessage, Mission, SessionId } from "../../core/types.ts";
import { openMeStore } from "../../me/store.ts";
import { resolveMission } from "../mission-reference.ts";
import type { ToolContext, ToolDeps, ToolHandlers, ToolResult } from "../router.ts";
import type { AskParams, DoneParams, ProgressParams, SendParams, SuperleaderAnswerParams } from "../schemas.ts";

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
	const inheritedChildQuestion =
		params.questionId &&
		ctx.actor.kind === "leader" &&
		agent.canSpawn &&
		mission.lead.kind === "agent" &&
		mission.lead.agentId === agent.id &&
		ctx.deps.store
			.listAgents(agent.missionId)
			.some((child) => !child.canSpawn && child.pendingQuestionId === params.questionId);
	if (
		params.questionId &&
		(!isUlid(params.questionId) || (agent.pendingQuestionId !== params.questionId && !inheritedChildQuestion))
	)
		return refused(
			"The target has no pending question with that exact ID. Check the parent chain before forwarding an answer.",
		);
	if (ctx.deps.sessions.send) {
		const sender =
			ctx.actor.kind === "leader"
				? ctx.deps.store.getLeader(ctx.actor.workspaceId)
				: ctx.deps.store.getAgent(ctx.actor.agentId);
		const sourceId = `followup:${createHash("sha256")
			.update(
				JSON.stringify([
					ctx.actor.sessionId,
					sender?.currentTurnId,
					agent.id,
					params.text,
					params.questionId ?? null,
				]),
			)
			.digest("hex")}`;
		const deliveredText = params.questionId
			? `[Answer to question ${params.questionId}]\nOriginal answer:\n${params.text}`
			: params.text;
		const receipt = await ctx.deps.sessions.send(agent, deliveredText, sourceId);
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
	if (
		params.resolvedQuestionId &&
		(!isUlid(params.resolvedQuestionId) || agent.pendingQuestionId !== params.resolvedQuestionId)
	)
		return refused("No pending question with that exact ID belongs to this actor.");
	await ctx.deps.store.putAgent({
		...agent,
		activity: { text: params.text, at: nowIso() },
		...(params.resolvedQuestionId
			? {
					pendingQuestion: undefined,
					pendingQuestionId: undefined,
					pendingQuestionAt: undefined,
					state: "running" as const,
				}
			: {}),
	});
	if (params.resolvedQuestionId && ctx.deps.missions) {
		const mission = ctx.deps.store.getMission(agent.missionId);
		if (mission?.lead.kind === "leader" && mission.state === "blocked" && mission.attention === agent.pendingQuestion)
			await ctx.deps.missions.save({ ...mission, state: "running", attention: undefined });
	}
	if (params.resolvedQuestionId)
		await ctx.deps.store.appendEvent({
			workspaceId: agent.workspaceId,
			kind: "mission.unblocked",
			missionId: agent.missionId,
			agentId: agent.id,
			sessionId: agent.sessionId,
			data: { questionId: params.resolvedQuestionId, resolution: params.text.slice(0, 1_200) },
		});
	return {
		ok: true,
		data: {
			agentId: agent.id,
			...(params.resolvedQuestionId ? { resolvedQuestionId: params.resolvedQuestionId } : {}),
		},
	};
}

async function askUser(ctx: CoordinationToolContext, params: AskParams): Promise<ToolResult> {
	if (params.questionId && !isUlid(params.questionId))
		return refused("questionId must be an exact pending question ID");
	if (ctx.actor.kind === "leader") {
		const open = ctx.deps.store.listMissions(ctx.actor.workspaceId).filter((mission) => mission.state !== "closed");
		const mission =
			resolveMission(ctx, params.missionId) ??
			(params.missionId === undefined && open.length === 1 ? open[0] : undefined);
		if (!mission)
			return refused("Choose the numeric missionId from neta_status; no unambiguous mission for this question.");
		if (mission.state === "closed") return refused("The mission is closed.");
		const inheritedLead = mission.lead.kind === "agent" ? ctx.deps.store.getAgent(mission.lead.agentId) : undefined;
		const inheritedWorker =
			mission.lead.kind === "leader"
				? ctx.deps.store
						.listAgents(mission.id)
						.find(
							(worker) =>
								!worker.canSpawn &&
								worker.pendingQuestionId === params.questionId &&
								worker.pendingQuestion === params.question,
						)
				: undefined;
		if (
			params.questionId &&
			(mission.lead.kind === "agent"
				? inheritedLead?.pendingQuestionId !== params.questionId ||
					inheritedLead.pendingQuestion !== params.question
				: !inheritedWorker)
		)
			return refused("The mission has no matching pending question to escalate.");
		if (
			!params.questionId &&
			(inheritedLead?.pendingQuestion === params.question ||
				(mission.lead.kind === "leader" &&
					ctx.deps.store.listAgents(mission.id).some((worker) => worker.pendingQuestion === params.question)))
		)
			return refused("Use the pending questionId instead of creating a duplicate question.");
		const questionId = params.questionId ?? ulid();
		if (mission.lead.kind === "agent") {
			const lead = inheritedLead;
			if (!lead || lead.state === "archived") return notFound("The mission lead is unavailable.");
			await ctx.deps.store.putAgent({
				...lead,
				pendingQuestion: params.question,
				pendingQuestionId: questionId,
				pendingQuestionAt: lead.pendingQuestionAt ?? nowIso(),
				state: "blocked",
			});
		} else {
			if (!ctx.deps.missions)
				return { ok: false, code: "unavailable", message: "Cannot persist the pending question." };
			await ctx.deps.missions.save({ ...mission, state: "blocked", attention: params.question });
		}
		await ctx.deps.store.appendEvent({
			workspaceId: ctx.actor.workspaceId,
			kind: "mission.blocked",
			missionId: mission.id,
			data: { questionId, question: params.question, userEscalation: true, needsReply: true },
		});
		return { ok: true, data: { missionId: mission.number, questionId } };
	}
	if (ctx.actor.kind !== "lead" && ctx.actor.kind !== "agent") {
		return { ok: false, code: "notAuthorised", message: "only an agent, lead, or leader asks" };
	}
	if (params.missionId !== undefined && resolveMission(ctx, params.missionId)?.id !== ctx.actor.missionId)
		return { ok: false, code: "notAuthorised", message: "A lead asks about its own mission only." };
	const agent = ctx.deps.store.getAgent(ctx.actor.agentId);
	if (agent === undefined) {
		return notFound(`no such agent: ${ctx.actor.agentId}`);
	}
	if (ctx.actor.kind === "agent" && params.questionId)
		return refused("A worker creates a question ID; only parents can forward an existing one.");
	if (
		ctx.actor.kind === "lead" &&
		params.questionId &&
		!ctx.deps.store
			.listAgents(agent.missionId)
			.some(
				(child) =>
					!child.canSpawn &&
					child.pendingQuestionId === params.questionId &&
					child.pendingQuestion === params.question,
			)
	)
		return refused("No worker in this mission has that exact pending question.");
	if (!params.questionId && agent.pendingQuestion === params.question && agent.pendingQuestionId)
		return refused("Reuse the existing pending questionId instead of creating a duplicate question.");
	const questionId = params.questionId ?? ulid();
	await ctx.deps.store.putAgent({
		...agent,
		pendingQuestion: params.question,
		pendingQuestionId: questionId,
		pendingQuestionAt: agent.pendingQuestionAt ?? nowIso(),
		state: "blocked",
	});
	await ctx.deps.store.appendEvent({
		workspaceId: agent.workspaceId,
		kind: "mission.blocked",
		missionId: agent.missionId,
		agentId: agent.id,
		sessionId: agent.sessionId,
		data: { questionId, question: params.question, userEscalation: false, needsReply: false },
	});
	return { ok: true, data: { questionId } };
}

async function answerSuperleader(ctx: CoordinationToolContext, params: SuperleaderAnswerParams): Promise<ToolResult> {
	if (ctx.actor.kind !== "leader")
		return { ok: false, code: "notAuthorised", message: "only the workspace leader answers Neta inquiries" };
	if (ctx.deps.store.getLeader(ctx.actor.workspaceId)?.sessionId !== ctx.actor.sessionId)
		return { ok: false, code: "notAuthorised", message: "workspace leader session is no longer current" };
	const store = openMeStore();
	const inquiry = await store.getInquiry(params.inquiryId);
	if (!inquiry || inquiry.workspaceId !== ctx.actor.workspaceId)
		return notFound("no pending Neta inquiry in this workspace");
	const answered = await store.answerInquiry(inquiry.id, params.answer);
	return { ok: true, data: { inquiryId: answered.id, status: answered.status } };
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

export const coordinationHandlers: Pick<
	ToolHandlers,
	"neta_send" | "neta_progress" | "neta_ask" | "neta_superleader_answer" | "neta_done"
> = {
	neta_send: (ctx, args) => sendToAgent(ctx as CoordinationToolContext, args),
	neta_progress: (ctx, args) => recordProgress(ctx as CoordinationToolContext, args),
	neta_ask: (ctx, args) => askUser(ctx as CoordinationToolContext, args),
	neta_superleader_answer: (ctx, args) => answerSuperleader(ctx as CoordinationToolContext, args),
	neta_done: (ctx, args) => recordDone(ctx as CoordinationToolContext, args),
};
