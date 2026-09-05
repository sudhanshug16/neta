import { describe, expect, test } from "bun:test";
import { glanceHandlers } from "../src/node/handlers-glance.ts";
import { NodeError } from "../src/node/protocol.ts";
import type { Connection, NodeContext } from "../src/node/server.ts";

const conn = { id: "c", client: "desktop", send() {}, tailed: new Set<string>(), close() {} } satisfies Connection;
function ctx(): NodeContext {
	const card = {
		id: "s:t",
		workspaceId: "w",
		glanceSeq: 1,
		source: "secret full response",
		sourceHash: "hash",
		result: undefined,
	};
	return {
		store: {
			glanceList: async () => ({ cards: [card], reviewedThroughGlanceSeq: 0, hasMore: false }),
			glanceGet: async (_w: string, id: string) => (id === card.id ? card : undefined),
			glanceComplete: async (_w: string, id: string, hash: string, result: unknown) =>
				id === card.id && hash === "hash" ? { ...card, result } : undefined,
			glanceMarkReviewed: async (_w: string, n: number) => n,
		} as unknown as NodeContext["store"],
		acp: {} as NodeContext["acp"],
		hub: { broadcast() {} } as unknown as NodeContext["hub"],
		nodeVersion: "test",
		stop: async () => {},
	};
}
async function call(method: string, params: unknown) {
	const handler = glanceHandlers[method];
	if (handler === undefined) throw new Error(`missing handler ${method}`);
	return handler(ctx(), params, conn);
}
describe("glance handlers", () => {
	test("list never exposes source and source is separately addressable", async () => {
		const page = (await call("glance.list", { workspaceId: "w" })) as { cards: Array<Record<string, unknown>> };
		expect(page.cards[0]?.source).toBeUndefined();
		expect(await call("glance.source", { workspaceId: "w", id: "s:t" })).toEqual({
			id: "s:t",
			sourceHash: "hash",
			source: "secret full response",
			sourceTruncated: false,
		});
	});
	test("completion hash mismatch and bad cursors are rejected", async () => {
		const completed = (await call("glance.complete", {
			workspaceId: "w",
			id: "s:t",
			sourceHash: "hash",
			result: { kind: "excerptFallback", excerpt: "short", reason: "unavailable" },
		})) as { card: Record<string, unknown> };
		expect(completed.card.source).toBeUndefined();
		expect(
			call("glance.complete", {
				workspaceId: "w",
				id: "s:t",
				sourceHash: "old",
				result: { kind: "excerptFallback", excerpt: "x", reason: "unavailable" },
			}),
		).rejects.toBeInstanceOf(NodeError);
		expect(call("glance.markReviewed", { workspaceId: "w", throughGlanceSeq: -1 })).rejects.toBeInstanceOf(NodeError);
		expect(
			call("glance.complete", {
				workspaceId: "w",
				id: "s:t",
				sourceHash: "hash",
				result: { kind: "onDeviceSummary", headline: 3, bullets: null },
			}),
		).rejects.toBeInstanceOf(NodeError);
	});
});
