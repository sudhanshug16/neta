import type { Agent } from "../core/types.ts";
import type { ModelSelection } from "../routing/router.ts";
import type { Effort, RouteTask } from "../routing/types.ts";
import type { ModelParams } from "../tools/schemas.ts";
import { NodeError } from "./protocol.ts";
import type { NodeStore } from "./server.ts";

export function createAgentModelChanger(options: {
	store: NodeStore;
	route(input: RouteTask & { workspaceId: string }): Promise<ModelSelection>;
	apply(agent: Agent, model: string): Promise<void>;
	publish(agent: Agent): void;
}) {
	const pending = new Map<string, Promise<void>>();
	return async (agentId: string, params: Pick<ModelParams, "effort" | "change">): Promise<Record<string, unknown>> => {
		const previous = pending.get(agentId);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		pending.set(agentId, gate);
		try {
			await previous;
			const agent = options.store.getAgent(agentId);
			if (!agent) throw new NodeError("NOT_FOUND", "No such agent.");
			const mission = options.store.getMission(agent.missionId);
			if (!mission || mission.state === "closed" || agent.state === "archived")
				throw new NodeError("INVALID_PARAMS", "Archived missions and agents cannot change models.");
			if (agent.provider !== "opencode")
				throw new NodeError(
					"INVALID_PARAMS",
					"Effort routing requires an OpenCode agent. No conversation was replaced.",
				);
			const before = agent.routing?.effort;
			if ((params.effort === undefined) === (params.change === undefined))
				throw new NodeError("INVALID_PARAMS", "Supply either effort (1–5) or change (up/down).");
			if (params.change !== undefined && params.change !== "up" && params.change !== "down")
				throw new NodeError("INVALID_PARAMS", "change must be up or down.");
			let effort = params.effort;
			if (effort === undefined) {
				if (before === undefined)
					throw new NodeError(
						"INVALID_PARAMS",
						"No task effort is recorded for this agent. Set effort 1–5 explicitly; do not guess an old level from its model name.",
					);
				effort = Math.max(1, Math.min(5, before + (params.change === "up" ? 1 : -1))) as Effort;
			}
			if (!Number.isInteger(effort) || effort < 1 || effort > 5)
				throw new NodeError("INVALID_PARAMS", "effort must be an integer from 1 to 5.");
			if (effort === before)
				return {
					agentId,
					name: agent.name,
					missionId: mission.number,
					sessionId: agent.sessionId,
					effort,
					model: agent.model,
					changed: false,
					message: `Already at task effort ${effort}/5; model and conversation are unchanged.`,
				};
			const direction = before === undefined ? params.change : effort > before ? ("up" as const) : ("down" as const);
			const selection = await options.route({
				workspaceId: agent.workspaceId,
				provider: agent.provider,
				task: agent.task,
				objective: mission.objective,
				effort,
				adjustment: { previousModel: agent.model, previousEffort: before, direction },
			});
			if (selection.provider !== agent.provider || !selection.routing || selection.routing.effort !== effort)
				throw new NodeError(
					"PROVIDER_ERROR",
					"Routing did not return a model for the requested effort. No model was changed.",
				);
			const current = options.store.getAgent(agentId);
			if (
				!current ||
				current.sessionId !== agent.sessionId ||
				current.bindingGeneration !== agent.bindingGeneration ||
				current.model !== agent.model ||
				current.routing?.effort !== before ||
				current.state === "archived" ||
				options.store.getMission(agent.missionId)?.state === "closed"
			)
				throw new NodeError(
					"BUSY",
					"The agent changed during routing. Retry against its current state; no model was changed.",
				);
			// Queued workers have no live session yet. Their next launch uses this saved decision.
			if (current.state !== "queued" && current.model !== selection.model)
				await options.apply(current, selection.model);
			const latest = options.store.getAgent(agentId);
			if (!latest || latest.sessionId !== agent.sessionId)
				throw new NodeError(
					"BUSY",
					"The conversation changed while applying the model. Inspect neta_status before retrying.",
				);
			const updated: Agent = {
				...latest,
				model: selection.model,
				requestedModel: selection.model,
				routing: selection.routing,
			};
			await options.store.putAgent(updated);
			options.publish(updated);
			await options.store.appendEvent({
				workspaceId: agent.workspaceId,
				missionId: agent.missionId,
				agentId,
				sessionId: agent.sessionId,
				kind: "agent.modelChanged",
				data: {
					previousModel: agent.model,
					model: selection.model,
					previousEffort: before ?? null,
					effort,
					method: selection.routing.method,
					reason: selection.routing.reason,
					warnings: selection.routing.warnings.join("\n"),
				},
			});
			return {
				agentId,
				name: agent.name,
				missionId: mission.number,
				sessionId: agent.sessionId,
				previousModel: agent.model,
				model: selection.model,
				previousEffort: before,
				effort,
				changed: agent.model !== selection.model,
				routing: selection.routing,
				applies: current.state === "queued" ? "on launch" : "next model call",
				message:
					agent.model === selection.model
						? "Task effort updated; the router selected the same model. Conversation unchanged."
						: "Model updated in the same conversation. An in-flight response is not restarted.",
			};
		} finally {
			release();
			if (pending.get(agentId) === gate) pending.delete(agentId);
		}
	};
}
