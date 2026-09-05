import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLANCE_MAX_REVIEWED_CARDS, GLANCE_MAX_SOURCE_BYTES, openGlanceStore } from "../src/store/glance.ts";
import { paths } from "../src/store/paths.ts";

const previous = process.env.NETA_DIR;
afterEach(() => {
	if (previous === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = previous;
});
function temp() {
	process.env.NETA_DIR = mkdtempSync(join(tmpdir(), "neta-glance-"));
}
function card(id: string, source = "ordinary answer") {
	return {
		id,
		workspaceId: "w",
		at: "2026-09-05T00:00:00.000Z",
		sessionId: "s",
		turnId: id,
		firstBlockSeq: 1,
		lastBlockSeq: 2,
		sourceHash: `hash-${id}`,
		source,
		preview: source.slice(0, 1200),
		interrupted: false,
		actorKind: "leader" as const,
		agentLabel: "Halden",
	};
}
describe("glance store", () => {
	test("persists cards and monotonic review state across reopen", async () => {
		temp();
		const store = openGlanceStore();
		await store.upsert(card("t1"));
		await store.markReviewed("w", 1);
		const reopened = openGlanceStore();
		const page = await reopened.list("w");
		expect(page.cards).toEqual([]);
		expect(page.reviewedThroughGlanceSeq).toBe(1);
		await reopened.markReviewed("w", 0);
		expect((await reopened.list("w")).reviewedThroughGlanceSeq).toBe(1);
	});
	test("source hash makes replay idempotent and rejects stale completion", async () => {
		temp();
		const store = openGlanceStore();
		const one = await store.upsert(card("t1"));
		const replay = await store.upsert(card("t1"));
		expect(replay.glanceSeq).toBe(one.glanceSeq);
		expect(
			await store.complete("w", "t1", "wrong", { kind: "excerptFallback", excerpt: "x", reason: "unavailable" }),
		).toBeUndefined();
		const done = await store.complete("w", "t1", "hash-t1", {
			kind: "onDeviceSummary",
			headline: "Done",
			bullets: ["One"],
			engine: "apple-on-device",
			schemaVersion: 1,
		});
		expect(done?.result?.kind).toBe("onDeviceSummary");
	});
	test("bounds source and generated output", async () => {
		temp();
		const store = openGlanceStore();
		const saved = await store.upsert(card("big", "é".repeat(GLANCE_MAX_SOURCE_BYTES)));
		expect(Buffer.byteLength(saved.source)).toBeLessThanOrEqual(GLANCE_MAX_SOURCE_BYTES);
		expect(saved.sourceTruncated).toBe(true);
		expect(
			store.complete("w", "big", "hash-big", {
				kind: "onDeviceSummary",
				headline: "x".repeat(161),
				bullets: [],
				engine: "apple-on-device",
				schemaVersion: 1,
			}),
		).rejects.toThrow();
	});
	test("compacts only reviewed cards and retains every unread card", async () => {
		temp();
		const store = openGlanceStore();
		for (let i = 1; i <= GLANCE_MAX_REVIEWED_CARDS + 25; i++) await store.upsert(card(`t${i}`));
		await store.markReviewed("w", 20);
		const page = await store.list("w", 0, 100);
		expect(page.cards.some((x) => x.id === "t1")).toBe(false);
		expect(await store.get("w", `t${GLANCE_MAX_REVIEWED_CARDS + 25}`)).toBeDefined();
	});
	test("rejects a future review cursor and keeps sources out of the metadata index", async () => {
		temp();
		const store = openGlanceStore();
		const source = `${"public ".repeat(200)}private-tail`;
		await store.upsert(card("t1", source));
		expect(store.markReviewed("w", 2)).rejects.toThrow("beyond the latest");
		const index = await readFile(paths().glanceLog("w"), "utf8");
		expect(index).not.toContain("private-tail");
		expect(await store.get("w", "t1")).toMatchObject({ source });
	});
	test("atomic document never exposes a temporary partial file", async () => {
		temp();
		const store = openGlanceStore();
		await store.upsert(card("t1"));
		const before = await readFile(paths().glanceLog("w"), "utf8");
		expect(() => JSON.parse(before)).not.toThrow();
		await writeFile(`${paths().glanceLog("w")}.tmp-orphan`, "{");
		expect((await openGlanceStore().list("w")).cards).toHaveLength(1);
	});
});
