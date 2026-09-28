import { createHash } from "node:crypto";
import { deriveMissionState } from "../core/state.ts";
import { inspectArtifact } from "../me/artifacts.ts";
import { openPersistedRuntimeSession } from "../me/runtime-session.ts";
import { type FilterIdentity, openMeStore, type WorkspaceLeaderIdentity } from "../me/store.ts";
import { loadSettings } from "../session/settings.ts";
import { paths } from "../store/paths.ts";
import { DEFAULT_READ_BYTES, DETAIL_READ_BYTES, fitPage, scopedTextPage, utf8Excerpt } from "../tools/paging.ts";
import type { SessionToolBridge } from "../tools/router.ts";
import { restoreNativeOwner } from "./handlers-conversation.ts";
import { NodeError } from "./protocol.ts";
import type { NodeContext, NodeHandlers } from "./server.ts";

const WORKSPACE_LEADER_MODEL = "openai/gpt-6-sol";
export const WORKSPACE_LEADER_EFFORT = "medium";
const workspaceLeaderOpenings = new Map<
	string,
	Promise<WorkspaceLeaderIdentity & { provider: string; model: string; variant?: string }>
>();
const workspaceLeaderWorkspaces = new Map<string, string>();
export function registerWorkspaceLeaderSession(sessionId: string, workspaceId: string): void {
	workspaceLeaderWorkspaces.set(sessionId, workspaceId);
}
export function unregisterWorkspaceLeaderSession(sessionId: string): void {
	workspaceLeaderWorkspaces.delete(sessionId);
}
export function workspaceForLeaderSession(sessionId: string): string | undefined {
	return workspaceLeaderWorkspaces.get(sessionId);
}

import { checkSchema } from "../tools/schemas.ts";

function params(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new NodeError("INVALID_PARAMS", "Neta params must be an object");
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new NodeError("INVALID_PARAMS", `${name} is required`);
	return value;
}

export async function openWorkspaceLeaderSession(ctx: NodeContext, workspaceHint?: string) {
	const store = openMeStore();
	if (!workspaceHint) throw new NodeError("INVALID_PARAMS", "workspaceId is required for the workspace leader");
	const workspace = ctx.store.getWorkspace(workspaceHint);
	const leader = ctx.store.getLeader(workspaceHint);
	const root = workspace?.roots.find((item) => item.machineId === ctx.store.machine().id)?.path;
	if (!workspace || !leader || !root)
		throw new NodeError(
			"NOT_FOUND",
			"Workspace leader needs an available coordinator and local workspace root to start",
		);
	const existing = await store.workspaceLeaderIdentity(workspaceHint);
	registerWorkspaceLeaderSession(existing.sessionId, workspaceHint);
	const opening = workspaceLeaderOpenings.get(existing.sessionId);
	if (opening) return opening;
	const pending = (async () => {
		const workspaceId = workspaceHint;
		const provider = existing.provider ?? leader.provider;
		const model = existing.model ?? (provider === "opencode" ? WORKSPACE_LEADER_MODEL : leader.model);
		let identity: WorkspaceLeaderIdentity = await store.bindWorkspaceLeaderRuntime({
			workspaceId,
			machineId: ctx.store.machine().id,
			provider,
			model,
		});
		try {
			const selected = await openPersistedRuntimeSession({
				runtime: ctx.runtime,
				request: {
					sessionId: identity.sessionId,
					workspaceId,
					cwd: root,
					provider,
					model,
					access: "readOnly",
					unsandboxed: false,
					netaTools: true,
				},
				initialized: existing.runtimeInitialized === true,
				markInitialized: () => store.markWorkspaceLeaderRuntimeInitialized(workspaceId),
			});
			identity = await store.workspaceLeaderIdentity(workspaceId);
			if (provider === "opencode") {
				if (!ctx.runtime.setNativeVariant || !ctx.runtime.runtimeDiagnostics)
					throw new NodeError(
						"PROVIDER_ERROR",
						"Workspace leader model effort cannot be verified by this runtime",
					);
				let diagnostics = await ctx.runtime.runtimeDiagnostics(identity.sessionId);
				if (diagnostics.model !== model) {
					await ctx.runtime.setModel(identity.sessionId, model);
					diagnostics = await ctx.runtime.runtimeDiagnostics(identity.sessionId);
				}
				if (diagnostics.variant !== WORKSPACE_LEADER_EFFORT) {
					await ctx.runtime.setNativeVariant(identity.sessionId, WORKSPACE_LEADER_EFFORT);
					diagnostics = await ctx.runtime.runtimeDiagnostics(identity.sessionId);
				}
				if (diagnostics.model !== model || diagnostics.variant !== WORKSPACE_LEADER_EFFORT)
					throw new NodeError(
						"PROVIDER_ERROR",
						"Workspace leader GPT-6 model or medium effort was not selected by the native runtime",
					);
			}
			return {
				...identity,
				provider: selected.provider,
				model: selected.model,
				...(provider === "opencode" ? { variant: WORKSPACE_LEADER_EFFORT } : {}),
			};
		} catch (error) {
			if (error instanceof NodeError) throw error;
			throw new NodeError(
				"PROVIDER_ERROR",
				error instanceof Error ? error.message : "Workspace leader native session is unavailable",
			);
		}
	})();
	workspaceLeaderOpenings.set(existing.sessionId, pending);
	try {
		return await pending;
	} finally {
		if (workspaceLeaderOpenings.get(existing.sessionId) === pending)
			workspaceLeaderOpenings.delete(existing.sessionId);
	}
}

