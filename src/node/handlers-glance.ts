import type { GlanceResult } from "../store/glance.ts";
import { NodeError } from "./protocol.ts";
import type { NodeHandlers } from "./server.ts";

function obj(v: unknown): Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v))
		throw new NodeError("INVALID_PARAMS", "glance params must be an object");
	return v as Record<string, unknown>;
}
function str(v: unknown, n: string): string {
	if (typeof v !== "string" || v === "") throw new NodeError("INVALID_PARAMS", `${n} must be a nonempty string`);
	return v;
}
function int(v: unknown, n: string, d?: number): number {
	if (v === undefined && d !== undefined) return d;
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
		throw new NodeError("INVALID_PARAMS", `${n} must be a nonnegative integer`);
	return v;
}
function result(v: unknown): GlanceResult {
	const value = obj(v);
	const kind = str(value.kind, "result.kind");
	if (kind === "onDeviceSummary") {
		if (!Array.isArray(value.bullets) || !value.bullets.every((item) => typeof item === "string"))
			throw new NodeError("INVALID_PARAMS", "result.bullets must be strings");
		const schemaVersion = int(value.schemaVersion, "result.schemaVersion");
		return {
			kind,
			headline: str(value.headline, "result.headline"),
			bullets: value.bullets,
			engine:
				str(value.engine, "result.engine") === "apple-on-device"
					? "apple-on-device"
					: (() => {
							throw new NodeError("INVALID_PARAMS", "invalid result.engine");
						})(),
			schemaVersion,
		};
	}
	if (kind === "excerptFallback") {
		const reason = str(value.reason, "result.reason");
		if (reason !== "unavailable" && reason !== "generationFailed" && reason !== "sourceTooLarge")
			throw new NodeError("INVALID_PARAMS", "invalid result.reason");
		return { kind, excerpt: str(value.excerpt, "result.excerpt"), reason };
	}
	throw new NodeError("INVALID_PARAMS", "invalid result.kind");
}
function visible(card: Record<string, unknown>): Record<string, unknown> {
	const { source: _source, ...metadata } = card;
	return metadata;
}
export const glanceHandlers: NodeHandlers = {
	"glance.list": async (ctx, params) => {
		const p = obj(params);
		if (!ctx.store.glanceList) throw new NodeError("METHOD_NOT_FOUND", "Glance is unavailable");
		const page = (await ctx.store.glanceList(
			str(p.workspaceId, "workspaceId"),
			int(p.after, "after", 0),
			Math.min(int(p.limit, "limit", 20), 100),
		)) as { cards: Array<Record<string, unknown>> };
		return { ...page, cards: page.cards.map(visible) };
	},
	"glance.source": async (ctx, params) => {
		const p = obj(params);
		if (!ctx.store.glanceGet) throw new NodeError("METHOD_NOT_FOUND", "Glance is unavailable");
		const id = str(p.id, "id");
		const card = (await ctx.store.glanceGet(str(p.workspaceId, "workspaceId"), id)) as
			| Record<string, unknown>
			| undefined;
		if (!card) throw new NodeError("NOT_FOUND", "no such Glance card");
		return { id, sourceHash: card.sourceHash, source: card.source, sourceTruncated: card.sourceTruncated === true };
	},
	"glance.complete": async (ctx, params) => {
		const p = obj(params);
		if (!ctx.store.glanceComplete) throw new NodeError("METHOD_NOT_FOUND", "Glance is unavailable");
		const parsedResult = result(p.result);
		let card: unknown;
		try {
			card = await ctx.store.glanceComplete(
				str(p.workspaceId, "workspaceId"),
				str(p.id, "id"),
				str(p.sourceHash, "sourceHash"),
				parsedResult,
			);
		} catch (error) {
			throw new NodeError("INVALID_PARAMS", (error as Error).message);
		}
		if (!card) throw new NodeError("INVALID_PARAMS", "Glance source changed");
		const sanitized = visible(card as unknown as Record<string, unknown>);
		ctx.hub.broadcast("glance.changed", { card: sanitized });
		return { card: sanitized };
	},
	"glance.markReviewed": async (ctx, params) => {
		const p = obj(params);
		if (!ctx.store.glanceMarkReviewed) throw new NodeError("METHOD_NOT_FOUND", "Glance is unavailable");
		try {
			const reviewedThroughGlanceSeq = await ctx.store.glanceMarkReviewed(
				str(p.workspaceId, "workspaceId"),
				int(p.throughGlanceSeq, "throughGlanceSeq"),
			);
			ctx.hub.broadcast("glance.changed", { workspaceId: p.workspaceId, reviewedThroughGlanceSeq });
			return { reviewedThroughGlanceSeq };
		} catch (error) {
			throw new NodeError("INVALID_PARAMS", (error as Error).message);
		}
	},
};
