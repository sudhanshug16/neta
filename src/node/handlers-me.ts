import { createHash } from "node:crypto";
import type { InboxMessage } from "../core/types.ts";
import { type MeReply, openMeStore, type SolIdentity, type SolRouteIntent } from "../me/store.ts";
import { NodeError } from "./protocol.ts";
import type { NodeHandlers } from "./server.ts";

const SOL_MODEL = "openai/gpt-6-sol";
const SOL_EFFORT = "medium";
const solOpenings = new Map<string, Promise<SolIdentity & { provider: string; model: string; variant?: string }>>();

function params(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new NodeError("INVALID_PARAMS", "Me params must be an object");
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new NodeError("INVALID_PARAMS", `${name} is required`);
	return value;
}

async function openSolSession(ctx: Parameters<NonNullable<NodeHandlers["me.list"]>>[0], workspaceHint?: string) {
	const store = openMeStore();
	const existing = await store.solIdentity();
	const opening = solOpenings.get(existing.sessionId);
	if (opening) return opening;
	const pending = (async () => {
		const workspaceId = existing.workspaceId ?? workspaceHint;
		if (!workspaceId) throw new NodeError("INVALID_PARAMS", "workspaceId is required to start Sol's native session");
		const workspace = ctx.store.getWorkspace(workspaceId);
		const leader = ctx.store.getLeader(workspaceId);
		const root = workspace?.roots.find((item) => item.machineId === ctx.store.machine().id)?.path;
		if (!workspace || !leader || !root)
			throw new NodeError("NOT_FOUND", "Sol needs an available workspace leader and local workspace root to start");
		const provider = existing.provider ?? leader.provider;
		const model = existing.model ?? (provider === "opencode" ? SOL_MODEL : leader.model);
		const identity = await store.bindSolRuntime({
			workspaceId,
			provider,
			model,
		});
		try {
			const selected = existing.workspaceId
				? await ctx.runtime.ensureSession({
						sessionId: identity.sessionId,
						workspaceId,
						cwd: root,
						provider,
						model,
						access: "readOnly",
						unsandboxed: false,
						netaTools: false,
						allowFresh: false,
					})
				: await ctx.runtime.createSession({
						sessionId: identity.sessionId,
						workspaceId,
						cwd: root,
						provider,
						model,
						access: "readOnly",
						unsandboxed: false,
						netaTools: false,
					});
			if (selected.sessionId !== identity.sessionId)
				throw new NodeError("PROVIDER_ERROR", "Sol runtime did not restore its persisted native session identity");
			if (provider === "opencode") {
				if (!ctx.runtime.setNativeVariant || !ctx.runtime.runtimeDiagnostics)
					throw new NodeError("PROVIDER_ERROR", "Sol model effort cannot be verified by this runtime");
				await ctx.runtime.setModel(identity.sessionId, model);
				await ctx.runtime.setNativeVariant(identity.sessionId, SOL_EFFORT);
				const diagnostics = await ctx.runtime.runtimeDiagnostics(identity.sessionId);
				if (diagnostics.model !== model || diagnostics.variant !== SOL_EFFORT)
					throw new NodeError(
						"PROVIDER_ERROR",
						"Sol GPT-6 model or medium effort was not selected by the native runtime",
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
				error instanceof Error ? error.message : "Sol native session is unavailable",
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
		if (!ctx.runtime.send) throw new NodeError("METHOD_NOT_FOUND", "durable Sol message delivery is unavailable");
		const turn = await openMeStore().appendSolTurn({ idempotencyKey, author: "user", text });
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
		if (p.limit !== undefined && (typeof p.limit !== "number" || !Number.isSafeInteger(p.limit)))
			throw new NodeError("INVALID_PARAMS", "limit must be an integer");
		if (p.after !== undefined && typeof p.after !== "string")
			throw new NodeError("INVALID_PARAMS", "after must be a turn id");
		return openMeStore().listSolTurns({ limit: p.limit as number | undefined, after: p.after as string | undefined });
	},
	"sol.routes": async (_ctx, value) => {
		const p = params(value);
		if (p.limit !== undefined && (typeof p.limit !== "number" || !Number.isSafeInteger(p.limit)))
			throw new NodeError("INVALID_PARAMS", "limit must be an integer");
		try {
			return { routes: await openMeStore().listRoutes(p.limit as number | undefined) };
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
		const sourceTurn = await store.getSolTurn(solTurnId);
		if (!sourceTurn || sourceTurn.author !== "user")
			throw new NodeError("NOT_FOUND", "route source is not a saved user instruction");
		const identity = await store.solIdentity();
		if (!sourceTurn.nativeTurnId || !identity.workspaceId)
			throw new NodeError("INVALID_PARAMS", "route source is not yet correlated to Sol's native conversation");
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
			throw new NodeError("UNAUTHORIZED", "route source does not match Sol's captured native user turn");
		const leader = ctx.store.listLeaders().find((item) => item.sessionId === destinationSessionId);
		if (!leader || ctx.store.getLeader(leader.workspaceId)?.sessionId !== leader.sessionId)
			throw new NodeError("UNAUTHORIZED", "route destination is not a current workspace leader");
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
			});
		} catch (error) {
			throw new NodeError("INVALID_PARAMS", (error as Error).message);
		}
		if (route.status !== "queued" && route.status !== "delivering") return route;
		await store.updateRoute(route.id, "delivering");
		try {
			const receipt = await ctx.runtime.send(destinationSessionId, derivedInstruction, [], {
				readerDirected: true,
				sourceId: `sol-route:${route.id}`,
				sourceHash: createHash("sha256").update(derivedInstruction).digest("hex"),
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
		if (!card) throw new NodeError("NOT_FOUND", "no such Superleader card");
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
		if (!card || card.action === "suppress") throw new NodeError("NOT_FOUND", "no replyable Superleader card");
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
