import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeCurator, type MeClassifier } from "../src/me/curator.ts";
import { type MeDecision, type MeSource, meSourceId, openMeStore } from "../src/me/store.ts";

const original = process.env.NETA_DIR;
const dirs: string[] = [];
afterEach(async () => {
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function isolate() {
	const dir = mkdtempSync(join(tmpdir(), "neta-curator-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
}
function source(turnId: string, overrides: Partial<MeSource> = {}): MeSource {
	const draft = {
		id: "",
		workspaceId: "one",
		workspaceName: "One",
		sessionId: "leader-1",
		actorKind: "leader" as const,
		kind: "message" as const,
		at: "2026-09-23T10:00:00.000Z",
		text: "Question?",
		turnId,
		explicit: true,
		destinationSessionIds: ["leader-1"],
		...overrides,
	};
	return { ...draft, id: meSourceId(draft) };
}
function decision(item: MeSource): MeDecision {
	return {
		action: "surface",
		concernKey: "question",
		headline: "A question",
		summary: "Answer the question",
		evidenceSourceIds: [item.id],
		needsReply: true,
		resolved: false,
		destinationSessionIds: [item.sessionId],
	};
}

test("classifier failure remains pending across restart; later valid decision checkpoints once", async () => {
	isolate();
	const store = openMeStore();
	const item = await store.capture(source("one"));
	const unavailable: MeClassifier = async () => {
		throw new Error("model unavailable; confidential raw output");
	};
	expect(await createMeCurator({ store, classify: unavailable }).run()).toMatchObject({
		processed: [],
		pending: 1,
		failed: [item.id],
	});
	const reopened = openMeStore();
	let calls = 0;
	const curator = createMeCurator({
		store: reopened,
		classify: async ({ source: current, instructions }) => {
			calls++;
			expect(instructions).toContain("Suppress redundant");
			return decision(current);
		},
	});
	expect((await curator.run()).pending).toBe(0);
	expect((await curator.run()).processed).toEqual([]);
	expect(calls).toBe(1);
});

test("malformed classification cannot discard source; suppression remains inspectable", async () => {
	isolate();
	const store = openMeStore();
	const item = await store.capture(source("one"));
	const invalid = createMeCurator({
		store,
		classify: async () => ({ ...decision(item), evidenceSourceIds: ["invented"] }),
	});
	expect((await invalid.run()).failed).toEqual([item.id]);
	expect(await store.pendingSources()).toHaveLength(1);
	const valid = createMeCurator({
		store,
		classify: async () => ({ ...decision(item), action: "suppress", needsReply: false, destinationSessionIds: [] }),
	});
	expect((await valid.run()).pending).toBe(0);
	expect((await store.list()).cards).toEqual([]);
	expect((await store.list({ includeSuppressed: true })).cards[0]?.sourceIds).toEqual([item.id]);
});

test("bounded curator drain processes a 25-source restart backlog and stops when only failed sources remain", async () => {
	isolate();
	const store = openMeStore();
	const items = await Promise.all(Array.from({ length: 25 }, (_, index) => store.capture(source(`backlog-${index}`))));
	expect(items).toHaveLength(25);
	let calls = 0;
	const curator = createMeCurator({
		store,
		classify: async ({ source: current }) => {
			calls += 1;
			return decision(current);
		},
	});
	const partial = await curator.drain(20, 1);
	expect(partial.processed).toHaveLength(20);
	expect(partial.pending).toBe(5);
	const afterRestart = createMeCurator({
		store: openMeStore(),
		classify: async ({ source: current }) => decision(current),
	});
	const resumed = await afterRestart.drain(20, 5);
	expect(resumed.processed).toHaveLength(5);
	expect(resumed.pending).toBe(0);
	expect((await store.list({ includeSuppressed: true, limit: 30 })).cards[0]?.sourceIds).toHaveLength(25);
	expect(calls).toBe(20);

	const pending = await Promise.all(Array.from({ length: 3 }, (_, index) => store.capture(source(`broken-${index}`))));
	let failures = 0;
	const unavailable = createMeCurator({
		store,
		classify: async () => {
			failures += 1;
			throw new Error("model unavailable");
		},
	});
	const stalled = await unavailable.drain(20, 5);
	expect(stalled.processed).toHaveLength(0);
	expect(stalled.pending).toBe(3);
	expect(stalled.failed).toEqual(pending.map((item) => item.id));
	expect(failures).toBe(3);
});

test("routine evidence defers with a durable deadline, while urgent failures fall back after repeated model errors", async () => {
	isolate();
	const store = openMeStore();
	const routine = await store.capture(source("routine"));
	const until = new Date(Date.now() + 60_000).toISOString();
	const deferred = await createMeCurator({
		store,
		classify: async () => ({ action: "defer", concernKey: "routine", reason: "Wait for mission closeout", until }),
	}).run();
	expect(deferred).toMatchObject({ processed: [], pending: 0, failed: [] });
	expect(await store.nextDeferredAt()).toBe(Date.parse(until));
	expect((await store.list()).pending.map((item) => item.id)).toContain(routine.id);
	const urgent = await store.capture(
		source("urgent", { kind: "failure", forceVisible: true, questionId: "question-1" }),
	);
	const broken = createMeCurator({
		store,
		classify: async () => {
			throw new Error("model down");
		},
	});
	expect((await broken.run()).failed).toEqual([urgent.id]);
	expect((await broken.run()).failed).toEqual([urgent.id]);
	expect((await broken.run()).failed).toEqual([]);
	expect((await store.pendingNotices())[0]).toMatchObject({ sourceIds: [urgent.id], needsReply: true });
	expect((await store.list()).pending.map((item) => item.id)).toEqual([routine.id]);
});

test("filter opens bounded detail once and resolves a prior concern with later cited evidence", async () => {
	isolate();
	const store = openMeStore();
	const initial = await store.capture(source("initial"));
	await store.decide(initial.id, decision(initial));
	const later = await store.capture(source("later", { text: "The answer arrived" }));
	let calls = 0;
	const curator = createMeCurator({
		store,
		loadDetail: async (selected) => ({ text: `Full verified detail for ${selected.id}`, complete: true }),
		classify: async (input) => {
			calls += 1;
			if (!input.details) return { action: "request_detail", sourceIds: [later.id] };
			expect(input.details).toEqual([
				{ sourceId: later.id, text: `Full verified detail for ${later.id}`, complete: true },
			]);
			return {
				...decision(later),
				action: "resolve",
				summary: "The answer arrived",
				evidenceSourceIds: [initial.id, later.id],
				needsReply: false,
				resolved: true,
			};
		},
	});
	expect((await curator.run()).processed[0]).toMatchObject({ action: "resolve", resolved: true });
	expect(calls).toBe(2);
	expect((await store.pendingNotices()).length).toBe(1);
});

test("one filter turn can checkpoint a small same-work batch without dropping urgent evidence", async () => {
	isolate();
	const store = openMeStore();
	const items = await Promise.all(
		Array.from({ length: 5 }, (_, index) =>
			store.capture(
				source(`burst-${index}`, { text: `Progress ${index}`, kind: "event", forceVisible: index === 2 }),
			),
		),
	);
	let calls = 0;
	const curator = createMeCurator({
		store,
		classify: async ({ source: first, relatedSources }) => {
			calls += 1;
			expect(relatedSources).toHaveLength(4);
			return {
				...decision(first),
				needsReply: false,
				evidenceSourceIds: [first.id, ...(relatedSources ?? []).map((item) => item.id)],
			};
		},
	});
	expect((await curator.run()).pending).toBe(0);
	expect(calls).toBe(1);
	expect((await store.pendingNotices())[0]?.sourceIds).toEqual(items.map((item) => item.id));
});
