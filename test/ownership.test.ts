import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseOwnedDirectory, tryAcquireOwnedDirectory } from "../src/ownership.ts";

describe("owned-directory recovery", () => {
	const roots: string[] = [];
	const root = () => {
		const value = mkdtempSync(join(tmpdir(), "neta-ownership-"));
		roots.push(value);
		return value;
	};
	afterEach(() => {
		for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
	});

	it("gives exactly one owner and releases only the exact handle", () => {
		const path = join(root(), "claim");
		const first = tryAcquireOwnedDirectory(path);
		expect(first).toBeDefined();
		expect(tryAcquireOwnedDirectory(path)).toBeUndefined();
		if (!first) throw new Error("first owner missing");

		// Simulate a successor appearing after the old handle's observation. The
		// old release must not remove the successor's bytes or inode.
		rmSync(path, { recursive: true, force: false });
		const successor = tryAcquireOwnedDirectory(path);
		if (!successor) throw new Error("successor owner missing");
		releaseOwnedDirectory(first);
		expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token).toBe(successor.token);
		releaseOwnedDirectory(successor);
	});

	it("recovers a legacy owner only after death is proven", () => {
		const path = join(root(), "legacy");
		mkdirSync(path);
		writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: 4242, startedAt: "old", token: "legacy" }));
		const lease = tryAcquireOwnedDirectory(path, { processIsAlive: () => false });
		expect(lease).toBeDefined();
		releaseOwnedDirectory(lease);
	});

	it("keeps live quarantine residue busy", () => {
		const parent = root();
		const path = join(parent, "claim");
		const residue = tryAcquireOwnedDirectory(join(parent, "claim.quarantine.live"));
		expect(residue).toBeDefined();
		expect(tryAcquireOwnedDirectory(path)).toBeUndefined();
		releaseOwnedDirectory(residue);
	});
});
