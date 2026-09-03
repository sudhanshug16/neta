import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event, Mission } from "../src/core/types.ts";
import type { SnapshotResult } from "../src/node/protocol.ts";

const SNAPSHOT = JSON.parse(
	readFileSync(join(import.meta.dir, "fixtures", "node-snapshot.json"), "utf8"),
) as SnapshotResult;
const NDJSON = readFileSync(join(import.meta.dir, "fixtures", "node-events.ndjson"), "utf8")
	.split("\n")
	.filter((line) => line !== "")
	.map((line) => JSON.parse(line) as Event);

describe("recorded node fixture", () => {
	test("the snapshot satisfies SnapshotResult field by field", () => {
		expect(typeof SNAPSHOT.machine.id).toBe("string");
		expect(typeof SNAPSHOT.machine.name).toBe("string");
		expect(typeof SNAPSHOT.machine.createdAt).toBe("string");
		expect(SNAPSHOT.workspaces).toHaveLength(1);
		expect(SNAPSHOT.workspaces[0]?.kind).toBe("git");
		expect(SNAPSHOT.leaders).toHaveLength(1);
		expect(SNAPSHOT.leaders[0]?.mode).toBe("lead");
		expect(SNAPSHOT.missions).toHaveLength(13);
		expect(new Set(SNAPSHOT.missions.map((m: Mission) => m.state))).toEqual(
			new Set(["running", "blocked", "failed", "readyToClose", "mergedNotClosed", "closed"]),
		);
		expect(SNAPSHOT.hasOlder).toBe(true);
		for (const agent of SNAPSHOT.agents) {
			expect(agent.state === "archived").toBe(false);
		}
		expect(typeof SNAPSHOT.completedCounts).toBe("object");
		expect(SNAPSHOT.events.length).toBeGreaterThan(0);
		expect(SNAPSHOT.windowDays).toBe(14);
		expect(SNAPSHOT.protocolVersion).toBe(1);
		expect(typeof SNAPSHOT.at).toBe("string");
	});

	test("attention is non-empty and newest first", () => {
		expect(SNAPSHOT.attention.length).toBeGreaterThan(0);
		for (const mission of SNAPSHOT.attention) {
			expect(["blocked", "failed", "readyToClose", "mergedNotClosed"].includes(mission.state)).toBe(true);
		}
		const created = SNAPSHOT.attention.map((m: Mission) => m.createdAt);
		expect([...created].sort().reverse()).toEqual(created);
	});

	test("completedCounts has an entry over 8", () => {
		expect(Math.max(...Object.values(SNAPSHOT.completedCounts))).toBe(12);
	});

	test("the NDJSON carries every event once, seq monotonic per workspace", () => {
		expect(NDJSON.length).toBe(SNAPSHOT.events.length);
		expect(NDJSON.map((e) => e.seq)).toEqual(SNAPSHOT.events.map((e) => e.seq));
		const byWorkspace = new Map<string, number[]>();
		for (const event of NDJSON) {
			const seqs = byWorkspace.get(event.workspaceId) ?? [];
			seqs.push(event.seq);
			byWorkspace.set(event.workspaceId, seqs);
		}
		for (const seqs of byWorkspace.values()) {
			expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		}
	});
});
