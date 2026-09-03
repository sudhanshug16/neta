import { describe, expect, test } from "bun:test";
import type { DecisionRecord } from "../src/core/types.ts";
import { bannerLine, FIRST_REMINDER_MS, ReminderTracker, reminderLine } from "../src/modes/reminders.ts";

function record(): DecisionRecord {
	return {
		objective: "port the lens",
		whyLeadInsufficient: "needs a writer",
		missionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		mutationKind: "code",
		estimatedFiles: 3,
		validation: "tests pass",
		estimatedMinutes: 30,
		externalEffects: "none",
	};
}

describe("lead++ banner and reminders", () => {
	test("nothing before 10 min, firstEvent once at 10 min and never again", () => {
		const tracker = new ReminderTracker();
		expect(tracker.observe("k", FIRST_REMINDER_MS - 1)).toBe("none");
		expect(tracker.take("k")).toBe(false);
		expect(tracker.observe("k", FIRST_REMINDER_MS)).toBe("firstEvent");
		expect(tracker.observe("k", FIRST_REMINDER_MS + 1)).toBe("none");
		expect(tracker.observe("k", FIRST_REMINDER_MS + 60_000)).toBe("none");
	});

	test("eligibility at 12, 14, 16 min", () => {
		const tracker = new ReminderTracker();
		tracker.observe("k", FIRST_REMINDER_MS);
		tracker.take("k");
		expect(tracker.observe("k", 720_000)).toBe("eligible");
		tracker.take("k");
		expect(tracker.observe("k", 840_000)).toBe("eligible");
		tracker.take("k");
		expect(tracker.observe("k", 960_000)).toBe("eligible");
	});

	test("three eligible ticks with no take yield one take true then false", () => {
		const tracker = new ReminderTracker();
		tracker.observe("k", FIRST_REMINDER_MS);
		tracker.observe("k", 720_000);
		tracker.observe("k", 840_000);
		expect(tracker.take("k")).toBe(true);
		expect(tracker.take("k")).toBe(false);
	});

	test("clear then a new run reproduces firstEvent", () => {
		const tracker = new ReminderTracker();
		tracker.observe("k", FIRST_REMINDER_MS);
		tracker.clear("k");
		expect(tracker.take("k")).toBe(false);
		expect(tracker.observe("k", 0)).toBe("none");
		expect(tracker.observe("k", FIRST_REMINDER_MS)).toBe("firstEvent");
	});

	test("the banner renders whole minutes and the exact separator", () => {
		expect(bannerLine({ activeMs: 750_000, missionNumber: 7, missionName: "sales tax" })).toBe(
			"Lead++ active 12 min · #7 sales tax",
		);
	});

	test("a record-less reminder says set by the user; a long one stays one line under 160", () => {
		expect(reminderLine({ activeMs: 600_000 })).toContain("set by the user");
		const long = reminderLine({
			activeMs: 600_000,
			record: { ...record(), objective: "x".repeat(200), validation: "y".repeat(200) },
		});
		expect(long).not.toContain("\n");
		expect(long.length).toBeLessThan(160);
		expect(reminderLine({ activeMs: 600_000, record: record() })).toBe(
			"Lead++ active 10 min for port the lens: tests pass",
		);
	});
});
