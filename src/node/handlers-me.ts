import { createHash } from "node:crypto";
import { deriveMissionState } from "../core/state.ts";
import type { InboxMessage } from "../core/types.ts";
import { inspectArtifact } from "../me/artifacts.ts";
import { readMeEvidence } from "../me/evidence.ts";
import { openPersistedRuntimeSession } from "../me/runtime-session.ts";
import {
	type MeReply,
	meSourceId,
	openMeStore,
	type SolIdentity,
	type SolInquiry,
	type SolRouteIntent,
} from "../me/store.ts";
import type { SessionToolBridge } from "../tools/router.ts";
import { NodeError } from "./protocol.ts";
import type { NodeContext, NodeHandlers } from "./server.ts";

const SOL_MODEL = "openai/gpt-6-sol";
export const SOL_EFFORT = "medium";
const solOpenings = new Map<string, Promise<SolIdentity & { provider: string; model: string; variant?: string }>>();
const solWorkspaces = new Map<string, string>();
export function registerSuperleaderSession(sessionId: string, workspaceId: string): void {
	solWorkspaces.set(sessionId, workspaceId);
}
export function unregisterSuperleaderSession(sessionId: string): void {
	solWorkspaces.delete(sessionId);
}
export function workspaceForSuperleaderSession(sessionId: string): string | undefined {
	return solWorkspaces.get(sessionId);
}

async function reconcileInquiries(
	ctx: NodeContext,
	workspaceId: string,
	limit = 100,
	after?: string,
): Promise<SolInquiry[]> {
	const store = openMeStore();
	const inquiries = await store.listInquiries(workspaceId, limit, after);
	const leaders = new Map<string, InboxMessage[]>();
	for (const inquiry of inquiries) {
		if (inquiry.status === "answered" || inquiry.status === "rejected" || !ctx.runtime.listInbox) continue;
		let inbox = leaders.get(inquiry.leaderSessionId);
		if (!inbox) {
			inbox = await ctx.runtime.listInbox(inquiry.leaderSessionId);
			leaders.set(inquiry.leaderSessionId, inbox);
		}
		const delivery = inbox.find((item) => item.sourceId === `superleader-inquiry:${inquiry.id}`);
		if (!delivery?.turnId || delivery.status !== "delivered") continue;
		const source = await store.getSource(
			meSourceId({ workspaceId, sessionId: inquiry.leaderSessionId, kind: "message", turnId: delivery.turnId }),
		);
		if (source) {
			if (inquiry.status === "queued" || inquiry.status === "delivering")
				await store.updateInquiry(inquiry.id, "delivered", delivery.id);
			await store.recordInquiryReply(inquiry.id, source.text);
		}
	}
	return Promise.all(inquiries.map(async (item) => (await store.getInquiry(item.id)) ?? item));
}

export async function reconcileRoutes(
	ctx: Pick<NodeContext, "runtime">,
	workspaceId: string,
): Promise<SolRouteIntent[]> {
	const store = openMeStore();
	const routes = (await store.unprocessedRoutes()).filter((route) => route.workspaceId === workspaceId);
	const inboxByLeader = new Map<string, InboxMessage[]>();
	for (const route of routes) {
		if (route.leaderReply || !ctx.runtime.listInbox) continue;
		const leaderSessionId = route.destinationSessionIds[0];
		if (!leaderSessionId) continue;
		let inbox = inboxByLeader.get(leaderSessionId);
		if (!inbox) {
			inbox = await ctx.runtime.listInbox(leaderSessionId);
			inboxByLeader.set(leaderSessionId, inbox);
		}
		const delivery = inbox.find((item) => item.sourceId === `sol-route:${route.id}`);
		if (!delivery?.turnId || delivery.status !== "delivered") continue;
		const source =
			(await store.getSource(
				meSourceId({ workspaceId, sessionId: leaderSessionId, kind: "message", turnId: delivery.turnId }),
			)) ??
			(await store.getSource(
				meSourceId({ workspaceId, sessionId: leaderSessionId, kind: "failure", turnId: delivery.turnId }),
			));
		if (source) {
			if (route.status === "queued" || route.status === "delivering")
				await store.updateRoute(route.id, "delivered", delivery.id);
			await store.recordRouteReply(route.id, source.text, { turnId: delivery.turnId, sourceId: source.id });
		}
	}
	return store.listRoutes(100, workspaceId);
}

