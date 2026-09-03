import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "../src/core/types.ts";
import { openEventLog } from "../src/store/event-log.ts";
import { appendLine, ensureDir } from "../src/store/files.ts";
import { paths } from "../src/store/paths.ts";

const prev = process.env.NETA_DIR;

afterEach(() => {
	if (prev === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = prev;
	}
});

function useTempDir(): void {
	process.env.NETA_DIR = mkdtempSync(join(tmpdir(), "neta-events-"));
}

function draft(workspaceId: string, kind: Event["kind"] = "mission.created", n = 1): Omit<Event, "seq" | "at"> {
	return { workspaceId, kind, missionId: `mission-${n}`, data: { number: n } };
}

describe("event log", () => {
	test("seq rises per workspace and survives a reopen", async () => {
		useTempDir();
		const log = openEventLog();
		const a = await log.append(draft("ws-a"));
		const b = await log.append(draft("ws-a"));
		const other = await log.append(draft("ws-b"));
		expect(a.seq).toBe(1);
		expect(b.seq).toBe(2);
		expect(other.seq).toBe(1);
		const reopened = openEventLog();
		const c = await reopened.append(draft("ws-a"));
		expect(c.seq).toBe(3);
	});

	test("a deleted seq file is repaired from the month file", async () => {
		useTempDir();
		const log = openEventLog();
		await log.append(draft("ws-a"));
		await log.append(draft("ws-a"));
		rmSync(paths().eventSeq("ws-a"));
		const reopened = openEventLog();
		const next = await reopened.append(draft("ws-a"));
		expect(next.seq).toBe(3);
	});

	test("events across a month boundary come back in one window in seq order", async () => {
		useTempDir();
		const p = paths();
		const old: Event = {
			seq: 1,
			at: "2026-08-31T23:00:00.000Z",
			workspaceId: "ws-a",
			kind: "mission.created",
			data: { number: 1 },
		};
		const newer: Event = {
			seq: 2,
			at: "2026-09-01T01:00:00.000Z",
			workspaceId: "ws-a",
			kind: "mission.created",
			data: { number: 2 },
		};
		await ensureDir(p.eventsDir("ws-a"));
		await appendLine(p.eventMonth("ws-a", "2026-08"), old);
		await appendLine(p.eventMonth("ws-a", "2026-09"), newer);
		const log = openEventLog();
		const page = await log.list("ws-a", {});
		expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
		const third = await log.append(draft("ws-a"));
		expect(third.seq).toBe(3);
	});

	test("kinds filter, paging visits each event once, tail follows seq", async () => {
		useTempDir();
		const log = openEventLog();
		for (let n = 1; n <= 250; n++) {
			await log.append(draft("ws-a", n % 2 === 0 ? "agent.spawned" : "mission.created", n));
		}
		const filtered = await log.list("ws-a", { kinds: ["agent.spawned"], limit: 2000 });
		expect(filtered.events).toHaveLength(125);
		const seen: number[] = [];
		let cursor: string | undefined;
		for (;;) {
			const page = await log.list("ws-a", { limit: 100, cursor });
			seen.push(...page.events.map((e) => e.seq));
			if (page.cursor === undefined) {
				break;
			}
			cursor = page.cursor;
		}
		expect(seen).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
		expect(await log.tail("ws-a", 250)).toEqual([]);
		expect((await log.tail("ws-a", 249)).map((e) => e.seq)).toEqual([250]);
	});
});
