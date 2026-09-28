// Ordinary messages to subordinates. Parent replies are forwarded by the runtime.

import { createHash } from "node:crypto";

import type { Agent, InboxMessage, SessionId } from "../../core/types.ts";

import type { ToolContext, ToolDeps, ToolHandlers, ToolResult } from "../router.ts";
import type { SendParams } from "../schemas.ts";

export interface CoordinationPorts {
	sessions: {
		context?(sessionId: SessionId): Promise<{ turnId?: string; incoming: string[] }>;
		send?(agent: Agent, text: string, sourceId: string): Promise<InboxMessage>;
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
			`You are ${agent.name} (${agent.id}). send_message targets another agent; sending to yourself would create an unnecessary continuation. Continue your own task, or use spawn_agent to create a separate worker and use its returned agentId. No message was saved.`,
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
		const context = await ctx.deps.sessions.context?.(ctx.actor.sessionId);
		const sourceId = `followup:${createHash("sha256")
			.update(JSON.stringify([ctx.actor.sessionId, context?.turnId ?? sender?.currentTurnId, agent.id, params.text]))
			.digest("hex")}`;
		const deliveredText = [
			`Message from ${ctx.actor.kind === "leader" ? "the coordinator" : "your mission lead"}:`,
			params.text,
			...(context?.incoming.length
				? ["Incoming context (preserve the user's wording and constraints):", ...context.incoming]
				: []),
		].join("\n\n");
		const receipt = await ctx.deps.sessions.send(agent, deliveredText, sourceId);
		return {
			ok: true,
			data: {
				agentId: agent.id,
				sessionId: agent.sessionId,
				messageId: receipt.id,
				status: receipt.status,
				message:
					"Follow-up saved. A running recipient can receive it at the next model step; no turn was interrupted.",
			},
		};
	}
	return { ok: false, code: "unavailable", message: "Durable follow-up inbox is unavailable; no message was sent." };
}

export const coordinationHandlers: Pick<ToolHandlers, "send_message"> = {
	send_message: (ctx, args) => sendToAgent(ctx as CoordinationToolContext, args),
};