function params(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new NodeError("INVALID_PARAMS", "Me params must be an object");
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new NodeError("INVALID_PARAMS", `${name} is required`);
	return value;
}

export async function openSolSession(ctx: Parameters<NonNullable<NodeHandlers["me.list"]>>[0], workspaceHint?: string) {
	const store = openMeStore();
	if (!workspaceHint) throw new NodeError("INVALID_PARAMS", "workspaceId is required for Neta");
	const workspace = ctx.store.getWorkspace(workspaceHint);
	const leader = ctx.store.getLeader(workspaceHint);
	const root = workspace?.roots.find((item) => item.machineId === ctx.store.machine().id)?.path;
	if (!workspace || !leader || !root)
		throw new NodeError("NOT_FOUND", "Neta needs an available workspace leader and local workspace root to start");
	const existing = await store.solIdentity(workspaceHint);
	registerSuperleaderSession(existing.sessionId, workspaceHint);
	const opening = solOpenings.get(existing.sessionId);
	if (opening) return opening;
	const pending = (async () => {
		const workspaceId = workspaceHint;
		const provider = existing.provider ?? leader.provider;
		const model = existing.model ?? (provider === "opencode" ? SOL_MODEL : leader.model);
		let identity = await store.bindSolRuntime({
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
				initialized: existing.runtimeInitialized ?? existing.provider !== undefined,
				markInitialized: () => store.markSolRuntimeInitialized(workspaceId),
			});
			identity = await store.solIdentity(workspaceId);
			if (provider === "opencode") {
				if (!ctx.runtime.setNativeVariant || !ctx.runtime.runtimeDiagnostics)
					throw new NodeError("PROVIDER_ERROR", "Neta model effort cannot be verified by this runtime");
				let diagnostics = await ctx.runtime.runtimeDiagnostics(identity.sessionId);
				if (diagnostics.model !== model) {
					await ctx.runtime.setModel(identity.sessionId, model);
					diagnostics = await ctx.runtime.runtimeDiagnostics(identity.sessionId);
				}
				if (diagnostics.variant !== SOL_EFFORT) {
					await ctx.runtime.setNativeVariant(identity.sessionId, SOL_EFFORT);
					diagnostics = await ctx.runtime.runtimeDiagnostics(identity.sessionId);
				}
				if (diagnostics.model !== model || diagnostics.variant !== SOL_EFFORT)
					throw new NodeError(
						"PROVIDER_ERROR",
						"Neta GPT-6 model or medium effort was not selected by the native runtime",
					);
			}
			return {
				...identity,
				provider: selected.provider,
				model: selected.model,
				...(provider === "opencode" ? { variant: SOL_EFFORT } : {}),
			};
		} catch (error) {
			if (error instanceof NodeError) throw error;
			throw new NodeError(
				"PROVIDER_ERROR",
				error instanceof Error ? error.message : "Neta native session is unavailable",
			);
		}
	})();
	solOpenings.set(existing.sessionId, pending);
	try {
		return await pending;
	} finally {
		if (solOpenings.get(existing.sessionId) === pending) solOpenings.delete(existing.sessionId);
	}
}