// Shared by the classifier and native chat attachment. Opening a chat never prompts it.
export const filterSessionIds = new Set<string>();
const filterOpenings = new Map<string, Promise<FilterIdentity & { provider: string; model: string }>>();
export async function openFilterSession(ctx: NodeContext, workspaceId: string) {
	const store = openMeStore();
	const saved = await store.filterIdentity(workspaceId);
	filterSessionIds.add(saved.sessionId);
	const opening = filterOpenings.get(saved.sessionId);
	if (opening) return opening;
	const pending = (async () => {
		const workspace = ctx.store.getWorkspace(workspaceId);
		const root = workspace?.roots.find((item) => item.machineId === ctx.store.machine().id)?.path;
		if (!workspace || !root) throw new NodeError("NOT_FOUND", "Filter needs a local workspace root");
		const provider = "opencode";
		const model = saved.model ?? "openai/gpt-6-luna";
		const { settings } = loadSettings({ netaDir: paths().root });
		if (!settings.providers[provider] || settings.forbiddenModels.includes(model))
			throw new NodeError("PROVIDER_ERROR", "Filter model is unavailable in the configured OpenCode runtime");
		const identity = await store.bindFilterRuntime({
			workspaceId,
			machineId: ctx.store.machine().id,
			provider,
			model,
		});
		await openPersistedRuntimeSession({
			runtime: ctx.runtime,
			request: {
				sessionId: identity.sessionId,
				workspaceId,
				cwd: root,
				provider,
				model,
				access: "readOnly",
				unsandboxed: false,
				netaTools: true,
				forceRelaunch: saved.runtimeInitialized === true && saved.toolsEnabled !== true,
			},
			initialized: saved.runtimeInitialized === true,
			markInitialized: () => store.markFilterRuntimeInitialized(workspaceId),
		});
		await store.markFilterToolsEnabled(workspaceId);
		const diagnostics = await ctx.runtime.runtimeDiagnostics?.(identity.sessionId);
		if (diagnostics?.model !== undefined && diagnostics.model !== model)
			throw new NodeError("PROVIDER_ERROR", "Filter model selection could not be verified");
		return { ...identity, provider, model };
	})();
	filterOpenings.set(saved.sessionId, pending);
	try {
		return await pending;
	} finally {
		if (filterOpenings.get(saved.sessionId) === pending) filterOpenings.delete(saved.sessionId);
	}
}

