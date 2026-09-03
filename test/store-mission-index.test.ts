import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Mission, MissionState } from "../src/core/types.ts";
import { createMissionIndex, missionCursor } from "../src/store/mission-index.ts";

const STATES: MissionState[] = ["running", "blocked", "failed", "readyToClose", "mergedNotClosed", "closed"];

function makeMissions(count: number): Mission[] {
	const base = Date.parse("2026-09-01T00:00:00.000Z");
	const out: Mission[] = [];
	for (let n = 1; n <= count; n++) {
		// Ten missions share each timestamp, forcing createdAt ties.
		const at = new Date(base + Math.floor((n - 1) / 10) * 3_600_000).toISOString();
		out.push({
			id: ulid(base + n),
			number: n,
			workspaceId: "git:github.com/org/repo",
			machineId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			name: `mission ${n}`,
			objective: "Do it.",
			changes: [],
			lead: { kind: "leader" },
			agentIds: [],
			access: "readOnly",
			state: STATES[n % STATES.length],
			createdAt: at,
		});
	}
	return out;
}

describe("mission index", () => {
	test("a window returns exactly the missions inside it", () => {
		const index = createMissionIndex();
		const missions = makeMissions(1000);
		for (const m of missions) {
			index.put(m);
		}
		expect(index.size()).toBe(1000);
		expect(index.maxNumber()).toBe(1000);
		const from = missions[99].createdAt;
		const to = missions[199].createdAt;
		const page = index.list({ from, to, limit: 1000 });
		const expected = missions.filter((m) => m.createdAt >= from && m.createdAt <= to);
		expect(page.missions.map((m) => m.id)).toEqual(expected.map((m) => m.id));
	});

	test("paging by cursor visits each mission once, in order", () => {
		const index = createMissionIndex();
		const missions = makeMissions(1000);
		for (const m of missions) {
			index.put(m);
		}
		const seen: string[] = [];
		let cursor: string | undefined;
		for (;;) {
			const page = index.list({ limit: 77, cursor });
			for (const m of page.missions) {
				seen.push(m.id);
			}
			if (page.cursor === undefined) {
				break;
			}
			cursor = page.cursor;
		}
		expect(seen).toEqual(missions.map((m) => m.id));
	});

	test("states filters without breaking paging", () => {
		const index = createMissionIndex();
		const missions = makeMissions(1000);
		for (const m of missions) {
			index.put(m);
		}
		const seen: string[] = [];
		let cursor: string | undefined;
		for (;;) {
			const page = index.list({ states: ["blocked"], limit: 50, cursor });
			for (const m of page.missions) {
				expect(m.state).toBe("blocked");
				seen.push(m.id);
			}
			if (page.cursor === undefined) {
				break;
			}
			cursor = page.cursor;
		}
		expect(seen).toEqual(missions.filter((m) => m.state === "blocked").map((m) => m.id));
	});

	test("put of an update keeps its slot and refreshes all three indexes", () => {
		const index = createMissionIndex();
		const missions = makeMissions(10);
		for (const m of missions) {
			index.put(m);
		}
		const target = missions[4];
		const before = index.all().map((m) => m.id);
		index.put({ ...target, state: "failed", attention: "boom" });
		expect(index.all().map((m) => m.id)).toEqual(before);
		expect(index.get(target.id)?.attention).toBe("boom");
		expect(index.byNumber(target.number)?.state).toBe("failed");
		expect(missionCursor(target)).toBe(`${target.createdAt}|${target.id}`);
		expect(() => index.put({ ...target, createdAt: "2027-01-01T00:00:00.000Z" })).toThrow();
	});
});
