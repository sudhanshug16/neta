import { describe, expect, test } from "bun:test";
import { isUlid, ulid } from "../src/core/ids.ts";
import { msBetween, nowIso, parseIso } from "../src/core/time.ts";

describe("ulid", () => {
	test("is 26 chars in the Crockford alphabet", () => {
		const id = ulid();
		expect(id).toHaveLength(26);
		expect(isUlid(id)).toBe(true);
		expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
	});

	test("rejects non-ULIDs", () => {
		expect(isUlid("")).toBe(false);
		expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAU")).toBe(false);
		expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAVO")).toBe(false);
		expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA*")).toBe(false);
	});

	test("is monotonic within one millisecond", () => {
		const now = Date.now();
		const ids = Array.from({ length: 100 }, () => ulid(now));
		for (const id of ids) {
			expect(isUlid(id)).toBe(true);
		}
		const sorted = [...ids].sort();
		expect(ids).toEqual(sorted);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("time", () => {
	test("nowIso round-trips through parseIso", () => {
		const at = nowIso();
		expect(parseIso(at)).toBeLessThanOrEqual(Date.now());
		expect(new Date(parseIso(at)).toISOString()).toBe(at);
	});

	test("parseIso rejects garbage", () => {
		expect(() => parseIso("not a time")).toThrow(RangeError);
	});

	test("msBetween measures the gap", () => {
		expect(msBetween("2026-09-03T17:00:00.000Z", "2026-09-03T17:00:01.500Z")).toBe(1500);
	});
});
