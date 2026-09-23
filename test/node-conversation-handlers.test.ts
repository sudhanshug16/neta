import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Agent, Block, Leader, Mission, SessionId, Turn, Workspace } from "../src/core/types.ts";
import { conversationHandlers, restoreNativeOwner, wireTurnStream } from "../src/node/handlers-conversation.ts";
import { NodeError, type TurnNotification } from "../src/node/protocol.ts";
import type { Connection, NodeContext, NodeRuntime, NodeStore } from "../src/node/server.ts";

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

function stubAcp(captured: { onTurn?: (n: TurnNotification) => void }): NodeRuntime {
	const known = new Set(SESSIONS.keys());
	const check = (id: SessionId): void => {
		if (!known.has(id)) {
			throw new NodeError("NOT_FOUND", `no such session: ${id}`);
		}
	};
	return {
		createSession: () => Promise.reject(new Error("not implemented in this test")),
		ensureSession: () => Promise.reject(new Error("not implemented in this test")),
		prompt: (id, text, _attachments, provenance) => {
			acpCalls.push({ op: "prompt", args: [id, text, provenance] });
			if (acpPromptReject !== undefined) {
				return Promise.reject(acpPromptReject);
			}
			check(id);
			return Promise.resolve(ulid());
		},
		capabilities: (id) => {
			check(id);
			return { image: true, embeddedContext: true };
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
		listLeaders: () => [],
		listMissions: () => missing(),
		listAgents: () => [],
		getWorkspace: () => undefined,
		getLeader: () => undefined,
		getMission: () => undefined,
		getAgent: () => undefined,
		putWorkspace: () => Promise.reject(new Error("not implemented in this test")),
		putAgent: () => Promise.reject(new Error("not implemented in this test")),
		putLeader: () => Promise.resolve(),
		compact: () => Promise.reject(new Error("not implemented in this test")),
		appendEvent: () => Promise.reject(new Error("not implemented in this test")),
		listEvents: () => Promise.reject(new Error("not implemented in this test")),
		tailConversation: (id, query) => Promise.resolve(stubTail(id, query)),
	};
}

function testCtx(captured: { onTurn?: (n: TurnNotification) => void }, conns: TestConn[]): NodeContext {
	return {
		store: stubStore(),
		runtime: stubAcp(captured),
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
		expect(mid.blocks.map((b) => b.seq)).toEqual([5, 6, 7]);
		expect(mid.prevCursor).toBe("4");
		expect(mid.nextCursor).toBe("7");
		const first = (await call(ctx, conn, "conversation.tail", {
			sessionId: SC,
			limit: 3,
			direction: "backward",
			cursor: "4",
		})) as {
			blocks: Block[];
			prevCursor: string | null;
			nextCursor?: string;
		};
		expect(first.blocks.map((b) => b.seq)).toEqual([2, 3, 4]);
		expect(first.prevCursor).toBe("1");
		expect(first.nextCursor).toBe("4");
		const oldest = (await call(ctx, conn, "conversation.tail", {
			sessionId: SC,
			limit: 3,
			direction: "backward",
			cursor: "1",
		})) as { blocks: Block[]; prevCursor: string | null };
		expect(oldest.blocks.map((block) => block.seq)).toEqual([1]);
		expect(oldest.prevCursor).toBeNull();
		expect([...oldest.blocks, ...first.blocks, ...mid.blocks, ...last.blocks].map((block) => block.seq)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
		]);
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

test("a healthy native Pi leader transitions to ACP in place and remains promptable", async () => {
	const leader: Leader = {
		workspaceId: "folder:test",
		machineId: "machine-test",
		name: "Test Leader",
		sessionId: SA,
		provider: "pi",
		model: "pi-model",
		mode: "lead",
		modeSince: "2026-02-01T00:00:00.000Z",
		modeActiveMs: 0,
		state: "idle",
	};
	const workspace: Workspace = {
		id: "folder:test",
		kind: "folder",
		name: "test",
		roots: [{ machineId: "machine-test", path: "/tmp/test-workspace" }],
		createdAt: "2026-02-01T00:00:00.000Z",
	};
	let saved = leader;
	const created: unknown[] = [];
	const handoffs: string[] = [];
	let closed = "";
	const captured: { onTurn?: (n: TurnNotification) => void } = {};
	const ctx = testCtx(captured, [testConn()]);
	const base = stubAcp(captured);
	ctx.store = {
		...stubStore(),
		machine: () => ({ id: "machine-test", name: "test", createdAt: "2026-02-01T00:00:00.000Z" }),
		listLeaders: () => [saved],
		getWorkspace: () => workspace,
		putLeader: async (next) => {
			saved = next;
		},
	};
	ctx.runtime = {
		...base,
		listProviders: () => [{ id: "codex", label: "Codex", defaultModel: "codex-model", available: true }],
		createSession: async (request) => {
			created.push(request);
			return { sessionId: request.sessionId ?? SA, provider: request.provider, model: request.model };
		},
		setPendingHandoff: async (_sessionId, handoff) => {
			handoffs.push(handoff);
		},
		switchProvider: async () => {
			throw new Error("native Pi must not use ACP switchProvider");
		},
	};
	ctx.pi = {
		closeSession: (sessionId) => {
			closed = sessionId;
		},
	} as NonNullable<NodeContext["pi"]>;
	const conn = testConn();
	expect(await call(ctx, conn, "conversation.setProvider", { sessionId: SA, provider: "pi" })).toEqual({
		sessionId: SA,
		provider: "pi",
		model: "pi-model",
		contextReset: false,
	});
	const switched = await call(ctx, conn, "conversation.setProvider", {
		sessionId: SA,
		provider: "codex",
		handoff: "NATIVE HANDOFF",
	});
	expect(switched).toEqual({ sessionId: SA, provider: "codex", model: "codex-model", contextReset: true });
	expect(created).toHaveLength(1);
	expect(handoffs).toEqual(["NATIVE HANDOFF"]);
	expect((created[0] as { workspaceId: string; cwd: string }).workspaceId).toBe("folder:test");
	expect((created[0] as { cwd: string }).cwd).toBe("/tmp/test-workspace");
	expect(closed).toBe(SA);
	expect(saved.provider).toBe("codex");
	expect(saved.sessionId).toBe(SA);
	await call(ctx, conn, "conversation.prompt", { sessionId: SA, text: "after transition" });
	expect(acpCalls.at(-1)?.op).toBe("prompt");
});

test("a failed native Pi to ACP transition leaves the Pi leader usable", async () => {
	const leader: Leader = {
		workspaceId: "folder:failed",
		machineId: "machine-failed",
		name: "Test Leader",
		sessionId: SB,
		provider: "pi",
		model: "pi-model",
		mode: "lead",
		modeSince: "2026-02-01T00:00:00.000Z",
		modeActiveMs: 0,
		state: "idle",
	};
	const ctx = testCtx({}, [testConn()]);
	ctx.store = {
		...stubStore(),
		machine: () => ({ id: "machine-failed", name: "test", createdAt: "2026-02-01T00:00:00.000Z" }),
		listLeaders: () => [leader],
		getWorkspace: () => ({
			id: "folder:failed",
			kind: "folder",
			name: "failed",
			roots: [{ machineId: "machine-failed", path: "/tmp/failed" }],
			createdAt: "2026-02-01T00:00:00.000Z",
		}),
	};
	const base = stubAcp({});
	ctx.runtime = {
		...base,
		listProviders: () => [{ id: "codex", label: "Codex", defaultModel: "codex", available: true }],
		createSession: async () => {
			throw new Error("fake ACP unavailable");
		},
	};
	let closed = false;
	ctx.pi = {
		closeSession: () => {
			closed = true;
		},
	} as unknown as NonNullable<NodeContext["pi"]>;
	await expect(
		call(ctx, testConn(), "conversation.setProvider", { sessionId: SB, provider: "codex" }),
	).rejects.toThrow("fake ACP unavailable");
	expect(closed).toBe(false);
	expect(leader.provider).toBe("pi");
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
		expect(acpCalls).toEqual([{ op: "prompt", args: [SA, "hi", { readerDirected: true }] }]);
	});

	test("attachment prompts are capability checked and bounded", async () => {
		acpCalls.length = 0;
		const captured: { onTurn?: (n: TurnNotification) => void } = {};
		const conn = testConn();
		const ctx = testCtx(captured, [conn]);
		const attachment = { id: "one", kind: "image", name: "shot.png", mimeType: "image/png", dataBase64: "aGk=" };
		const result = await call(ctx, conn, "conversation.prompt", {
			sessionId: SA,
			text: "",
			attachments: [attachment],
		});
		expect(result).toHaveProperty("turnId");
		expect(await call(ctx, conn, "conversation.capabilities", { sessionId: SA })).toEqual({
			image: true,
			embeddedContext: true,
		});
		await expect(
			call(ctx, conn, "conversation.prompt", {
				sessionId: SA,
				text: "",
				attachments: [{ ...attachment, dataBase64: "%%%" }],
			}),
		).rejects.toMatchObject({ symbol: "INVALID_PARAMS" });
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

test("leader reset only rebinds the chat and keeps missions and worker sessions", async () => {
	const ctx = testCtx({}, []);
	const at = "2026-02-01T00:00:00.000Z";
	let leader: Leader = {
		workspaceId: "w",
		machineId: "m",
		name: "Leader",
		sessionId: SA,
		provider: "opencode",
		model: "model",
		mode: "lead",
		modeSince: at,
		modeActiveMs: 0,
		state: "idle",
	};
	const mission: Mission = {
		id: "mission",
		workspaceId: "w",
		machineId: "m",
		number: 1,
		name: "Existing mission",
		objective: "Keep working",
		changes: [],
		lead: { kind: "agent", agentId: "worker" },
		agentIds: ["worker"],
		access: "readOnly",
		state: "running",
		createdAt: at,
	};
	const worker: Agent = {
		id: "worker",
		missionId: mission.id,
		workspaceId: "w",
		name: "Worker",
		task: "Keep working",
		access: "readOnly",
		provider: "opencode",
		model: "model",
		skills: [],
		sessionId: SB,
		canSpawn: true,
		state: "running",
		startedAt: at,
	};
	const before = JSON.stringify({ mission, worker });
	ctx.store = {
		...ctx.store,
		machine: () => ({ id: "m", name: "Machine", createdAt: at }),
		getWorkspace: () => ({
			id: "w",
			kind: "folder",
			name: "Workspace",
			roots: [{ machineId: "m", path: "/tmp/neta-reset-contract" }],
			createdAt: at,
		}),
		listLeaders: () => [leader],
		listAgents: () => [worker],
		listMissions: () => [mission],
		getMission: () => mission,
		putLeader: async (next) => {
			leader = next;
		},
		putAgent: async () => {
			throw new Error("reset must not modify worker records");
		},
	};
	ctx.runtime.resetSession = async (id, brief, rebind) => {
		expect(id).toBe(SA);
		expect(brief).not.toContain("Old chat marker");
		const next = { sessionId: SC, provider: "opencode", model: "model" };
		await rebind(next);
		return next;
	};
	ctx.store.tailConversation = async () => {
		throw new Error("reset must not copy old transcript");
	};
	await call(ctx, testConn(), "conversation.reset", { sessionId: SA });
	expect(leader.sessionId).toBe(SC);
	expect(leader.name).toBe("Leader");
	expect(JSON.stringify({ mission, worker })).toBe(before);
});

test("a saved mission-leader tab resumes its exact session without prompting", async () => {
	const ctx = testCtx({}, [testConn()]);
	const agent: Agent = {
		id: "saved-agent",
		sessionId: SA,
		workspaceId: "w",
		missionId: "m",
		name: "Tarn",
		task: "inspect",
		provider: "opencode",
		model: "google/flash",
		access: "readOnly",
		canSpawn: true,
		skills: [],
		state: "interrupted",
		startedAt: "2026-02-01T00:00:00.000Z",
	};
	ctx.store = {
		...stubStore(),
		machine: () => ({ id: "host", name: "host", createdAt: agent.startedAt }),
		listAgents: () => [agent],
		getWorkspace: () => ({
			id: "w",
			name: "project",
			kind: "folder",
			roots: [{ machineId: "host", path: "/project" }],
			createdAt: agent.startedAt,
		}),
		getMission: () => ({
			id: "m",
			number: 1,
			workspaceId: "w",
			machineId: "host",
			name: "Review",
			objective: "inspect",
			changes: [],
			agentIds: [agent.id],
			lead: { kind: "agent", agentId: agent.id },
			access: "readOnly",
			state: "running",
			createdAt: agent.startedAt,
		}),
	};
	const requests: Parameters<NodeRuntime["ensureSession"]>[0][] = [];
	ctx.runtime = {
		...stubAcp({}),
		nativeAttachment: () => {
			throw new NodeError("NOT_FOUND", `no such session: ${SA}`);
		},
		ensureSession: async (request) => {
			requests.push(request);
			return { sessionId: SA, provider: "opencode", model: agent.model };
		},
		prompt: async () => {
			throw new Error("opening a tab must not prompt");
		},
	};
	await Promise.all([restoreNativeOwner(ctx, SA), restoreNativeOwner(ctx, SA)]);
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		sessionId: SA,
		actorId: agent.id,
		allowFresh: false,
		cwd: "/project",
		unsandboxed: true,
	});
	expect(agent.state).toBe("interrupted");
	ctx.runtime.ensureSession = async () => {
		throw new Error("provider cannot resume");
	};
	await expect(restoreNativeOwner(ctx, SA)).rejects.toThrow("provider cannot resume");
});

test("a removed mission worktree is reported before launching its saved session", async () => {
	const ctx = testCtx({}, []);
	const at = "2026-02-01T00:00:00.000Z";
	const path = `/tmp/neta-removed-${ulid()}`;
	ctx.store = {
		...stubStore(),
		machine: () => ({ id: "host", name: "host", createdAt: at }),
		listAgents: () => [
			{
				id: "saved",
				sessionId: SA,
				workspaceId: "w",
				missionId: "m",
				name: "Tarn",
				task: "inspect",
				provider: "opencode",
				model: "model",
				access: "readOnly",
				canSpawn: true,
				skills: [],
				state: "interrupted",
				startedAt: at,
			},
		],
		getWorkspace: () => ({
			id: "w",
			name: "project",
			kind: "folder",
			roots: [{ machineId: "host", path: "/project" }],
			createdAt: at,
		}),
		getMission: () => ({
			id: "m",
			number: 1,
			workspaceId: "w",
			machineId: "host",
			name: "Review",
			objective: "inspect",
			changes: [],
			agentIds: ["saved"],
			lead: { kind: "agent", agentId: "saved" },
			access: "readOnly",
			state: "running",
			createdAt: at,
			worktree: { path, branch: "review", base: "main", provider: "worktrunk" },
		}),
	};
	let launches = 0;
	ctx.runtime = {
		...stubAcp({}),
		nativeAttachment: () => {
			throw new NodeError("NOT_FOUND", "not live");
		},
		ensureSession: async () => {
			launches++;
			throw new Error("must not launch");
		},
	};
	await expect(restoreNativeOwner(ctx, SA)).rejects.toThrow("worktree is no longer available");
	expect(launches).toBe(0);
});
