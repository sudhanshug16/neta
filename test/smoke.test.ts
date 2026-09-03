import { describe, expect, test } from "bun:test";
import "../src/index.ts";

describe("scaffold", () => {
	test("the package entry imports", () => {
		expect(true).toBe(true);
	});
});
