import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessage, Turn } from "../src/core/types.ts";
import type { FilterInput } from "../src/me/curator.ts";
import { createRuntimeMeClassifier } from "../src/me/runtime-curator.ts";
import { openMeStore } from "../src/me/store.ts";
import { createFilterToolBridge } from "../src/node/handlers-me.ts";
import type { NodeContext, NodeRuntime } from "../src/node/server.ts";

const original = process.env.NETA_DIR;
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "neta-filter-tool-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const store = openMeStore();
	const identity = await store.filterIdentity("w");
	const source = await store.capture({
		id: "",
		workspaceId: "w",
		workspaceName: "Workspace",
		sessionId: "coordinator",
		actorKind: "leader",
		kind: "message",
		at: new Date().toISOString(),
		text: "The corrected Jev report is ready.",
		turnId: "coordinator-turn",
	});
	const filterInput: FilterInput = {
		source,
		relatedSources: [],
		context: {},
	};
	return { store, identity, source, filterInput };
}

test("Filter receives a plain Coordinator reply and can finish without sending", async () => {
	const { store, identity, filterInput } = await fixture();
	let listener: ((notification: { sessionId: string; turn?: Turn }) => void) | undefined;
	let submitted = "";
	const inbox: InboxMessage[] = [];
	const classify = createRuntimeMeClassifier({
		store,
		sessionId: identity.sessionId,
		runtime: {
			send: async (sessionId, text, _attachments, provenance) => {
				submitted = text;
				const item = {
					id: "inbox",
					sessionId,
					createdAt: new Date().toISOString(),
					text,
					attachments: [],
					status: "delivered" as const,
					turnId: "filter-turn",
					...provenance,
				};
				inbox.push(item);
				queueMicrotask(() =>
					listener?.({
						sessionId,
						turn: {
							id: "filter-turn",
							sessionId,
							role: "user",
							startedAt: "now",
							endedAt: "now",
							finalReply: "",
						},
					}),
				);
				return item;
			},
			listInbox: async () => inbox,
			onTurn: (fn) => {
				listener = fn;
			},
		},
		timeoutMs: 1000,
	});
	expect(await classify(filterInput)).toEqual({ action: "suppress", reason: "Filter chose not to send an update" });
	expect(submitted).toContain("The corrected Jev report is ready.");
	expect(submitted).not.toContain("Return JSON");
	expect(submitted).not.toContain(filterInput.source.id);
	expect(inbox[0]?.sourceId).toBe(`filter-decision:${filterInput.source.id}`);
});

test("a discarded Filter prompt fails immediately and gets a fresh retry identity", async () => {
	const { store, identity, filterInput } = await fixture();
	const sourceIds: string[] = [];
	const classify = createRuntimeMeClassifier({
		store,
		sessionId: identity.sessionId,
		runtime: {
			send: async (sessionId, text, attachments, provenance) => {
				sourceIds.push(provenance.sourceId ?? "");
				return {
					id: "discarded",
					sessionId,
					createdAt: new Date().toISOString(),
					text,
					attachments,
					status: "discarded" as const,
					...provenance,
				};
			},
			listInbox: async () => [],
			onTurn: () => undefined,
		},
		timeoutMs: 1000,
	});
	await expect(classify(filterInput)).rejects.toThrow("discarded before delivery");
	await expect(classify(filterInput)).rejects.toThrow("discarded before delivery");
	expect(sourceIds).toEqual([
		`filter-decision:${filterInput.source.id}`,
		`filter-decision:${filterInput.source.id}:1`,
	]);
});

test("Filter text promising delivery without a tool call is a retryable failure", async () => {
	const { store, identity, filterInput } = await fixture();
	let listener: ((notification: { sessionId: string; turn?: Turn }) => void) | undefined;
	const inbox: InboxMessage[] = [];
	const classify = createRuntimeMeClassifier({
		store,
		sessionId: identity.sessionId,
		runtime: {
			send: async (sessionId, text, _attachments, provenance) => {
				const turnId = `filter-turn-${inbox.length + 1}`;
				const item: InboxMessage = {
					id: "inbox",
					sessionId,
					createdAt: new Date().toISOString(),
					text,
					attachments: [],
					status: "delivered",
					turnId,
					...provenance,
				};
				inbox.push(item);
				queueMicrotask(() =>
					listener?.({
						sessionId,
						turn: {
							id: turnId,
							sessionId,
							role: "user",
							startedAt: "now",
							endedAt: "now",
							finalReply: "I will send the update.\n\n{}",
						},
					}),
				);
				return item;
			},
			listInbox: async () => inbox,
			onTurn: (fn) => {
				listener = fn;
			},
		},
		timeoutMs: 1000,
	});
	await expect(classify(filterInput)).rejects.toThrow("no update was delivered");
	expect((await store.getNotice(filterInput.source.id))?.state).toBe("awaiting filter");
	expect((await store.getNotice(filterInput.source.id))?.retryGeneration).toBe(1);
	await expect(classify(filterInput)).rejects.toThrow("no update was delivered");
	expect(inbox.map((item) => item.sourceId)).toEqual([
		`filter-decision:${filterInput.source.id}`,
		`filter-decision:${filterInput.source.id}:1`,
	]);
});

