import { describe, expect, test } from "bun:test";
import type { Mission, MissionState } from "../src/core/types.ts";
import { missionStateLabel, preamble, reminder } from "../src/tools/reminder.ts";

function mission(number: number, state: MissionState, extra?: Partial<Mission>): Mission {
	return {
		id: `01ARZ3NDEKTSV4RRFFQ69G5FA${number}`,
		number,
		workspaceId: "w",
		machineId: "m",
		name: `mission ${number}`,
		objective: "o",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readOnly",
		state,
		createdAt: "2026-01-01T00:00:00.000Z",
		...extra,
	};
}

describe("reminder", () => {
	test("needs-you comes before running, newest first", () => {
		const text = reminder({
			missions: [
				mission(9, "readyToClose"),
				mission(15, "running"),
				mission(14, "blocked", { name: "payments retry", attention: "staging key" }),
				mission(16, "running", { name: "lens port" }),
			],
		});
		expect(text).toBe(
			"[neta] needs you: #14 payments retry — blocked: staging key · #9 mission 9 — ready to close\n[neta] open: #16 lens port · #15 mission 15",
		);
	});

	test("lines cap at eight with +N more, empty lines omitted", () => {
		const missions = Array.from({ length: 10 }, (_, i) => mission(i + 1, "blocked"));
		const text = reminder({ missions });
		expect(text).toBe(
			`[neta] needs you: ${[10, 9, 8, 7, 6, 5, 4, 3].map((n) => `#${n} mission ${n} — blocked`).join(" · ")} · +2 more`,
		);
		const running = Array.from({ length: 9 }, (_, i) => mission(i + 1, "running"));
		expect(reminder({ missions: running }).endsWith("· +1 more")).toBe(true);
		expect(reminder({ missions: [mission(1, "closed")] })).toBe("");
	});

	test("every MissionState maps to its label", () => {
		expect(missionStateLabel("blocked")).toBe("blocked");
		expect(missionStateLabel("failed")).toBe("failed");
		expect(missionStateLabel("readyToClose")).toBe("ready to close");
		expect(missionStateLabel("mergedNotClosed")).toBe("merged, not closed");
		expect(missionStateLabel("running")).toBe("running");
		expect(missionStateLabel("closed")).toBe("closed");
		const text = reminder({
			missions: [mission(1, "failed", { attention: "boom" }), mission(2, "mergedNotClosed")],
		});
		expect(text).toBe("[neta] needs you: #2 mission 2 — merged, not closed · #1 mission 1 — failed: boom");
	});

	test("modeLine goes last, empty input gives empty", () => {
		expect(reminder({ missions: [] })).toBe("");
		expect(reminder({ missions: [], modeLine: "" })).toBe("");
		expect(reminder({ missions: [mission(1, "running")], modeLine: "[neta] Lead++ 12m active" })).toBe(
			"[neta] open: #1 mission 1\n[neta] Lead++ 12m active",
		);
	});
});

describe("preamble", () => {
	test("it adds the heading and nothing else", () => {
		expect(preamble({ missions: [] })).toBe("");
		expect(preamble({ missions: [mission(1, "running")] })).toBe("Current mission state:\n[neta] open: #1 mission 1");
	});
});
