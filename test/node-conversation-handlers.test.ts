import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Block, SessionId, Turn } from "../src/core/types.ts";
import { conversationHandlers, wireTurnStream } from "../src/node/handlers-conversation.ts";
import { NodeError, type TurnNotification } from "../src/node/protocol.ts";
import type { Connection, NodeAcp, NodeContext, NodeStore } from "../src/node/server.ts";

const SA = ulid();
const SB = ulid();
const SC = ulid();

function turn(sessionId: SessionId, id?: string): Turn {
	return { id: id ?? ulid(), sessionId, startedAt: "2026-02-01T00:00:00.000Z", role: "user" };
}

function block(sessionId: SessionId, turnId: string, seq: number): Block {
	return {
		turnId,
		seq,
		at: "2026-02-01T00:00:00.000Z",
		role: "agent",
		kind: "text",
		text: `${sessionId.slice(0, 4)}-${seq}`,
	};
}

const TA1 = turn(SA);
const TA2 = turn(SA);
const TB1 = turn(SB);
const TC1 = turn(SC);

interface SessionData {
	turns: Turn[];
	blocks: Block[];
	provider: string;
	model: string;
}

const SESSIONS = new Map<SessionId, SessionData>([
	[
		SA,
		{
			turns: [TA1, TA2],
			blocks: [block(SA, TA1.id, 1), block(SA, TA1.id, 2), block(SA, TA2.id, 3), block(SA, TA2.id, 4)],
			provider: "pA",
			model: "mA",
		},
	],
	[SB, { turns: [TB1], blocks: [block(SB, TB1.id, 1), block(SB, TB1.id, 2)], provider: "pB", model: "mB" }],
	[
		SC,
		{
			turns: [TC1],
			blocks: Array.from({ length: 10 }, (_, i) => block(SC, TC1.id, i + 1)),
			provider: "pC",
			model: "mC",
		},
	],
]);

function stubTail(
	sessionId: SessionId,
	query: { limit: number; cursor?: string },
): Omit<import("../src/node/protocol.ts").ConversationTailResult, "sessionId"> {
	const session = SESSIONS.get(sessionId);
	if (session === undefined) {
		throw new NodeError("NOT_FOUND", `no such session: ${sessionId}`);
	}
	const start = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
	const after = session.blocks.filter((b) => b.seq > start);
	const window = after.slice(0, query.limit);
	const seenTurns = [
		...new Map(window.map((b) => [b.turnId, session.turns.find((t) => t.id === b.turnId)])).values(),
	].filter((t): t is Turn => t !== undefined);
	return {
		turns: seenTurns,
		blocks: window,
		...(after.length > query.limit ? { nextCursor: String(window[window.length - 1]?.seq ?? 0) } : {}),
		prevCursor: query.cursor ?? null,
		provider: session.provider,
		model: session.model,
	};
}

interface TestConn extends Connection {
	sent: Array<{ method: string; params: unknown }>;
}

function testConn(): TestConn {
	const sent: TestConn["sent"] = [];
	return {
		id: ulid(),
		client: "cli",
		send: (method, params) => {
			sent.push({ method, params });
		},
		tailed: new Set(),
		close: () => undefined,
		sent,
	};
}

const acpCalls: Array<{ op: string; args: unknown[] }> = [];
let acpPromptReject: unknown;

function stubAcp(captured: { onTurn?: (n: TurnNotification) => void }): NodeAcp {
	const known = new Set(SESSIONS.keys());
	const check = (id: SessionId): void => {
		if (!known.has(id)) {
			throw new NodeError("NOT_FOUND", `no such session: ${id}`);
		}
	};
	return {
		createSession: () => Promise.reject(new Error("not implemented in this test")),
		prompt: (id, text) => {
			acpCalls.push({ op: "prompt", args: [id, text] });
			if (acpPromptReject !== undefined) {
				return Promise.reject(acpPromptReject);
			}
			check(id);
			return Promise.resolve(ulid());
		},
		setModel: (id, model) => {
			acpCalls.push({ op: "setModel", args: [id, model] });
			check(id);
			return Promise.resolve();
		},
		listModels: (o) => {
			acpCalls.push({ op: "listModels", args: [o] });
			return Promise.resolve([{ id: "m1", name: "M1", provider: "p" }]);
		},
		cancel: (id) => {
			acpCalls.push({ op: "cancel", args: [id] });
			check(id);
			return Promise.resolve();
		},
		close: () => Promise.reject(new Error("not implemented in this test")),
		closeAll: () => Promise.reject(new Error("not implemented in this test")),
		onTurn: (fn) => {
			captured.onTurn = fn;
		},
	};
}

