import type { Event } from "../core/types.ts";
import { routingAuthStatus, saveRoutingKey } from "../routing/auth.ts";
import {
	loadModelPreferences,
	modelPreference,
	parseModelPreferences,
	saveModelPreferences,
} from "../routing/preferences.ts";
import { netaDir } from "../store/paths.ts";
import { asString, parseParams } from "./handlers-registry.ts";
import { NodeError } from "./protocol.ts";
import type { NodeHandlers } from "./server.ts";

// Credentials are an operator setting, never an agent tool or a state notification.
export const routingHandlers: NodeHandlers = {
	"routing.logs": async (ctx, params, conn) => {
		if (conn.client === "tools") throw new NodeError("UNAUTHORIZED", "View routing through the Neta UI.");
		const { workspaceId } = parseParams({ workspaceId: asString }, params);
		const changes: Event[] = [];
		let cursor: string | undefined = "0";
		do {
			const page = await ctx.store.listEvents({ workspaceId, cursor, limit: 2000 });
			changes.push(
				...page.events.filter((event) => event.kind === "agent.modelChanged" || event.kind === "routing.failed"),
			);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return {
			changes,
			agents: ctx.store
				.listAgents()
				.filter((agent) => agent.workspaceId === workspaceId && agent.routing)
				.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
				.map(
					({ id, name, missionId, workspaceId, sessionId, provider, model, state, requestedModel, routing }) => ({
						id,
						name,
						missionId,
						workspaceId,
						sessionId,
						provider,
						model,
						state,
						requestedModel,
						routing,
					}),
				),
			missions: ctx.store.listMissions(workspaceId),
		};
	},
	"routing.preferences.list": async (ctx, params, conn) => {
		if (conn.client === "tools") throw new NodeError("UNAUTHORIZED", "Configure routing through the Neta UI.");
		const { workspaceId } = parseParams({ workspaceId: asString }, params);
		const leader = ctx.store.getLeader(workspaceId);
		if (!leader) throw new NodeError("NOT_FOUND", "Workspace leader is unavailable.");
		const preferences = loadModelPreferences(netaDir());
		const connected = await ctx.runtime.listModels({ sessionId: leader.sessionId });
		const ids = new Set([...connected.map((model) => model.id), ...Object.keys(preferences.models)]);
		return {
			models: [...ids].sort().map((id) => ({
				id,
				name: connected.find((model) => model.id === id)?.name ?? id,
				connected: connected.some((model) => model.id === id),
				preference: modelPreference(preferences, id),
			})),
		};
	},
	"routing.preferences.save": async (_ctx, params, conn) => {
		if (conn.client === "tools") throw new NodeError("UNAUTHORIZED", "Configure routing through the Neta UI.");
		const { models } = parseParams({ models: (value) => value }, params);
		const single = models === undefined ? parseParams({ model: asString, preference: asString }, params) : undefined;
		const changes = parseModelPreferences({
			version: 1,
			models: single ? { [single.model]: single.preference } : models,
		}).models;
		await saveModelPreferences(netaDir(), changes);
		return single ?? { models: changes };
	},
	"routing.auth.status": async (_ctx, _params, conn) => {
		if (conn.client === "tools") throw new NodeError("UNAUTHORIZED", "Configure routing through the Neta UI.");
		return routingAuthStatus(netaDir());
	},
	"routing.auth.save": async (_ctx, params, conn) => {
		if (conn.client === "tools") throw new NodeError("UNAUTHORIZED", "Configure routing through the Neta UI.");
		const { apiKey } = parseParams({ apiKey: asString }, params);
		await saveRoutingKey(netaDir(), apiKey);
		return { configured: true, source: "saved" };
	},
};
