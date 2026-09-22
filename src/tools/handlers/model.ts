import type { Agent } from "../../core/types.ts";
import { resolveMission } from "../mission-reference.ts";
import type { ToolContext, ToolDeps, ToolHandlers, ToolResult } from "../router.ts";
import type { ModelParams } from "../schemas.ts";

export interface ModelPorts {
	models: {
		adjust(agentId: string, params: Pick<ModelParams, "effort" | "change">): Promise<Record<string, unknown>>;
	};
}
export interface ModelToolContext extends ToolContext {
	deps: ToolDeps & ModelPorts;
}

async function adjust(ctx: ModelToolContext, params: ModelParams): Promise<ToolResult> {
	if (ctx.actor.kind === "agent") {
		const own = ctx.deps.store.getAgent(ctx.actor.agentId);
		if (
			!own ||
			own.workspaceId !== ctx.actor.workspaceId ||
			own.missionId !== ctx.actor.missionId ||
			own.sessionId !== ctx.actor.sessionId ||
			params.missionId !== undefined ||
			(params.agentId !== undefined &&
				params.agentId !== own.id &&
				params.agentId.toLowerCase() !== own.name.toLowerCase())
		)
			return {
				ok: false,
				code: "notAuthorised",
				message: "An ordinary agent can adjust only itself. Omit missionId and agentId.",
			};
		return { ok: true, data: await ctx.deps.models.adjust(own.id, params) };
	}
	const mission =
		params.missionId !== undefined || params.agentId === undefined
			? resolveMission(ctx, params.missionId)
			: undefined;
	if (params.missionId !== undefined && !mission)
		return { ok: false, code: "notFound", message: "No such mission in this workspace." };
	let agent: Agent | undefined;
	if (params.agentId !== undefined) {
		const scoped = ctx.deps.store
			.listMissions(ctx.actor.workspaceId)
			.filter((m) => m.state !== "closed")
			.flatMap((m) => ctx.deps.store.listAgents(m.id))
			.filter(
				(a) =>
					a.workspaceId === ctx.actor.workspaceId &&
					a.state !== "archived" &&
					(ctx.actor.kind !== "lead" || a.missionId === ctx.actor.missionId),
			);
		agent = scoped.find((a) => a.id === params.agentId);
		if (!agent) {
			const matches = scoped.filter(
				(a) => a.name.toLowerCase() === params.agentId?.toLowerCase() && (!mission || a.missionId === mission.id),
			);
			if (matches.length > 1)
				return {
					ok: false,
					code: "badParams",
					message: "Agent name is ambiguous. Use the exact agentId from neta_status.",
				};
			agent = matches[0];
		}
	} else if (mission?.lead.kind === "agent") agent = ctx.deps.store.getAgent(mission.lead.agentId);
	else if (mission?.lead.kind === "leader")
		return {
			ok: false,
			code: "refused",
			message:
				"This mission uses the workspace leader's shared conversation. Use /models there; there is no separate mission-lead session to adjust.",
		};
	if (!agent || agent.workspaceId !== ctx.actor.workspaceId || (mission && agent.missionId !== mission.id))
		return {
			ok: false,
			code: "notFound",
			message: "Choose an existing mission number or agent ID/name from neta_status.",
		};
	if (ctx.actor.kind === "lead" && agent.missionId !== ctx.actor.missionId)
		return { ok: false, code: "notAuthorised", message: "a mission lead adjusts its own mission only" };
	return { ok: true, data: await ctx.deps.models.adjust(agent.id, params) };
}

export const modelHandlers: Pick<ToolHandlers, "neta_model"> = {
	neta_model: (ctx, args) => adjust(ctx as ModelToolContext, args),
};
