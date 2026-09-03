import { describe, expect, test } from "bun:test";
import { nextNumber } from "../src/core/numbering.ts";

describe("nextNumber", () => {
	test("increments by one", () => {
		expect(nextNumber(0)).toBe(1);
		expect(nextNumber(41)).toBe(42);
	});
});