export const meHandlers: NodeHandlers = {
	"sol.open": async (ctx, value) => {
		const p = params(value);
		if (p.workspaceId !== undefined && typeof p.workspaceId !== "string")
			throw new NodeError("INVALID_PARAMS", "workspaceId must be a string");
		return openSolSession(ctx, p.workspaceId as string | undefined);
	},
	"sol.prompt": async (ctx, value) => {
		const p = params(value);
		const text = string(p.text, "text");
		const idempotencyKey = string(p.idempotencyKey, "idempotencyKey");
		if (p.workspaceId !== undefined && typeof p.workspaceId !== "string")
			throw new NodeError("INVALID_PARAMS", "workspaceId must be a string");
		const identity = await openSolSession(ctx, p.workspaceId as string | undefined);
		if (!ctx.runtime.send) throw new NodeError("METHOD_NOT_FOUND", "durable Neta message delivery is unavailable");
		const turn = await openMeStore().appendSolTurn({
			workspaceId: identity.workspaceId,
			idempotencyKey,
			author: "user",
			text,
		});
		const message = await ctx.runtime.send(identity.sessionId, text, [], {
			readerDirected: true,
			sourceId: `sol-turn:${turn.id}`,
			sourceHash: createHash("sha256").update(text).digest("hex"),
		});
		if (message.turnId) await openMeStore().bindSolNativeTurn(turn.id, message.turnId);
		return {
			sessionId: identity.sessionId,
			solTurnId: turn.id,
			nativeTurnId: message.turnId,
			messageId: message.id,
			status: message.status,
		};
	},
	"sol.turns": async (_ctx, value) => {
		const p = params(value);
		const workspaceId = string(p.workspaceId, "workspaceId");
		if (p.limit !== undefined && (typeof p.limit !== "number" || !Number.isSafeInteger(p.limit)))
			throw new NodeError("INVALID_PARAMS", "limit must be an integer");
		if (p.after !== undefined && typeof p.after !== "string")
			throw new NodeError("INVALID_PARAMS", "after must be a turn id");
		return openMeStore().listSolTurns({
			workspaceId,
			limit: p.limit as number | undefined,
			after: p.after as string | undefined,
		});
	},
	"sol.evidence": async (ctx, value) => {
		const p = params(value);
		if (
			!Array.isArray(p.sourceIds) ||
			p.sourceIds.length < 1 ||
			p.sourceIds.length > 8 ||
			p.sourceIds.some((id) => typeof id !== "string" || id.length > 256)
		)
			throw new NodeError("INVALID_PARAMS", "sourceIds must contain 1 to 8 captured source ids");
		const store = openMeStore();
		const evidence = [];
		for (const sourceId of p.sourceIds as string[]) {
			const source = await store.getSource(sourceId);
			if (!source) continue;
			const expanded = await readMeEvidence(ctx.store, source);
			evidence.push({
				source,
				text: expanded.text.slice(0, 8_000),
				complete: expanded.complete && expanded.text.length <= 8_000,
			});
		}
		return { evidence };
	},
	"sol.routes": async (_ctx, value) => {
		const p = params(value);
		const workspaceId = string(p.workspaceId, "workspaceId");
		if (p.limit !== undefined && (typeof p.limit !== "number" || !Number.isSafeInteger(p.limit)))
			throw new NodeError("INVALID_PARAMS", "limit must be an integer");
		try {
			return { routes: await openMeStore().listRoutes(p.limit as number | undefined, workspaceId) };
		} catch (error) {
			throw new NodeError("INVALID_PARAMS", (error as Error).message);
		}
	},
	"sol.route": async (ctx, value) => {
		const p = params(value);
		const idempotencyKey = string(p.idempotencyKey, "idempotencyKey");
		const solTurnId = string(p.solTurnId, "solTurnId");
		const derivedInstruction = string(p.derivedInstruction, "derivedInstruction");
		const derivation = string(p.derivation, "derivation");
		const destinationSessionId = string(p.destinationSessionId, "destinationSessionId");
		if (
			p.provenanceSourceIds !== undefined &&
			(!Array.isArray(p.provenanceSourceIds) || p.provenanceSourceIds.some((id) => typeof id !== "string"))
		)
			throw new NodeError("INVALID_PARAMS", "provenanceSourceIds must be an array of source ids");
		const store = openMeStore();
		let sourceTurn = await store.getSolTurn(solTurnId);
		if (!sourceTurn || sourceTurn.author !== "user")
			throw new NodeError("NOT_FOUND", "route source is not a saved user instruction");
		const identity = sourceTurn.workspaceId ? await store.solIdentity(sourceTurn.workspaceId) : undefined;
		if (!identity?.workspaceId) throw new NodeError("INVALID_PARAMS", "route source has no workspace");
		if (!sourceTurn.nativeTurnId) {
			const sourceId = `sol-turn:${sourceTurn.id}`;
			const delivered = (await ctx.runtime.listInbox?.(identity.sessionId))?.find(
				(message) => message.sourceId === sourceId && message.status === "delivered" && message.turnId,
			);
			if (delivered?.turnId) sourceTurn = await store.bindSolNativeTurn(sourceTurn.id, delivered.turnId);
		}
		if (!sourceTurn.nativeTurnId || !identity.workspaceId)
			throw new NodeError("INVALID_PARAMS", "route source is not yet correlated to Neta's native conversation");
		let cursor: string | undefined;
		let capturedSource = "";
		for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
			const page = await ctx.store.tailConversation(identity.sessionId, {
				limit: 200,
				...(cursor === undefined ? {} : { cursor }),
			});
			const matching = page.blocks.filter(
				(block) => block.turnId === sourceTurn.nativeTurnId && block.role === "user" && block.kind === "text",
			);
			if (matching.length) {
				capturedSource = matching.map((block) => block.text).join("");
				break;
			}
			if (page.nextCursor === undefined || page.nextCursor === cursor) break;
			cursor = page.nextCursor;
		}
		if (capturedSource !== sourceTurn.text)
			throw new NodeError("UNAUTHORIZED", "route source does not match Neta's captured native user turn");
		const leader = ctx.store.listLeaders().find((item) => item.sessionId === destinationSessionId);
		if (!leader || ctx.store.getLeader(leader.workspaceId)?.sessionId !== leader.sessionId)
			throw new NodeError("UNAUTHORIZED", "route destination is not a current workspace leader");
		if (leader.workspaceId !== identity.workspaceId)
			throw new NodeError("UNAUTHORIZED", "route destination belongs to another workspace");
		if (!ctx.runtime.send) throw new NodeError("METHOD_NOT_FOUND", "durable leader delivery is unavailable");
		let route: SolRouteIntent;
		try {
			route = await store.queueRoute({
				idempotencyKey,
				solTurnId,
				instruction: sourceTurn.text,
				derivedInstruction,
				derivation,
				destinationSessionIds: [destinationSessionId],
				provenanceSourceIds: (p.provenanceSourceIds as string[] | undefined) ?? [],
				...(typeof p.questionId === "string" ? { questionId: p.questionId } : {}),
			});
		} catch (error) {
			throw new NodeError("INVALID_PARAMS", (error as Error).message);
		}
		if (route.status !== "queued" && route.status !== "delivering") return route;
		await store.updateRoute(route.id, "delivering");
		try {
			const deliveredText = [
				`[Neta handoff ${route.id}]`,
				...(route.questionId
					? [
							`Answer to pending question ${route.questionId}. Keep this ID when forwarding to the mission lead; do not apply it to another question.`,
						]
					: []),
				"Original user instruction (verbatim):",
				route.instruction,
				"Neta context and requested work:",
				derivedInstruction,
				`Derivation: ${derivation}`,
				"Please coordinate within this workspace and report the result or blocker in this conversation.",
			].join("\n\n");
			const receipt = await ctx.runtime.send(destinationSessionId, deliveredText, [], {
				readerDirected: true,
				sourceId: `sol-route:${route.id}`,
				sourceHash: createHash("sha256").update(deliveredText).digest("hex"),
			});
			const status =
				receipt.status === "delivered" ? "delivered" : receipt.status === "uncertain" ? "uncertain" : "accepted";
			return store.updateRoute(route.id, status, receipt.id);
		} catch (error) {
			const saved = await store.updateRoute(route.id, "uncertain", "delivery outcome unknown");
			throw new NodeError(
				"PROVIDER_ERROR",
				`leader route delivery uncertain (${saved.id}): ${(error as Error).message}`,
			);
		}
	},
	"me.list": async (_ctx, value) => {
		const p = params(value);
		const store = openMeStore();
		if (p.includeSuppressed !== undefined && typeof p.includeSuppressed !== "boolean")
			throw new NodeError("INVALID_PARAMS", "includeSuppressed must be boolean");
		if (p.limit !== undefined && (typeof p.limit !== "number" || !Number.isSafeInteger(p.limit)))
			throw new NodeError("INVALID_PARAMS", "limit must be an integer");
		if (p.after !== undefined && typeof p.after !== "string")
			throw new NodeError("INVALID_PARAMS", "after must be a card id");
		return store.list({
			includeSuppressed: p.includeSuppressed === true,
			limit: p.limit as number | undefined,
			after: p.after as string | undefined,
		});
	},
	"me.sources": async (_ctx, value) => {
		const store = openMeStore();
		const card = await store.getCard(string(params(value).cardId, "cardId"));
		if (!card) throw new NodeError("NOT_FOUND", "no such Neta card");
		const sources = await Promise.all(card.sourceIds.map((id) => store.getSource(id)));
		return { sources: sources.filter((source) => source !== undefined) };
	},
	"me.read": async (ctx, value) => {
		const store = openMeStore();
		const cardId = string(params(value).cardId, "cardId");
		try {
			await store.markRead(cardId);
		} catch (error) {
			throw new NodeError("NOT_FOUND", (error as Error).message);
		}
		ctx.hub.broadcast("me.changed", { cardId });
		return { cardId };
	},
	"me.reply": async (ctx, value) => {
		const store = openMeStore();
		const p = params(value);
		const cardId = string(p.cardId, "cardId");
		const text = string(p.text, "text");
		const idempotencyKey = string(p.idempotencyKey, "idempotencyKey");
		const card = await store.getCard(cardId);
		if (!card || card.action === "suppress") throw new NodeError("NOT_FOUND", "no replyable Neta card");
		const destinationSessionId =
			p.destinationSessionId === undefined
				? card.destinationSessionIds.length === 1
					? card.destinationSessionIds[0]
					: undefined
				: string(p.destinationSessionId, "destinationSessionId");
		if (!destinationSessionId || !card.destinationSessionIds.includes(destinationSessionId))
			throw new NodeError("INVALID_PARAMS", "choose one recorded reply destination");
		const leader = ctx.store.listLeaders().find((item) => item.sessionId === destinationSessionId);
		const agent = ctx.store.listAgents().find((item) => item.sessionId === destinationSessionId);
		const ownerWorkspaceId = leader?.workspaceId ?? agent?.workspaceId;
		if (!ownerWorkspaceId || ownerWorkspaceId !== card.workspaceId)
			throw new NodeError("UNAUTHORIZED", "reply destination is no longer owned by this workspace");
		if (!ctx.runtime.send) throw new NodeError("METHOD_NOT_FOUND", "durable message delivery is unavailable");
		let reply: MeReply;
		try {
			reply = await store.queueReply({ idempotencyKey, cardId, text, destinationSessionId });
		} catch (error) {
			throw new NodeError("INVALID_PARAMS", (error as Error).message);
		}
		if (reply.status !== "queued" && reply.status !== "delivering")
			return { id: reply.id, status: reply.status, receipt: reply.receipt, destinationSessionId };
		await store.updateReply(reply.id, "delivering");
		let inbox: InboxMessage;
		try {
			inbox = await ctx.runtime.send(destinationSessionId, reply.text, [], {
				readerDirected: true,
				sourceId: reply.id,
				sourceHash: createHash("sha256").update(reply.text).digest("hex"),
			});
		} catch (error) {
			const saved = await store.updateReply(reply.id, "uncertain", "delivery outcome unknown");
			ctx.hub.broadcast("me.changed", { cardId, replyId: reply.id });
			throw new NodeError("PROVIDER_ERROR", `reply delivery uncertain (${saved.id}): ${(error as Error).message}`);
		}
		const status =
			inbox.status === "delivered"
				? "delivered"
				: inbox.status === "uncertain"
					? "uncertain"
					: inbox.status === "discarded"
						? "rejected"
						: "accepted";
		const saved = await store.updateReply(reply.id, status, inbox.id);
		ctx.hub.broadcast("me.changed", { cardId, replyId: reply.id });
		return { id: saved.id, status: saved.status, receipt: saved.receipt, destinationSessionId };
	},
};

