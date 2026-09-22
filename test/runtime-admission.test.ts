import { expect, test } from "bun:test";
import { RuntimeAdmission } from "../src/node/runtime-admission.ts";

test("newly admitted work defers upgrade and stale instance cannot prepare", () => {
	const admission = new RuntimeAdmission("current");
	const leave = admission.enter();
	expect(admission.prepare("old", false)).toEqual({ prepared: false, reason: "instance-changed" });
	expect(admission.prepare("current", false)).toEqual({ prepared: false, reason: "active-work" });
	leave();
	leave();
	expect(admission.pendingCount).toBe(0);
	expect(admission.prepare("current", true).prepared).toBe(false);
	expect(admission.prepare("current", false).prepared).toBe(true);
});

test("drain rejects new work and competing updater; failed updater lease expires", () => {
	let now = 0;
	const admission = new RuntimeAdmission("current", () => now);
	const prepared = admission.prepare("current", false);
	if (!prepared.prepared) throw new Error("did not prepare");
	expect(() => admission.enter()).toThrow("request was not started");
	expect(admission.prepare("current", false)).toEqual({ prepared: false, reason: "update-in-progress" });
	now = 15_001;
	expect(admission.commit("current", prepared.token, false)).toBe(false);
	admission.enter()();
});

test("cancel validates token, commit validates activity and never stops successor", () => {
	const admission = new RuntimeAdmission("current");
	const first = admission.prepare("current", false);
	if (!first.prepared) throw new Error("did not prepare");
	admission.cancel("old", first.token);
	expect(() => admission.enter()).toThrow();
	admission.cancel("current", first.token);
	admission.enter()();
	const second = admission.prepare("current", false);
	if (!second.prepared) throw new Error("did not prepare");
	expect(admission.commit("current", second.token, true)).toBe(false);
	admission.enter()();
	const third = admission.prepare("current", false);
	if (!third.prepared) throw new Error("did not prepare");
	expect(admission.commit("old", third.token, false)).toBe(false);
	expect(admission.commit("current", third.token, false)).toBe(true);
	expect(() => admission.enter()).toThrow();
	expect(admission.commit("current", third.token, false)).toBe(false);
});
