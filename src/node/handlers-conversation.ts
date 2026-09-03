// Conversation handlers: tail, prompt, cancel, models, and `turn`
// subscriptions. The store port pages forward only, so `tail` with a `turnId`
// or `direction: "backward"` pages through the port and assembles the window.
// Port cursors are decimal block seqs, minted by the store and passed back
// verbatim; the adapter in `lifecycle.ts` honors the same convention.
import type { Block, Turn } from "../core/types.ts";
import { asOptionalNumber, asOptionalString, asString, parseParams } from "./handlers-registry.ts";
import { NodeError } from "./protocol.ts";
import type { NodeContext, NodeHandlers } from "./server.ts";

const READ_PAGE = 200;

function asTake(limit: number | undefined, method: string): number {
	const take = limit ?? 200;
	if (!Number.isInteger(take) || take < 1) {
		throw new NodeError("INVALID_PARAMS", `${method} limit is a positive integer`);
	}
	return take;
}

function asProviderError(error: unknown): NodeError {
	if (error instanceof NodeError) {
		return error;
	}
	return new NodeError("PROVIDER_ERROR", error instanceof Error ? error.message : String(error));
}

interface Collected {
	blocks: Block[];
	turns: Turn[];
	provider: string;
	model: string;
	ended: boolean;
}

// Pages forward from the start until the whole prefix is covered: every
// block below `below` (or the whole history when `below` is undefined) plus
// `extra` blocks past it so the window end is known. An empty page with a
// nextCursor would loop forever, so it ends the scan.
async function collectPrefix(
	ctx: NodeContext,
	sessionId: string,
	below: number | undefined,
	extra: number,
): Promise<Collected> {
	const blocks: Block[] = [];
	const turns: Turn[] = [];
	let provider = "";
	let model = "";
	let cursor: string | undefined;
	let ended = false;
	for (;;) {
		const page = await ctx.store.tailConversation(sessionId, { limit: READ_PAGE, cursor });
		provider = page.provider;
		model = page.model;
		turns.push(...page.turns);
		blocks.push(...page.blocks);
		if (page.blocks.length === 0 || page.nextCursor === undefined) {
			ended = true;
			break;
		}
		if (below !== undefined) {
			const past = blocks.filter((block) => block.seq >= below).length;
			if (blocks.length > 0 && (blocks[blocks.length - 1]?.seq ?? 0) >= below && past >= extra) {
				break;
			}
		}
		cursor = page.nextCursor;
	}
	return { blocks, turns, provider, model, ended };
}

interface Window {
	turns: Turn[];
	blocks: Block[];
	prevCursor: string | null;
	nextCursor?: string;
}

// The window is `collected.blocks[start, end)`; prevCursor is the offset
// before its first block (null at the start of history) and nextCursor
// resumes a forward tail right after its last block, absent at the end.
function assembleWindow(collected: Collected, start: number, end: number): Window {
	const windowBlocks = collected.blocks.slice(start, end);
	const turnIds = new Set(windowBlocks.map((block) => block.turnId));
	const windowTurns = collected.turns.filter((turn) => turnIds.has(turn.id));
	const prevCursor = start > 0 ? String(collected.blocks[start - 1]?.seq ?? 0) : null;
	let nextCursor: string | undefined;
	if (windowBlocks.length > 0 && (end < collected.blocks.length || !collected.ended)) {
		nextCursor = String(windowBlocks[windowBlocks.length - 1]?.seq ?? 0);
	}
	return { turns: windowTurns, blocks: windowBlocks, prevCursor, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

export const conversationHandlers: NodeHandlers = {
	"conversation.tail": async (ctx, params, conn) => {
		const parsed = parseParams(
			{
				sessionId: asString,
				limit: asOptionalNumber,
				cursor: asOptionalString,
				turnId: asOptionalString,
				direction: asOptionalString,
			},
			params,
		);
		const take = asTake(parsed.limit, "conversation.tail limit");
		const direction = parsed.direction ?? "forward";
		if (direction !== "forward" && direction !== "backward") {
			throw new NodeError("INVALID_PARAMS", "conversation.tail direction is forward or backward");
		}
		let cursorSeq: number | undefined;
		if (parsed.cursor !== undefined) {
			cursorSeq = Number.parseInt(parsed.cursor, 10);
			if (!Number.isInteger(cursorSeq) || cursorSeq < 0) {
				throw new NodeError("INVALID_PARAMS", "conversation.tail cursor is a block offset");
			}
		}
		if (parsed.turnId !== undefined) {
			const collected = await collectPrefix(ctx, parsed.sessionId, undefined, 0);
			const anchor = collected.turns.find((turn) => turn.id === parsed.turnId);
			const firstBlock = collected.blocks.findIndex((block) => block.turnId === parsed.turnId);
			if (anchor === undefined && firstBlock < 0) {
				throw new NodeError("NOT_FOUND", `no such turn: ${parsed.turnId}`);
			}
			// A turn with no blocks yet sits at the end of history, which
			// the full scan above already covers.
			const start = firstBlock < 0 ? collected.blocks.length : firstBlock;
			const window = assembleWindow(collected, start, start + take);
			conn.tailed.add(parsed.sessionId);
			return { sessionId: parsed.sessionId, provider: collected.provider, model: collected.model, ...window };
		}
		if (direction === "backward") {
			const collected = await collectPrefix(ctx, parsed.sessionId, cursorSeq, 1);
			const end =
				cursorSeq === undefined
					? collected.blocks.length
					: collected.blocks.findIndex((block) => block.seq >= cursorSeq);
			const stop = end < 0 ? collected.blocks.length : end;
			const window = assembleWindow(collected, Math.max(0, stop - take), stop);
			conn.tailed.add(parsed.sessionId);
			return { sessionId: parsed.sessionId, provider: collected.provider, model: collected.model, ...window };
		}
		const page = await ctx.store.tailConversation(parsed.sessionId, { limit: take, cursor: parsed.cursor });
		// The read comes first and the subscribe second, so a block appended
		// during the read arrives as a notification instead of being lost.
		conn.tailed.add(parsed.sessionId);
		return { sessionId: parsed.sessionId, ...page };
	},

	"conversation.untail": (_ctx, params, conn) => {
		const parsed = parseParams({ sessionId: asString }, params);
		conn.tailed.delete(parsed.sessionId);
		return Promise.resolve({ sessionId: parsed.sessionId });
	},

	"conversation.prompt": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString, text: asString }, params);
		try {
			// Returns the turnId at once; blocks arrive only as notifications.
			const turnId = await ctx.acp.prompt(parsed.sessionId, parsed.text);
			return { turnId };
		} catch (error) {
			throw asProviderError(error);
		}
	},

	"conversation.cancel": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString }, params);
		try {
			await ctx.acp.cancel(parsed.sessionId);
			return { sessionId: parsed.sessionId };
		} catch (error) {
			throw asProviderError(error);
		}
	},

	"conversation.setModel": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString, model: asString }, params);
		try {
			await ctx.acp.setModel(parsed.sessionId, parsed.model);
			return { sessionId: parsed.sessionId, model: parsed.model };
		} catch (error) {
			throw asProviderError(error);
		}
	},

	"models.list": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asOptionalString, provider: asOptionalString }, params);
		try {
			const models = await ctx.acp.listModels({ sessionId: parsed.sessionId, provider: parsed.provider });
			return { models };
		} catch (error) {
			throw asProviderError(error);
		}
	},
};

export function wireTurnStream(ctx: NodeContext): void {
	ctx.acp.onTurn((notification) => {
		ctx.hub.toTail(notification.sessionId, notification);
	});
}
