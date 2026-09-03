import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import { decodeWorkspaceId, encodeWorkspaceId, monthKey, netaDir, paths } from "../src/store/paths.ts";

describe("store paths", () => {
	test("a NETA_DIR change between calls is picked up", () => {
		const prev = process.env.NETA_DIR;
		try {
			process.env.NETA_DIR = "/tmp/neta-a";
			const a = paths();
			process.env.NETA_DIR = "/tmp/neta-b";
			const b = paths();
			expect(a.root).toBe("/tmp/neta-a");
			expect(b.root).toBe("/tmp/neta-b");
			expect(netaDir()).toBe("/tmp/neta-b");
		} finally {
			if (prev === undefined) {
				delete process.env.NETA_DIR;
			} else {
				process.env.NETA_DIR = prev;
			}
		}
	});

	test("encode/decode round-trips a git id with no / in the name", () => {
		const id = "git:github.com/org/repo";
		const name = encodeWorkspaceId(id);
		expect(name).not.toContain("/");
		expect(decodeWorkspaceId(name)).toBe(id);
	});

	test("monthKey is UTC and padded", () => {
		expect(monthKey("2026-01-05T00:30:00.000Z")).toBe("2026-01");
		expect(monthKey("2026-09-03T23:59:59.999Z")).toBe("2026-09");
		expect(monthKey("2026-12-31T23:00:00.000Z")).toBe("2026-12");
	});

	test("every path is under netaDir()", () => {
		const prev = process.env.NETA_DIR;
		try {
			process.env.NETA_DIR = "/tmp/neta-paths";
			const p = paths();
			const id = "git:github.com/org/repo";
			const values: string[] = [
				p.nodeJson,
				p.nodeSock,
				p.machineJson,
				p.workspacesDir,
				p.workspace(id),
				p.leader(id),
				p.missionsDir(id),
				p.counter(id),
				p.registryLog(id),
				p.registrySnapshot(id),
				p.eventsDir(id),
				p.eventSeq(id),
				p.eventMonth(id, "2026-09"),
				p.conversation("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
				p.conversationMeta("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
				p.worktrees(id),
				p.charterHash(id),
			];
			expect(p.root).toBe("/tmp/neta-paths");
			for (const v of values) {
				expect(v.startsWith(`/tmp/neta-paths${sep}`)).toBe(true);
			}
			expect(p.conversation("abc")).toBe(`/tmp/neta-paths${sep}conversations${sep}abc.ndjson`);
		} finally {
			if (prev === undefined) {
				delete process.env.NETA_DIR;
			} else {
				process.env.NETA_DIR = prev;
			}
		}
	});
});