function stubStore(): NodeStore {
	const missing = (): never => {
		throw new Error("not implemented in this test");
	};
	return {
		machine: () => missing(),
		listWorkspaces: () => missing(),
		listLeaders: () => missing(),
		listMissions: () => missing(),
		listAgents: () => missing(),
		getWorkspace: () => undefined,
		getLeader: () => undefined,
		getMission: () => undefined,
		getAgent: () => undefined,
		putWorkspace: () => Promise.reject(new Error("not implemented in this test")),
		putAgent: () => Promise.reject(new Error("not implemented in this test")),
		putLeader: () => Promise.reject(new Error("not implemented in this test")),
		compact: () => Promise.reject(new Error("not implemented in this test")),
		appendEvent: () => Promise.reject(new Error("not implemented in this test")),
		listEvents: () => Promise.reject(new Error("not implemented in this test")),
		tailConversation: (id, query) => Promise.resolve(stubTail(id, query)),
	};
}

function testCtx(captured: { onTurn?: (n: TurnNotification) => void }, conns: TestConn[]): NodeContext {
	return {
		store: stubStore(),
		acp: stubAcp(captured),
		hub: {
			broadcast: (method, params) => {
				for (const conn of conns) {
					conn.send(method, params);
				}
			},
			toTail: (sessionId, params) => {
				for (const conn of conns) {
					if (conn.tailed.has(sessionId)) {
						conn.send("turn", params);
					}
				}
			},
			connections: () => conns,
		},
		nodeVersion: "0.0.0-test",
		stop: () => Promise.resolve(),
	};
}

async function call(ctx: NodeContext, conn: TestConn, method: string, params: unknown): Promise<unknown> {
	const handler = conversationHandlers[method];
	if (handler === undefined) {
		throw new Error(`no handler for ${method}`);
	}
	return handler(ctx, params, conn);
}

