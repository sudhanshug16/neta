import { afterEach, describe, expect, it } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	releaseOwnedDirectory,
	releaseOwnedFile,
	tryAcquireOwnedDirectory,
	tryAcquireOwnedFile,
} from "../src/ownership.ts";

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

	it("preserves a successor when directory restoration races its insertion", () => {
		const path = join(root(), "restore-race");
		const first = tryAcquireOwnedDirectory(path);
		if (!first) throw new Error("first owner missing");
		rmSync(path, { recursive: true, force: false });
		const successor = tryAcquireOwnedDirectory(path);
		if (!successor) throw new Error("successor owner missing");
		const successorInode = lstatSync(path);
		releaseOwnedDirectory(first, {
			beforeDirectoryRestore: () => {
				mkdirSync(path);
				writeFileSync(join(path, "successor-bytes"), "untouched\n");
			},
		});
		expect(readFileSync(join(path, "successor-bytes"), "utf8")).toBe("untouched\n");
		expect(lstatSync(path).ino).not.toBe(successorInode.ino);
		expect(readdirSync(path)).toEqual(["successor-bytes"]);
		releaseOwnedDirectory(successor);
	});

	it("uses prepared proof before directory reservation and recovers dead crash residue", () => {
		const parent = root();
		const path = join(parent, "prepared");
		const token = "dead-prepared";
		const record = join(parent, `prepared.prepared.${process.pid}.${token}`);
		writeFileSync(record, JSON.stringify({ pid: 4242, startedAt: "dead", token, path, kind: "directory" }));
		mkdirSync(path);
		const lease = tryAcquireOwnedDirectory(path, {
			processIsAlive: () => false,
			processStartTime: () => "dead",
		});
		expect(lease).toBeDefined();
		expect(readdirSync(path)).toContain("owner.json");
		releaseOwnedDirectory(lease);
	});

	it("keeps live or unknown prepared candidates busy", () => {
		const path = join(root(), "prepared-live");
		const parent = join(path, "..");
		const token = "live-prepared";
		writeFileSync(
			join(parent, `prepared-live.prepared.${process.pid}.${token}`),
			JSON.stringify({ pid: 4242, startedAt: "live", token, path, kind: "directory" }),
		);
		expect(
			tryAcquireOwnedDirectory(path, { processIsAlive: () => true, processStartTime: () => "live" }),
		).toBeUndefined();
		const unknown = join(root(), "unknown");
		mkdirSync(unknown);
		writeFileSync(join(unknown, "owner.json"), JSON.stringify({ pid: 4242 }));
		expect(tryAcquireOwnedDirectory(unknown, { processIsAlive: () => true })).toBeUndefined();
	});

	it("reclaims legacy PID reuse only with a known different identity", () => {
		const reused = join(root(), "reused");
		mkdirSync(reused);
		writeFileSync(join(reused, "owner.json"), JSON.stringify({ pid: 4242, startedAt: "old" }));
		const reclaimed = tryAcquireOwnedDirectory(reused, {
			processIsAlive: () => true,
			processStartTime: () => "new",
		});
		expect(reclaimed).toBeDefined();
		releaseOwnedDirectory(reclaimed);

		for (const name of ["matching", "unknown"] as const) {
			const path = join(root(), name);
			mkdirSync(path);
			writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: 4242, startedAt: "old" }));
			expect(
				tryAcquireOwnedDirectory(path, {
					processIsAlive: () => true,
					processStartTime: name === "matching" ? () => "old" : () => undefined,
				}),
			).toBeUndefined();
		}
	});

	it("publishes file ownership through a hard-link and never overwrites a successor", () => {
		const path = join(root(), "file-lock");
		const first = tryAcquireOwnedFile(path);
		if (!first) throw new Error("first file owner missing");
		rmSync(path);
		const successor = tryAcquireOwnedFile(path);
		if (!successor) throw new Error("successor file owner missing");
		const bytes = readFileSync(path);
		const successorInode = lstatSync(path).ino;
		releaseOwnedFile(first);
		expect(readFileSync(path)).toEqual(bytes);
		expect(lstatSync(path).ino).toBe(successorInode);
		releaseOwnedFile(successor);
	});

	it("keeps a successor path when file restoration sees a no-replace collision", () => {
		const path = join(root(), "file-restore");
		const first = tryAcquireOwnedFile(path);
		if (!first) throw new Error("first file owner missing");
		rmSync(path);
		const successor = tryAcquireOwnedFile(path);
		if (!successor) throw new Error("successor file owner missing");
		const bytes = readFileSync(path);
		const inode = lstatSync(path).ino;
		releaseOwnedFile(first);
		expect(readFileSync(path)).toEqual(bytes);
		expect(lstatSync(path).ino).toBe(inode);
		releaseOwnedFile(successor);
	});
});
