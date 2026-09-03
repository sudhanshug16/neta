import { describe, expect, test } from "bun:test";
import { KNOWN_PREFIX_PAIRS, NAME_POOL, pickName } from "../src/core/names.ts";

describe("NAME_POOL", () => {
	test("holds 200 unique names", () => {
		expect(NAME_POOL).toHaveLength(200);
		expect(new Set(NAME_POOL).size).toBe(200);
	});

	test("shares no three-letter prefix except the four inherited pairs", () => {
		const byPrefix = new Map<string, string[]>();
		for (const name of NAME_POOL) {
			const prefix = name.slice(0, 3).toLowerCase();
			byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
		}
		const collisions = [...byPrefix.values()].filter((group) => group.length > 1);
		expect(collisions).toHaveLength(KNOWN_PREFIX_PAIRS.length);
		for (const [a, b] of KNOWN_PREFIX_PAIRS) {
			expect(collisions).toContainEqual(expect.arrayContaining([a, b]));
		}
	});
});

describe("pickName", () => {
	test("skips taken names", () => {
		const name = pickName(new Set([NAME_POOL[0]]), "seed-1");
		expect(name).not.toBe(NAME_POOL[0]);
		expect(NAME_POOL).toContain(name);
	});

	test("is deterministic for a seed", () => {
		const taken = new Set(["Ember", "Thane"]);
		expect(pickName(taken, "mission-7")).toBe(pickName(taken, "mission-7"));
	});

	test("throws when the pool is exhausted", () => {
		expect(() => pickName(new Set(NAME_POOL), "seed")).toThrow();
	});
});