describe("conversation.tail", () => {
	test("a forward tail returns the page and subscribes after reading it", async () => {
		const captured: { onTurn?: (n: TurnNotification) => void } = {};
		const conn = testConn();
		let tailedDuringRead: boolean | undefined;
		const ctx = testCtx(captured, [conn]);
		const inner = ctx.store.tailConversation;
		ctx.store.tailConversation = (id, query) => {
			tailedDuringRead = conn.tailed.has(id);
			return inner(id, query);
		};
		const result = (await call(ctx, conn, "conversation.tail", { sessionId: SA })) as {
			sessionId: string;
			turns: Turn[];
			blocks: Block[];
			prevCursor: null;
			provider: string;
			model: string;
		};
		expect(tailedDuringRead).toBe(false);
		expect(conn.tailed.has(SA)).toBe(true);
		expect(result.sessionId).toBe(SA);
		expect(result.turns.map((t) => t.id)).toEqual([TA1.id, TA2.id]);
		expect(result.blocks.map((b) => b.seq)).toEqual([1, 2, 3, 4]);
		expect(result.prevCursor).toBeNull();
		expect(result.provider).toBe("pA");
		expect(result.model).toBe("mA");
	});

	test("a backward tail returns older blocks with null prevCursor at the start", async () => {
		const captured: { onTurn?: (n: TurnNotification) => void } = {};
		const conn = testConn();
		const ctx = testCtx(captured, [conn]);
		const last = (await call(ctx, conn, "conversation.tail", { sessionId: SC, limit: 3, direction: "backward" })) as {
			blocks: Block[];
			prevCursor: string | null;
			nextCursor?: string;
		};
		expect(last.blocks.map((b) => b.seq)).toEqual([8, 9, 10]);
		expect(last.prevCursor).toBe("7");
		expect(last.nextCursor).toBeUndefined();
		const mid = (await call(ctx, conn, "conversation.tail", {
			sessionId: SC,
			limit: 3,
			direction: "backward",
			cursor: "7",
		})) as {
			blocks: Block[];
			prevCursor: string | null;
			nextCursor?: string;
		};
		expect(mid.blocks.map((b) => b.seq)).toEqual([4, 5, 6]);
		expect(mid.prevCursor).toBe("3");
		expect(mid.nextCursor).toBe("6");
		const first = (await call(ctx, conn, "conversation.tail", {
			sessionId: SC,
			limit: 3,
			direction: "backward",
			cursor: "3",
		})) as {
			blocks: Block[];
			prevCursor: string | null;
			nextCursor?: string;
		};
		expect(first.blocks.map((b) => b.seq)).toEqual([1, 2]);
		expect(first.prevCursor).toBeNull();
		expect(first.nextCursor).toBe("2");
	});

	test("a turnId tail starts at that turn, unknown turns give NOT_FOUND", async () => {
		const captured: { onTurn?: (n: TurnNotification) => void } = {};
		const conn = testConn();
		const ctx = testCtx(captured, [conn]);
		const result = (await call(ctx, conn, "conversation.tail", { sessionId: SA, turnId: TA2.id })) as {
			turns: Turn[];
			blocks: Block[];
			prevCursor: string | null;
		};
		expect(result.blocks.map((b) => b.seq)).toEqual([3, 4]);
		expect(result.turns.map((t) => t.id)).toEqual([TA2.id]);
		expect(result.prevCursor).toBe("2");
		expect(conn.tailed.has(SA)).toBe(true);
		let thrown: unknown;
		try {
			await call(ctx, conn, "conversation.tail", { sessionId: SA, turnId: ulid() });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(NodeError);
		expect((thrown as NodeError).symbol).toBe("NOT_FOUND");
	});
});

describe("turn subscriptions", () => {
	test("two tailers receive only their own turns, untail stops delivery", async () => {
		const captured: { onTurn?: (n: TurnNotification) => void } = {};
		const connA = testConn();
		const connB = testConn();
		const connC = testConn();
		const ctx = testCtx(captured, [connA, connB, connC]);
		wireTurnStream(ctx);
		if (captured.onTurn === undefined) {
			throw new Error("wireTurnStream did not subscribe");
		}
		await call(ctx, connA, "conversation.tail", { sessionId: SA });
		await call(ctx, connB, "conversation.tail", { sessionId: SB });
		captured.onTurn({ sessionId: SA, block: SESSIONS.get(SA)?.blocks[0] });
		expect(connA.sent).toHaveLength(1);
		expect(connA.sent[0]?.method).toBe("turn");
		expect(connB.sent).toHaveLength(0);
		expect(connC.sent).toHaveLength(0);
		captured.onTurn({ sessionId: SB });
		expect(connB.sent).toHaveLength(1);
		expect(connA.sent).toHaveLength(1);
		// A client tailing neither still gets broadcasts but no turns.
		ctx.hub.broadcast("event", { seq: 1 });
		expect(connC.sent).toEqual([{ method: "event", params: { seq: 1 } }]);
		await call(ctx, connA, "conversation.untail", { sessionId: SA });
		captured.onTurn({ sessionId: SA });
		expect(connA.sent).toHaveLength(2);
	});
});

describe("prompt, cancel, setModel and models.list", () => {
	test("prompt returns the turnId at once and sends nothing itself", async () => {
		acpCalls.length = 0;
		acpPromptReject = undefined;
		const captured: { onTurn?: (n: TurnNotification) => void } = {};
		const conn = testConn();
		const ctx = testCtx(captured, [conn]);
		const result = (await call(ctx, conn, "conversation.prompt", { sessionId: SA, text: "hi" })) as {
			turnId: string;
		};
		expect(typeof result.turnId).toBe("string");
		expect(conn.sent).toEqual([]);
		expect(acpCalls).toEqual([{ op: "prompt", args: [SA, "hi"] }]);
	});

	test("a rejecting ACP stub yields PROVIDER_ERROR, NodeErrors pass through", async () => {
		acpPromptReject = new Error("provider exploded");
		const captured: { onTurn?: (n: TurnNotification) => void } = {};
		const conn = testConn();
		const ctx = testCtx(captured, [conn]);
		let thrown: unknown;
		try {
			await call(ctx, conn, "conversation.prompt", { sessionId: SA, text: "hi" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(NodeError);
		expect((thrown as NodeError).symbol).toBe("PROVIDER_ERROR");
		acpPromptReject = undefined;
		let missing: unknown;
		try {
			await call(ctx, conn, "conversation.prompt", { sessionId: ulid(), text: "hi" });
		} catch (error) {
			missing = error;
		}
		expect((missing as NodeError).symbol).toBe("NOT_FOUND");
	});

	test("cancel, setModel and models.list round-trip", async () => {
		acpCalls.length = 0;
		const captured: { onTurn?: (n: TurnNotification) => void } = {};
		const conn = testConn();
		const ctx = testCtx(captured, [conn]);
		expect(await call(ctx, conn, "conversation.cancel", { sessionId: SA })).toEqual({ sessionId: SA });
		expect(await call(ctx, conn, "conversation.setModel", { sessionId: SA, model: "m2" })).toEqual({
			sessionId: SA,
			model: "m2",
		});
		expect(await call(ctx, conn, "models.list", { provider: "p" })).toEqual({
			models: [{ id: "m1", name: "M1", provider: "p" }],
		});
		expect(acpCalls.map((c) => c.op)).toEqual(["cancel", "setModel", "listModels"]);
	});
});
