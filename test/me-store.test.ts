import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MeDecision, type MeSource, meSourceId, openMeStore, SOL_ROLE, SOL_SESSION_ID } from "../src/me/store.ts";

const original = process.env.NETA_DIR;
const dirs: string[] = [];
function isolated() {
	const dir = mkdtempSync(join(tmpdir(), "neta-me-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	return dir;
}
afterEach(async () => {
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function source(turnId: string, workspaceId = "workspace-A", overrides: Partial<MeSource> = {}): MeSource {
	const draft = {
		id: "",
		workspaceId,
		workspaceName: workspaceId,
		sessionId: `leader-${workspaceId}`,
		actorKind: "leader" as const,
		kind: "message" as const,
		at: "2026-09-23T10:00:00.000Z",
		text: "Need your choice on deployment",
		turnId,
		explicit: true,
		destinationSessionIds: [`leader-${workspaceId}`],
		...overrides,
	};
	return { ...draft, id: meSourceId(draft) };
}
function decision(item: MeSource, overrides: Partial<MeDecision> = {}): MeDecision {
	return {
		action: "surface",
		concernKey: "deployment",
		headline: "Deployment decision",
		summary: "Choose a deployment window",
		evidenceSourceIds: [item.id],
		needsReply: true,
		resolved: false,
		destinationSessionIds: item.destinationSessionIds,
		...overrides,
	};
}

test("machine-global capture deduplicates replay across reopen and preserves pending work", async () => {
	const root = isolated();
	const a = source("turn-1");
	const b = source("turn-2", "workspace-B");
	const first = openMeStore();
	await Promise.all([first.capture(a), openMeStore().capture(a), first.capture(b)]);
	expect((await openMeStore().pendingSources()).map((s) => s.id)).toEqual([a.id, b.id]);
	expect((await readFile(join(root, "me", "state.json"), "utf8")).includes(a.text)).toBe(true);
	expect((await openMeStore().decide(a.id, decision(a)))?.workspaceId).toBe("workspace-A");
	expect((await openMeStore().list()).pending.map((s) => s.id)).toEqual([b.id]);
	expect(await first.capture({ ...a, text: "changed replay body" })).toEqual(a);
	await first.capture({ ...source("turn-3"), privateRuntimePayload: "do-not-persist" } as MeSource);
	expect(await readFile(join(root, "me", "state.json"), "utf8")).not.toContain("do-not-persist");
});

test("groups concern updates, retains evidence and unanswered read cards, hides suppression only from primary feed", async () => {
	isolated();
	const store = openMeStore();
	const a = await store.capture(source("1"));
	const first = await store.decide(a.id, decision(a));
	if (!first) throw new Error("missing first card");
	await store.markRead(first.id);
	expect((await store.list()).cards[0]?.needsReply).toBe(true);
	expect((await store.list()).cards[0]?.readAt).toBeDefined();
	const b = await store.capture(source("2", "workspace-A", { at: "2026-09-23T11:00:00.000Z" }));
	expect(
		store.decide(b.id, decision(b, { action: "suppress", needsReply: false, destinationSessionIds: [] })),
	).rejects.toThrow("unanswered");
	const updated = await store.decide(b.id, decision(b, { action: "update", summary: "New deployment constraint" }));
	expect(updated).toMatchObject({ id: first.id, version: 2, sourceIds: [a.id, b.id] });
	expect(updated?.readAt).toBeUndefined();
	expect(await store.decide(b.id, decision(b))).toEqual(updated);
	const c = await store.capture(source("3", "workspace-B"));
	const suppressed = await store.decide(
		c.id,
		decision(c, { action: "suppress", needsReply: false, destinationSessionIds: [] }),
	);
	expect(suppressed?.workspaceId).toBe("workspace-B");
	expect((await store.list()).cards).toHaveLength(1);
	expect((await store.list({ includeSuppressed: true })).cards).toHaveLength(2);
});

test("invalid model evidence or destination never checkpoints a pending source", async () => {
	isolated();
	const store = openMeStore();
	const a = await store.capture(source("one"));
	const other = await store.capture(source("two", "workspace-B"));
	expect(store.decide(a.id, decision(a, { evidenceSourceIds: [a.id, other.id] }))).rejects.toThrow("evidence");
	expect(store.decide(a.id, decision(a, { destinationSessionIds: ["unrelated-private-session"] }))).rejects.toThrow(
		"destination",
	);
	expect(store.decide(a.id, decision(a, { action: "suppress" }))).rejects.toThrow("pending question");
	expect((await openMeStore().pendingSources()).map((s) => s.id)).toContain(a.id);
	expect(store.capture(source("agent", "workspace-A", { actorKind: "agent", explicit: false }))).rejects.toThrow(
		"unrelated agent",
	);
});

test("reply queue preserves exact text, selected destination, durable receipt and terminal uncertainty", async () => {
	isolated();
	const store = openMeStore();
	const a = await store.capture(
		source("permission", "workspace-A", {
			kind: "permission",
			eventId: "request-1",
			destinationSessionIds: ["leader-workspace-A", "mission-1"],
		}),
	);
	const card = await store.decide(a.id, decision(a));
	if (!card) throw new Error("missing reply card");
	const input = {
		idempotencyKey: "send-1",
		cardId: card.id,
		text: "Yes, exactly this.\n",
		destinationSessionId: "mission-1",
	};
	const queued = await store.queueReply(input);
	expect(queued.text).toBe(input.text);
	expect(await openMeStore().queueReply(input)).toEqual(queued);
	expect(store.queueReply({ ...input, text: "different" })).rejects.toThrow("idempotency");
	expect(store.queueReply({ ...input, idempotencyKey: "send-2", destinationSessionId: "other" })).rejects.toThrow(
		"destination",
	);
	await store.updateReply(queued.id, "delivering");
	const uncertain = await openMeStore().updateReply(queued.id, "uncertain", "transport disconnected");
	expect(uncertain.receipt).toBe("transport disconnected");
	expect(store.updateReply(queued.id, "delivering")).rejects.toThrow("cannot be replayed");
	expect(await store.queueReply(input)).toEqual(uncertain);
});

test("pagination is stable for unchanged cards and source identity cannot be spoofed", async () => {
	isolated();
	const store = openMeStore();
	for (let i = 0; i < 3; i++) {
		const item = await store.capture(source(`turn-${i}`, `workspace-${i}`));
		await store.decide(item.id, decision(item, { concernKey: `concern-${i}`, needsReply: false }));
	}
	const first = await store.list({ limit: 1 });
	expect(first.hasMore).toBe(true);
	const cursor = first.cards[0]?.id;
	if (!cursor) throw new Error("missing page cursor");
	expect((await store.list({ limit: 1, after: cursor })).cards[0]?.id).not.toBe(cursor);
	expect(store.capture({ ...source("new"), id: "fabricated" })).rejects.toThrow("origin");
});

test("event identity does not require a turn and retrieval survives restart", async () => {
	isolated();
	const eventOnly = source("ignored", "workspace-A", {
		kind: "event",
		turnId: undefined,
		eventId: "evt-9",
	});
	expect(eventOnly.turnId).toBeUndefined();
	const store = openMeStore();
	const saved = await store.capture(eventOnly);
	expect(saved.eventId).toBe("evt-9");
	expect(saved.turnId).toBeUndefined();
	expect(await openMeStore().getSource(saved.id)).toEqual(saved);
	expect(await openMeStore().getSource("missing")).toBeUndefined();
	const card = await store.decide(
		saved.id,
		decision(saved, { action: "suppress", needsReply: false, destinationSessionIds: [] }),
	);
	if (!card) throw new Error("missing suppressed card");
	expect(await openMeStore().getCard(card.id)).toMatchObject({
		action: "suppress",
		evidenceSourceIds: [saved.id],
		sourceIds: [saved.id],
	});
});

test("checkpoint replay is monotonic across restart and does not rewind", async () => {
	isolated();
	const store = openMeStore();
	expect(await store.getCheckpoint()).toEqual({ workspaces: [] });
	const advanced = await store.setCheckpoint({
		workspaces: [{ workspaceId: "workspace-A", eventSeq: 5, turns: [{ sessionId: "leader-A", turnId: "t1" }] }],
	});
	expect(await openMeStore().setCheckpoint(advanced)).toEqual(advanced);
	expect(
		await openMeStore().setCheckpoint({
			workspaces: [{ workspaceId: "workspace-A", eventSeq: 4, turns: [{ sessionId: "leader-A", turnId: "t1" }] }],
		}),
	).toEqual(advanced);
	expect(
		(
			await openMeStore().setCheckpoint({
				workspaces: [{ workspaceId: "workspace-A", eventSeq: 7, turns: [{ sessionId: "leader-A", turnId: "t2" }] }],
			})
		).workspaces[0],
	).toEqual({
		workspaceId: "workspace-A",
		eventSeq: 7,
		turns: [
			{ sessionId: "leader-A", turnId: "t1" },
			{ sessionId: "leader-A", turnId: "t2" },
		],
	});
});

test("Sol transcript and routes stay separate from card replies and do not alias a leader", async () => {
	isolated();
	const store = openMeStore();
	const sol = await store.solIdentity();
	expect(sol).toMatchObject({ id: "sol", role: SOL_ROLE, title: "Sol" });
	expect(sol.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	expect(sol.sessionId).not.toBe(SOL_SESSION_ID);
	expect(sol.role).not.toBe("leader");
	expect(await openMeStore().solIdentity()).toEqual(sol);
	const user = await store.appendSolTurn({
		idempotencyKey: "user-1",
		author: "user",
		text: "Ask mission 2 to retry\n",
		at: "2026-09-23T12:00:00.000Z",
	});
	expect(await openMeStore().appendSolTurn({ idempotencyKey: "user-1", author: "user", text: user.text })).toEqual(
		user,
	);
	expect(store.appendSolTurn({ idempotencyKey: "user-1", author: "user", text: "rewritten" })).rejects.toThrow(
		"idempotency",
	);
	const item = await store.capture(source("origin"));
	const route = await store.queueRoute({
		idempotencyKey: "route-1",
		solTurnId: user.id,
		instruction: user.text,
		destinationSessionIds: ["mission-2"],
		provenanceSourceIds: [item.id],
	});
	expect(route.instruction).toBe("Ask mission 2 to retry\n");
	expect(await store.getReply(route.id)).toBeUndefined();
	expect(
		await openMeStore().queueRoute({
			idempotencyKey: "route-1",
			solTurnId: user.id,
			instruction: user.text,
			destinationSessionIds: ["mission-2"],
			provenanceSourceIds: [item.id],
		}),
	).toEqual(route);
	await store.updateRoute(route.id, "delivering");
	const uncertain = await openMeStore().updateRoute(route.id, "uncertain", "delivery unknown");
	expect(store.updateRoute(route.id, "queued")).rejects.toThrow("cannot be replayed");
	expect(await openMeStore().getRoute(route.id)).toEqual(uncertain);
	expect(
		store.queueRoute({
			idempotencyKey: "route-2",
			solTurnId: user.id,
			instruction: "rewritten",
			destinationSessionIds: ["mission-2"],
			provenanceSourceIds: [item.id],
		}),
	).rejects.toThrow("exact user instruction");
	expect((await store.listSolTurns()).turns.map((turn) => turn.id)).toEqual([user.id]);
});

test("version 1 documents gain checkpoint and Sol fields without dropping pending questions", async () => {
	const root = isolated();
	const item = source("legacy");
	await mkdir(join(root, "me"), { recursive: true });
	await writeFile(
		join(root, "me", "state.json"),
		`${JSON.stringify({
			version: 1,
			sources: [item],
			decidedSourceIds: [],
			cards: [],
			replies: [],
		})}\n`,
	);
	const store = openMeStore();
	expect(await store.getSource(item.id)).toEqual(item);
	expect(await store.pendingSources()).toEqual([item]);
	const card = await store.decide(item.id, decision(item));
	if (!card) throw new Error("missing legacy card");
	await store.markRead(card.id);
	expect((await openMeStore().getCard(card.id))?.needsReply).toBe(true);
	expect(await store.getCheckpoint()).toEqual({ workspaces: [] });
});

test("legacy logical Sol ids are replaced by a real session id", async () => {
	const root = isolated();
	await mkdir(join(root, "me"), { recursive: true });
	await writeFile(
		join(root, "me", "state.json"),
		`${JSON.stringify({
			version: 2,
			sources: [],
			decidedSourceIds: [],
			cards: [],
			replies: [],
			checkpoint: { workspaces: [] },
			sol: {
				id: "sol",
				role: SOL_ROLE,
				title: "Sol",
				sessionId: SOL_SESSION_ID,
				createdAt: "2026-09-23T10:00:00.000Z",
			},
			solTurns: [],
			routes: [],
		})}\n`,
	);
	const sol = await openMeStore().solIdentity();
	expect(sol.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	expect(sol.sessionId).not.toBe(SOL_SESSION_ID);
	expect(await openMeStore().solIdentity()).toEqual(sol);
});
