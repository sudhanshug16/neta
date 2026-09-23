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
function source(turnId: string): MeSource {
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