/** The Filter can send only from a Coordinator decision turn admitted to this native chat. */
export function createFilterToolBridge(input: { actorId: string; context(): NodeContext }): SessionToolBridge {
	const tool: SessionToolBridge["tools"][number] = {
		name: "send_message",
		description: "Send one useful update from the completed Coordinator reply to the Workspace leader.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", minLength: 1, maxLength: 16000 } },
			required: ["text"],
			additionalProperties: false,
		},
	};
	return {
		actorId: input.actorId,
		tools: [tool],
		call: async (name, args) => {
			if (name !== tool.name) throw new NodeError("METHOD_NOT_FOUND", "Unknown Filter tool");
			const errors = checkSchema(tool.inputSchema, args, "params");
			if (errors) throw new NodeError("INVALID_PARAMS", String(errors));
			const ctx = input.context();
			const store = openMeStore();
			const identity = await store.filterBySession(input.actorId);
			if (!identity) throw new NodeError("UNAUTHORIZED", "Filter conversation is not bound to this workspace");
			const turnId = (await ctx.runtime.runtimeDiagnostics?.(input.actorId))?.turnId;
			if (!turnId) throw new NodeError("BUSY", "Sending requires an active Filter turn");
			const decisions = ((await ctx.runtime.listInbox?.(input.actorId)) ?? []).filter(
				(message) => message.turnId === turnId && message.sourceId?.startsWith("filter-decision:"),
			);
			if (decisions.length !== 1) throw new NodeError("UNAUTHORIZED", "This is not one Coordinator decision turn");
			const sourceId = decisions[0]?.sourceId?.slice("filter-decision:".length).split(":")[0];
			if (!sourceId) throw new NodeError("UNAUTHORIZED", "No Coordinator reply is active");
			const notice = await store.getNotice(sourceId);
			if (
				!notice ||
				notice.workspaceId !== identity.workspaceId ||
				(notice.state !== "awaiting filter" &&
					!(
						notice.state === "deferred" &&
						notice.decision?.action === "defer" &&
						Date.parse(notice.decision.until) <= Date.now()
					))
			)
				throw new NodeError("UNAUTHORIZED", "This Coordinator reply was already handled");
			const text = string(params(args).text, "text").trim();
			const saved = await store.decide([sourceId], { action: "send", reason: "Filter sent an update", text });
			if (saved.state !== "delivery pending") throw new NodeError("BUSY", "Filter decision changed");
			return {
				content: [{ type: "text", text: "Update saved for delivery to the Workspace leader." }],
				structuredContent: { status: "saved" },
				isError: false,
			};
		},
	};
}