test("only a no-tool suppression can be requeued for recovery", async () => {
	const { store, source } = await fixture();
	await store.decide([source.id], { action: "suppress", reason: "Filter chose not to send an update" });
	expect((await store.retryFilterDecision(source.id)).state).toBe("awaiting filter");
	expect((await store.getNotice(source.id))?.decision).toBeUndefined();
	expect((await store.getNotice(source.id))?.retryGeneration).toBe(1);
	await expect(store.retryFilterDecision(source.id)).rejects.toThrow("Only an undelivered Filter decision");
	await store.decide([source.id], { action: "suppress", reason: "Chat reset" });
	await expect(store.retryFilterDecision(source.id)).rejects.toThrow("Only an undelivered Filter decision");
});

test("send_message saves a Filter decision only during its Coordinator turn", async () => {
	const { store, identity, source } = await fixture();
	let activeTurn = "context-turn";
	const inbox: InboxMessage[] = [
		{
			id: "decision-inbox",
			sessionId: identity.sessionId,
			createdAt: new Date().toISOString(),
			text: source.text,
			attachments: [],
			status: "delivered",
			turnId: "decision-turn",
			readerDirected: false,
			sourceId: `filter-decision:${source.id}:1`,
		},
	];
	const runtime = {
		runtimeDiagnostics: async () => ({ turnId: activeTurn }),
		listInbox: async () => inbox,
	} as unknown as NodeRuntime;
	const bridge = createFilterToolBridge({
		actorId: identity.sessionId,
		context: () => ({ runtime }) as unknown as NodeContext,
	});
	expect(bridge.tools.map((tool) => tool.name)).toEqual(["send_message"]);
	await expect(bridge.call("send_message", { text: "Jev is active." })).rejects.toThrow(
		"not one Coordinator decision turn",
	);
	expect((await store.getNotice(source.id))?.state).toBe("awaiting filter");
	activeTurn = "decision-turn";
	expect((await bridge.call("send_message", { text: "Jev is active." })).isError).toBe(false);
	expect((await store.getNotice(source.id))?.decision).toEqual({
		action: "send",
		reason: "Filter sent an update",
		text: "Jev is active.",
	});
	await expect(bridge.call("send_message", { text: "Duplicate" })).rejects.toThrow("already handled");
});

test("a tool call becomes the durable decision after the native Filter turn ends", async () => {
	const { store, identity, filterInput } = await fixture();
	let listener: ((notification: { sessionId: string; turn?: Turn }) => void) | undefined;
	const inbox: InboxMessage[] = [];
	const runtime = {
		send: async (sessionId: string, text: string, _attachments: [], provenance: { sourceId?: string }) => {
			const item: InboxMessage = {
				id: "decision-inbox",
				sessionId,
				createdAt: new Date().toISOString(),
				text,
				attachments: [],
				status: "delivered",
				turnId: "decision-turn",
				readerDirected: false,
				...provenance,
			};
			inbox.push(item);
			return item;
		},
		listInbox: async () => inbox,
		runtimeDiagnostics: async () => ({ turnId: "decision-turn" }),
		onTurn: (fn: typeof listener) => {
			listener = fn;
		},
	} as unknown as NodeRuntime;
	const bridge = createFilterToolBridge({
		actorId: identity.sessionId,
		context: () => ({ runtime }) as unknown as NodeContext,
	});
	const classify = createRuntimeMeClassifier({ store, sessionId: identity.sessionId, runtime, timeoutMs: 1000 });
	let settled = false;
	const decision = classify(filterInput).finally(() => {
		settled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect((await bridge.call("send_message", { text: "Jev report is ready." })).isError).toBe(false);
	listener?.({
		sessionId: identity.sessionId,
		turn: {
			id: "decision-turn",
			sessionId: identity.sessionId,
			role: "user",
			startedAt: "now",
			endedAt: "now",
		},
	});
	expect(settled).toBe(false);
	expect(await decision).toEqual({ action: "send", reason: "Filter sent an update", text: "Jev report is ready." });
});
