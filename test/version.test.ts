import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { netaVersion } from "../src/version.ts";

describe("netaVersion", () => {
	test("equals the version field of package.json", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version: string;
		};
		expect(netaVersion()).toBe(pkg.version);
	});

	test("looks like a release version", () => {
		expect(netaVersion()).toMatch(/^\d+\.\d+\.\d+/);
	});
});