export function createSuperleaderToolBridge(input: {
	actorId: string;
	workspaceId: string;
	context(): NodeContext;
}): SessionToolBridge {
	return {
		actorId: input.actorId,
		tools: [
			{
				name: "superleader_missions",
				description:
					"Read current mission and agent records in this workspace, including tasks, activity, outcomes, and delivery state. Optionally filter by agent name. Results are paged newest first; use the nextCursor to continue.",
				inputSchema: {
					type: "object",
					properties: {
						agentName: { type: "string", minLength: 1 },
						limit: { type: "integer", minimum: 1, maximum: 50 },
						cursor: { type: "string", minLength: 1 },
					},
					additionalProperties: false,
				},
			},
			{
				name: "superleader_feed",
				description:
					"Read current and suppressed attention records for this workspace plus bounded pending-source previews.",
				inputSchema: {
					type: "object",
					properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
					additionalProperties: false,
				},
			},
			{
				name: "superleader_ask",
				description:
					"Ask this workspace's leader a question about its work. The question is saved with a durable ID and answer status. Use for clarification, not to assign work.",
				inputSchema: {
					type: "object",
					properties: { question: { type: "string", minLength: 1, maxLength: 16_000 } },
					required: ["question"],
					additionalProperties: false,
				},
			},
			{
				name: "superleader_questions",
				description:
					"Page through this workspace's durable questions to the leader. Pending questions come first and remain visible across chat navigation.",
				inputSchema: {
					type: "object",
					properties: {
						limit: { type: "integer", minimum: 1, maximum: 50 },
						after: { type: "string", minLength: 1 },
					},
					additionalProperties: false,
				},
			},
			{
				name: "superleader_user_turns",
				description:
					"Read saved user turns in this workspace's current Neta chat, newest first. Use a returned turn ID to route that exact user instruction to the workspace leader.",
				inputSchema: {
					type: "object",
					properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
					additionalProperties: false,
				},
			},
			{
				name: "superleader_attention",
				description:
					"Read durable blocked questions, failures, closeout events, open leader inquiries, instruction delivery receipts, and Neta notices still awaiting a committed native reply. Events are historical; check current mission state before calling one unresolved.",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
			},
			{
				name: "superleader_evidence",
				description:
					"Retrieve captured source text or verified bounded transcript evidence for up to eight source IDs from this workspace.",
				inputSchema: {
					type: "object",
					properties: {
						sourceIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", maxLength: 256 } },
					},
					required: ["sourceIds"],
					additionalProperties: false,
				},
			},
			{
				name: "superleader_route",
				description:
					"Forward a user-directed instruction from an exact saved Neta user turn to this workspace's leader. Keep original and derived instruction distinct, explain the derivation, and include only captured provenance IDs. When answering a pending question, include its exact questionId and source ID. Use only when the user directed or authorized this work. This tool cannot grant permissions or act as a workspace leader.",
				inputSchema: {
					type: "object",
					properties: {
						solTurnId: { type: "string", minLength: 1, maxLength: 256 },
						derivedInstruction: { type: "string", minLength: 1, maxLength: 16_000 },
						derivation: { type: "string", minLength: 1, maxLength: 2_000 },
						provenanceSourceIds: {
							type: "array",
							maxItems: 32,
							items: { type: "string", minLength: 1, maxLength: 256 },
						},
						questionId: { type: "string", minLength: 1, maxLength: 256 },
					},
					required: ["solTurnId", "derivedInstruction", "derivation"],
					additionalProperties: false,
				},
			},
			{
				name: "neta_present",
				description:
					"Declare which captured source IDs were used for this Neta attention notice. Call during the notice's native turn before the final user-facing reply. This records provenance only after the turn commits.",
				inputSchema: {
					type: "object",
					properties: {
						noticeId: { type: "string", minLength: 1, maxLength: 256 },
						sourceIds: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", maxLength: 256 } },
					},
					required: ["noticeId", "sourceIds"],
					additionalProperties: false,
				},
			},
			{
				name: "neta_artifacts",
				description:
					"Inspect metadata or open a bounded text range for an artifact published for Neta in this workspace. This does not publish or alter artifacts.",
				inputSchema: {
					type: "object",
					properties: {
						action: { type: "string", enum: ["inspect", "open"] },
						id: { type: "string", minLength: 1, maxLength: 256 },
						offset: { type: "integer", minimum: 0 },
						limit: { type: "integer", minimum: 1, maximum: 16_384 },
					},
					required: ["action", "id"],
					additionalProperties: false,
				},
			},
		],
		call: async (name, args) => {
			const p =
				typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
			let result: unknown;
			if (name === "superleader_missions") {
				const ctx = input.context();
				const workspaceId = input.workspaceId;
				const workspace = ctx.store.getWorkspace(workspaceId);
				if (!workspace) throw new NodeError("NOT_FOUND", "workspace is not on this Neta Node");
				const limit = p.limit === undefined ? 20 : p.limit;
				if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
					throw new NodeError("INVALID_PARAMS", "limit must be an integer from 1 to 50");
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
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number);
				const start = p.cursor === undefined ? 0 : missions.findIndex((mission) => mission.id === p.cursor) + 1;
				if (p.cursor !== undefined && start === 0) throw new NodeError("INVALID_PARAMS", "unknown mission cursor");
				const page = missions.slice(start, start + limit);
				result = {
					at: new Date().toISOString(),
					workspace: { id: workspace.id, name: workspace.name },
					leader: (() => {
						const leader = ctx.store.getLeader(workspaceId);
						return leader
							? {
									name: leader.name,
									sessionId: leader.sessionId,
									state: leader.state,
									activeMissionId: leader.activeMissionId,
								}
							: undefined;
					})(),
					missions: page.map((mission) => {
						const agents = ctx.store.listAgents(mission.id);
						return {
							id: mission.id,
							number: mission.number,
							name: mission.name,
							objective: mission.objective,
							state: deriveMissionState(mission, agents),
							attention: mission.attention,
							createdAt: mission.createdAt,
							closedAt: mission.closedAt,
							disposition: mission.disposition,
							agents: agents.map((agent) => ({
								id: agent.id,
								name: agent.name,
								sessionId: agent.sessionId,
								state: agent.state,
								task: agent.task,
								activity: agent.activity,
								outcome: agent.outcome,
								deliveryStatus: agent.deliveryStatus,
							})),
						};
					}),
					hasMore: start + page.length < missions.length,
					...(start + page.length < missions.length ? { nextCursor: page.at(-1)?.id } : {}),
				};
			} else if (name === "superleader_feed") {
				const requested = p.limit === undefined ? 20 : p.limit;
				if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1 || requested > 50)
					throw new NodeError("INVALID_PARAMS", "limit must be an integer from 1 to 50");
				const feed = await openMeStore().list({
					workspaceId: input.workspaceId,
					includeSuppressed: true,
					limit: requested,
				});
				result = { ...feed, pending: feed.pending.slice(0, requested) };
			} else if (name === "superleader_ask") {
				const ctx = input.context();
				const question = string(p.question, "question");
				const leader = ctx.store.getLeader(input.workspaceId);
				if (!leader) throw new NodeError("NOT_FOUND", "workspace leader is unavailable");
				if (!ctx.runtime.send) throw new NodeError("METHOD_NOT_FOUND", "durable leader delivery is unavailable");
				const store = openMeStore();
				const recentUserTurn = (await store.listRecentSolTurns(20, input.workspaceId))
					.filter((turn) => turn.author === "user")
					.at(-1);
				const inquiry = await store.queueInquiry({
					idempotencyKey: createHash("sha256")
						.update(JSON.stringify([input.actorId, recentUserTurn?.id ?? "", question]))
						.digest("hex"),
					workspaceId: input.workspaceId,
					leaderSessionId: leader.sessionId,
					question,
				});
				if (inquiry.status !== "queued" && inquiry.status !== "delivering") result = inquiry;
				else {
					await store.updateInquiry(inquiry.id, "delivering");
					try {
						const message = await ctx.runtime.send(
							leader.sessionId,
							`[Neta question ${inquiry.id}] ${question}\nWhen you have a substantive answer, call neta_superleader_answer with this inquiry ID and your answer. An interim reply will remain pending. Keep mission coordination in your own workspace.`,
							[],
							{ readerDirected: true, sourceId: `superleader-inquiry:${inquiry.id}` },
						);
						result = await store.updateInquiry(
							inquiry.id,
							message.status === "delivered"
								? "delivered"
								: message.status === "uncertain"
									? "uncertain"
									: "accepted",
							message.id,
						);
					} catch (error) {
						await store.updateInquiry(inquiry.id, "uncertain", "delivery outcome unknown");
						throw new NodeError(
							"PROVIDER_ERROR",
							`question delivery uncertain (${inquiry.id}): ${(error as Error).message}`,
						);
					}
				}
			} else if (name === "superleader_questions") {
				const limit = p.limit === undefined ? 20 : p.limit;
				if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
					throw new NodeError("INVALID_PARAMS", "limit must be an integer from 1 to 50");
				if (p.after !== undefined && typeof p.after !== "string")
					throw new NodeError("INVALID_PARAMS", "after must be an inquiry id");
				const page = await reconcileInquiries(
					input.context(),
					input.workspaceId,
					limit + 1,
					p.after as string | undefined,
				);
				result = {
					inquiries: page.slice(0, limit),
					hasMore: page.length > limit,
					...(page.length > limit ? { nextCursor: page[limit - 1]?.id } : {}),
				};
			} else if (name === "superleader_user_turns") {
				const limit = p.limit === undefined ? 5 : p.limit;
				if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
					throw new NodeError("INVALID_PARAMS", "limit must be an integer from 1 to 20");
				const store = openMeStore();
				const identity = await store.solIdentity(input.workspaceId);
				result = {
					turns: (await store.listRecentSolTurns(100, input.workspaceId))
						.filter(
							(turn) =>
								turn.author === "user" && (!identity.contextResetAt || turn.at >= identity.contextResetAt),
						)
						.slice(-limit)
						.reverse()
						.map((turn) => ({ id: turn.id, at: turn.at, text: turn.text })),
				};
			} else if (name === "superleader_attention") {
				const store = openMeStore();
				const ctx = input.context();
				const events = await store.attentionEvents(input.workspaceId);
				result = {
					events: events.map((source) => {
						const mission = source.missionId ? ctx.store.getMission(source.missionId) : undefined;
						return {
							...source,
							...(mission && mission.workspaceId === input.workspaceId
								? {
										currentMission: {
											number: mission.number,
											name: mission.name,
											state: deriveMissionState(mission, ctx.store.listAgents(mission.id)),
											attention: mission.attention,
										},
									}
								: {}),
						};
					}),
					inquiries: await reconcileInquiries(ctx, input.workspaceId),
					routes: await reconcileRoutes(ctx, input.workspaceId),
					notices: (await store.pendingNotices(input.workspaceId)).map((notice) => ({
						id: notice.id,
						status: notice.status,
						headline: notice.headline,
						createdAt: notice.createdAt,
						sourceIds: notice.sourceIds,
					})),
				};
			} else if (name === "superleader_evidence") {
				if (!Array.isArray(p.sourceIds) || p.sourceIds.some((id) => typeof id !== "string"))
					throw new NodeError("INVALID_PARAMS", "sourceIds must be source ids");
				for (const id of p.sourceIds as string[]) {
					const source = await openMeStore().getSource(id);
					if (!source || source.workspaceId !== input.workspaceId)
						throw new NodeError("UNAUTHORIZED", "source belongs to another workspace");
				}
				result = await meHandlers["sol.evidence"](input.context(), args, {} as never);
			} else if (name === "superleader_route") {
				const leader = input.context().store.getLeader(input.workspaceId);
				if (!leader) throw new NodeError("NOT_FOUND", "workspace leader is unavailable");
				const idempotencyKey = createHash("sha256")
					.update(
						JSON.stringify([
							p.solTurnId,
							leader.sessionId,
							p.derivedInstruction,
							p.derivation,
							p.provenanceSourceIds ?? [],
							p.questionId ?? null,
						]),
					)
					.digest("hex");
				result = await meHandlers["sol.route"](
					input.context(),
					{ ...p, destinationSessionId: leader.sessionId, idempotencyKey },
					{} as never,
				);
			} else if (name === "neta_present") {
				const noticeId = string(p.noticeId, "noticeId");
				if (
					!Array.isArray(p.sourceIds) ||
					p.sourceIds.length < 1 ||
					p.sourceIds.length > 32 ||
					p.sourceIds.some((id) => typeof id !== "string")
				)
					throw new NodeError("INVALID_PARAMS", "sourceIds must be captured source IDs");
				const store = openMeStore();
				const identity = await store.solBySession(input.actorId);
				const notice = await store.getNotice(noticeId);
				if (!identity || identity.workspaceId !== input.workspaceId || notice?.workspaceId !== input.workspaceId)
					throw new NodeError("UNAUTHORIZED", "notice belongs to another Neta workspace session");
				const ctx = input.context();
				const delivery = (await ctx.runtime.listInbox?.(input.actorId))?.find(
					(item) => item.sourceId === `neta-notice:${noticeId}` && item.status === "delivered" && item.turnId,
				);
				if (!delivery?.turnId) throw new NodeError("INVALID_PARAMS", "notice is not in a delivered native turn");
				const active = await ctx.runtime.runtimeDiagnostics?.(input.actorId);
				if (active?.turnId !== delivery.turnId)
					throw new NodeError("UNAUTHORIZED", "notice declaration is from another native turn");
				await store.recordNoticeDelivery(noticeId, "delivered", delivery.id, delivery.turnId);
				result = await store.declareNotice(noticeId, p.sourceIds as string[]);
			} else if (name === "neta_artifacts") {
				if (p.action !== "inspect" && p.action !== "open")
					throw new NodeError("INVALID_PARAMS", "action must be inspect or open");
				const ctx = input.context();
				const identity = await openMeStore().solBySession(input.actorId);
				if (!identity || identity.workspaceId !== input.workspaceId)
					throw new NodeError("UNAUTHORIZED", "Neta session is not bound to this workspace");
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
								limit: typeof p.limit === "number" ? p.limit : 8192,
							}
						: undefined,
				);
			} else {
				throw new NodeError("METHOD_NOT_FOUND", "unknown Neta model tool");
			}
			const structuredContent =
				typeof result === "object" && result !== null && !Array.isArray(result)
					? (result as Record<string, unknown>)
					: undefined;
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				...(structuredContent === undefined ? {} : { structuredContent }),
				isError: false,
			};
		},
	};
}
