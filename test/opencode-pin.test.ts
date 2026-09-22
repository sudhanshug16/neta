import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, sha256, sourcePathAllowed, verifyCheckout, type OpenCodePin } from "../scripts/opencode-pin.ts";

test("release overlays reject configuration, build output, and path traversal", () => {
	for (const path of [
		".env",
		"auth.json",
		"node_modules/pkg/src/x.ts",
		"packages/cli/dist/main.js",
		"packages/cli/src/../../auth.json",
	])
		expect(sourcePathAllowed(path)).toBe(false);
	expect(sourcePathAllowed("packages/cli/src/acp/service.ts")).toBe(true);
	expect(sourcePathAllowed("bun.lock")).toBe(true);
	expect(sourcePathAllowed("packages/codemode/interpreter-support.md")).toBe(true);
});

test("pinned checkout verification rejects changed bytes, extra files and symlink sources", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neta-pin-"));
	try {
		await git(dir, ["init", "--quiet"]);
		// Disposable fixture commit; never modifies the development repository.
		await git(dir, [
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"--no-gpg-sign",
			"-m",
			"fixture",
		]);
		await mkdir(join(dir, "packages/cli/src"), { recursive: true });
		await writeFile(join(dir, "bun.lock"), "fixture lock");
		const source = join(dir, "packages/cli/src/service.ts");
		await writeFile(source, "export const version = 1;");
		const pin: OpenCodePin = {
			format: 1,
			repository: "https://github.com/anomalyco/opencode.git",
			commit: (await git(dir, ["rev-parse", "HEAD"])).trim(),
			bun: Bun.version,
			integrationVersion: 2,
			overlaySha256: sha256(""),
			lockSha256: sha256("fixture lock"),
			files: { "bun.lock": sha256("fixture lock"), "packages/cli/src/service.ts": sha256(await readFile(source)) },
		};
		await verifyCheckout(dir, pin);
		await writeFile(source, "export const version = 2;");
		await expect(verifyCheckout(dir, pin)).rejects.toThrow("pinned source differs");
		await writeFile(source, "export const version = 1;");
		await writeFile(join(dir, "unexpected.json"), "{}");
		await expect(verifyCheckout(dir, pin)).rejects.toThrow("Unpinned OpenCode file");
		await rm(join(dir, "unexpected.json"));
		await rm(source);
		await symlink(join(dir, "bun.lock"), source);
		await expect(verifyCheckout(dir, pin)).rejects.toThrow("regular file");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
