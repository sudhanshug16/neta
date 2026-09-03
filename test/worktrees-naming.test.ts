import { describe, expect, test } from "bun:test";
import { missionBranch, parseMissionBranch, slugify } from "../src/worktrees/naming.ts";

describe("mission branch naming", () => {
	test("the plan example", () => {
		expect(missionBranch(12, slugify("Fix the OAuth refresh loop"))).toBe("mission/12-fix-the-oauth-refresh-loop");
	});

	test("unicode and emoji still give a valid ref", () => {
		const slug = slugify("Réparer le déjà-vu 🎉 déploiement");
		expect(slug).toMatch(/^[a-z0-9-]{1,32}$/);
		expect(missionBranch(3, slug)).toBe(`mission/3-${slug}`);
		expect(slugify("🎉🚀")).toBe("mission");
	});

	test("a 200-char name truncates with no trailing dash", () => {
		const slug = slugify(`${"a".repeat(100)} ${"b".repeat(100)}`);
		expect(slug.length).toBeLessThanOrEqual(32);
		expect(slug.endsWith("-")).toBe(false);
		expect(slug).toMatch(/^[a-z0-9-]+$/);
	});

	test("round-trips", () => {
		for (const name of ["add retry budget", "Lens Port", "x"]) {
			const branch = missionBranch(7, slugify(name));
			expect(parseMissionBranch(branch)).toEqual({ number: 7, slug: slugify(name) });
		}
	});

	test("non-mission refs are undefined", () => {
		expect(parseMissionBranch("main")).toBeUndefined();
		expect(parseMissionBranch("mission/0-x")).toBeUndefined();
		expect(parseMissionBranch("feature/1-x")).toBeUndefined();
		expect(parseMissionBranch("mission/12-")).toBeUndefined();
	});

	test("missionBranch throws on a non-positive or non-integer number", () => {
		expect(() => missionBranch(0, "x")).toThrow();
		expect(() => missionBranch(-2, "x")).toThrow();
		expect(() => missionBranch(1.5, "x")).toThrow();
	});
});
