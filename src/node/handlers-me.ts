import { createHash } from "node:crypto";
import type { InboxMessage } from "../core/types.ts";
import { type MeReply, openMeStore } from "../me/store.ts";
import { NodeError } from "./protocol.ts";
import type { NodeHandlers } from "./server.ts";

function params(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new NodeError("INVALID_PARAMS", "Me params must be an object");
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new NodeError("INVALID_PARAMS", `${name} is required`);
	return value;
}

export const meHandlers: NodeHandlers = {
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
		if (reply.status !== "queued")
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