export const meHandlers: NodeHandlers = {
	"filter.open": (ctx, value) => openFilterSession(ctx, string(params(value).workspaceId, "workspaceId")),
	"workspace-leader.open": (ctx, value) =>
		openWorkspaceLeaderSession(ctx, string(params(value).workspaceId, "workspaceId")),
	"filter.deliveries": (_ctx, value) => openMeStore().diagnostics(string(params(value).workspaceId, "workspaceId")),
};
export function createWorkspaceLeaderToolBridge(input: {
	actorId: string;
	workspaceId: string;
	context(): NodeContext;
}): SessionToolBridge {
	const tools: SessionToolBridge["tools"] = [
		{
			name: "missions",
			description:
				"Read compact mission summaries in this workspace, newest number first. Use the cursor for more and mission for details.",
			inputSchema: {
				type: "object",
				properties: {
					agentName: { type: "string", minLength: 1 },
					limit: { type: "integer", minimum: 1, maximum: 20 },
					cursor: { type: "string", minLength: 1 },
				},
				additionalProperties: false,
			},
		},
		{
			name: "mission",
			description: "Read one mission's summary, objective, agent list, or agent text in bounded pages.",
			inputSchema: {
				type: "object",
				required: ["number"],
				additionalProperties: false,
				properties: {
					number: { type: "integer", minimum: 1 },
					section: { type: "string", enum: ["summary", "objective", "attention", "agents", "agentText"] },
					agentId: { type: "string", minLength: 1 },
					field: { type: "string", enum: ["task"] },
					cursor: { type: "string", minLength: 1 },
				},
			},
		},
		{
			name: "artifacts",
			description:
				"Inspect metadata or open a bounded text range for an artifact published for the workspace leader in this workspace. This does not publish or alter artifacts.",
			inputSchema: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["inspect", "open"] },
					id: { type: "string", minLength: 1, maxLength: 256 },
					offset: { type: "integer", minimum: 0 },
					limit: { type: "integer", minimum: 1, maximum: 2048 },
				},
				required: ["action", "id"],
				additionalProperties: false,
			},
		},
		{
			name: "send_message",
			description:
				"Send a command, question, clarification or answer to this coordinator. Node includes the originating native turn and original user wording automatically.",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string", minLength: 1, maxLength: 16000 } },
				required: ["text"],
				additionalProperties: false,
			},
		},
	];
	return {
		actorId: input.actorId,
		tools,
		call: async (name, args) => {
			const tool = tools.find((t) => t.name === name);
			if (!tool) throw new NodeError("METHOD_NOT_FOUND", "Unknown workspace leader tool");
			const errors = checkSchema(tool.inputSchema, args, "params");
			if (errors) throw new NodeError("INVALID_PARAMS", String(errors));
			const p = params(args);
			const identity = await openMeStore().workspaceLeaderBySession(input.actorId);
			if (!identity || identity.workspaceId !== input.workspaceId)
				throw new NodeError("UNAUTHORIZED", "Workspace leader conversation is not bound to this workspace");
			let result: unknown;
			if (name === "missions") {
				const ctx = input.context();
				const workspaceId = input.workspaceId;
				const workspace = ctx.store.getWorkspace(workspaceId);
				if (!workspace) throw new NodeError("NOT_FOUND", "workspace is not on this Neta Node");
				const limit = p.limit === undefined ? 5 : p.limit;
				if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
					throw new NodeError("INVALID_PARAMS", "limit must be an integer from 1 to 20");
				if (p.cursor !== undefined && typeof p.cursor !== "string")
					throw new NodeError("INVALID_PARAMS", "cursor must be a mission id");
				if (p.agentName !== undefined && (typeof p.agentName !== "string" || p.agentName.trim() === ""))
					throw new NodeError("INVALID_PARAMS", "agentName must be a nonempty name");
				const agentName = typeof p.agentName === "string" ? p.agentName.trim().toLowerCase() : undefined;
				const missions = ctx.store
					.listMissions(workspaceId)
					.filter(
						(mission) =>
							agentName === undefined ||
							ctx.store.listAgents(mission.id).some((agent) => agent.name.toLowerCase() === agentName),
					)
					.sort((a, b) => b.number - a.number);
				const start = p.cursor === undefined ? 0 : missions.findIndex((mission) => mission.id === p.cursor) + 1;
				if (p.cursor !== undefined && start === 0) throw new NodeError("INVALID_PARAMS", "unknown mission cursor");
				const rows = missions.map((mission) => {
					const agents = ctx.store.listAgents(mission.id);
					return {
						id: mission.id,
						number: mission.number,
						name: mission.name,
						state: deriveMissionState(mission),
						closedAt: mission.closedAt,
						disposition: mission.disposition,
						agentCount: agents.length,
						...(mission.attention ? { attention: utf8Excerpt(mission.attention, 160) } : {}),
					};
				});
				const envelope = (page: typeof rows, hasMore: boolean) => ({
					at: new Date().toISOString(),
					workspace: { id: workspace.id, name: workspace.name },
					leader: (() => {
						const leader = ctx.store.getLeader(workspaceId);
						return leader ? { name: leader.name, state: leader.state } : undefined;
					})(),
					counts: {
						total: missions.length,
						open: missions.filter((mission) => mission.state !== "closed").length,
					},
					missions: page,
					hasMore: start + page.length < missions.length,
					...(hasMore ? { nextCursor: missions[start + page.length - 1]?.id } : {}),
				});
				const page = fitPage(rows, start, limit, DEFAULT_READ_BYTES, envelope);
				result = envelope(page, start + page.length < rows.length);
			} else if (name === "mission") {
				const ctx = input.context();
				if (typeof p.number !== "number" || !Number.isSafeInteger(p.number) || p.number < 1)
					throw new NodeError("INVALID_PARAMS", "number must be a positive mission number");
				const mission = ctx.store.listMissions(input.workspaceId).find((item) => item.number === p.number);
				if (!mission) throw new NodeError("NOT_FOUND", "mission is not in this workspace");
				const agents = ctx.store.listAgents(mission.id).sort((a, b) => a.id.localeCompare(b.id));
				const section = p.section ?? "summary";
				if (section === "summary") {
					result = {
						number: mission.number,
						name: mission.name,
						state: deriveMissionState(mission),
						createdAt: mission.createdAt,
						closedAt: mission.closedAt,
						disposition: mission.disposition,
						attention: utf8Excerpt(mission.attention ?? "", 400).text,
						attentionTruncated: Buffer.byteLength(mission.attention ?? "") > 400,
						agentCount: agents.length,
					};
				} else if (section === "objective") {
					result = {
						number: mission.number,
						section,
						...scopedTextPage(
							mission.objective,
							`mission:${mission.id}:objective`,
							p.cursor as string | undefined,
						),
					};
				} else if (section === "attention") {
					result = {
						number: mission.number,
						section,
						...scopedTextPage(
							mission.attention ?? "",
							`mission:${mission.id}:attention`,
							p.cursor as string | undefined,
						),
					};
				} else if (section === "agents") {
					const start = p.cursor === undefined ? 0 : agents.findIndex((agent) => agent.id === p.cursor) + 1;
					if (p.cursor !== undefined && start === 0) throw new NodeError("INVALID_PARAMS", "unknown agent cursor");
					const rows = agents.map((agent) => ({
						id: agent.id,
						name: agent.name,
						sessionId: agent.sessionId,
						state: agent.state,
						deliveryStatus: agent.deliveryStatus,
						hasTask: Boolean(agent.task),
					}));
					const envelope = (page: typeof rows, hasMore: boolean) => ({
						number: mission.number,
						section,
						agents: page,
						hasMore,
						...(hasMore ? { nextCursor: agents[start + page.length - 1]?.id } : {}),
					});
					const page = fitPage(rows, start, 5, DETAIL_READ_BYTES, envelope);
					result = envelope(page, start + page.length < rows.length);
				} else if (section === "agentText") {
					const agent = agents.find((item) => item.id === p.agentId);
					if (!agent || !["task"].includes(String(p.field)))
						throw new NodeError("INVALID_PARAMS", "agentId and field are required");
					const field = p.field as "task";
					const value = agent[field];
					result = {
						number: mission.number,
						section,
						agentId: agent.id,
						field,
						...scopedTextPage(
							value ?? "",
							`mission:${mission.id}:agent:${agent.id}:${field}`,
							p.cursor as string | undefined,
						),
					};
				} else throw new NodeError("INVALID_PARAMS", "unknown mission section");
			} else if (name === "artifacts") {
				if (p.action !== "inspect" && p.action !== "open")
					throw new NodeError("INVALID_PARAMS", "action must be inspect or open");
				const ctx = input.context();
				const identity = await openMeStore().workspaceLeaderBySession(input.actorId);
				if (!identity || identity.workspaceId !== input.workspaceId)
					throw new NodeError("UNAUTHORIZED", "Workspace leader session is not bound to this workspace");
				result = await inspectArtifact(
					{
						workspaceId: input.workspaceId,
						machineId: ctx.store.machine().id,
						actorId: input.actorId,
						kind: "neta",
					},
					string(p.id, "id"),
					p.action === "open"
						? {
								offset: typeof p.offset === "number" ? p.offset : 0,
								limit: typeof p.limit === "number" ? p.limit : 2048,
							}
						: undefined,
				);
			} else if (name === "send_message") {
				const ctx = input.context();
				const text = string(p.text, "text");
				const leader = ctx.store.getLeader(input.workspaceId);
				if (!leader || !ctx.runtime.send) throw new NodeError("NOT_FOUND", "Coordinator is unavailable");
				const turnId = (await ctx.runtime.runtimeDiagnostics?.(input.actorId))?.turnId;
				if (!turnId) throw new NodeError("BUSY", "Sending requires an active native turn");
				const incoming = ((await ctx.runtime.listInbox?.(input.actorId)) ?? []).filter(
					(m) => m.turnId === turnId && m.readerDirected === true,
				);
				const message = [
					"Message from the workspace leader:",
					text,
					...incoming.flatMap((m) => ["Original user message (preserve its wording and constraints):", m.text]),
				].join("\n\n");
				const sourceId =
					"message:" +
					createHash("sha256")
						.update(JSON.stringify([input.actorId, turnId, leader.sessionId, text]))
						.digest("hex");
				const receipt = await ctx.runtime.send(leader.sessionId, message, [], { readerDirected: false, sourceId });
				try {
					await restoreNativeOwner(ctx, leader.sessionId);
				} catch (error) {
					ctx.hub.broadcast("error", {
						sessionId: leader.sessionId,
						message: `Message saved, recipient unavailable: ${String(error)}`,
					});
				}
				result = { messageId: receipt.id, status: receipt.status };
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result as Record<string, unknown>,
				isError: false,
			};
		},
	};
}
