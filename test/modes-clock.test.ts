import { describe, expect, test } from "bun:test";
import { ActiveClock } from "../src/modes/clock.ts";

function clock(persisted: Array<[string, number]>, connected = 0): ActiveClock {
	return new ActiveClock({ connectedClients: () => connected, persist: (k, ms) => persisted.push([k, ms]) });
}

describe("active-time clock", () => {
	test("60 s connected, 60 s disconnected, 60 s connected counts 120 s", () => {
		const persisted: Array<[string, number]> = [];
		const c = clock(persisted);
		c.resume("k", 0, 0);
		c.setConnectedClients(1, 0);
		c.tick(60_000);
		expect(c.activeMs("k")).toBe(60_000);
		c.setConnectedClients(0, 60_000);
		c.tick(120_000);
		expect(c.activeMs("k")).toBe(60_000);
		c.setConnectedClients(1, 120_000);
		c.tick(180_000);
		expect(c.activeMs("k")).toBe(120_000);
	});

	test("a key resumed at 300 s continues from there", () => {
		const persisted: Array<[string, number]> = [];
		const c = clock(persisted, 1);
		c.resume("k", 300_000, 1_000);
		c.tick(11_000);
		expect(c.activeMs("k")).toBe(310_000);
		expect(c.keys()).toEqual(["k"]);
	});

	test("persist fires at 30 s boundaries, not between, and suspend flushes", () => {
		const persisted: Array<[string, number]> = [];
		const c = clock(persisted, 1);
		c.resume("k", 0, 0);
		c.tick(10_000);
		c.tick(29_999);
		expect(persisted).toEqual([]);
		c.tick(30_000);
		expect(persisted).toEqual([["k", 30_000]]);
		c.tick(45_000);
		expect(persisted).toEqual([["k", 30_000]]);
		c.tick(60_000);
		expect(persisted).toEqual([
			["k", 30_000],
			["k", 60_000],
		]);
		expect(c.suspend("k", 65_000)).toBe(65_000);
		expect(persisted.at(-1)).toEqual(["k", 65_000]);
		expect(c.keys()).toEqual([]);
	});

	test("never persists a key with no connected client", () => {
		const persisted: Array<[string, number]> = [];
		const c = clock(persisted, 0);
		c.resume("k", 0, 0);
		c.tick(60_000);
		expect(c.suspend("k", 120_000)).toBe(0);
		expect(persisted).toEqual([]);
	});
});
