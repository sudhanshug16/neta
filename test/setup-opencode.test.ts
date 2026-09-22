import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOpenCodeCheckout } from "../scripts/setup-opencode.ts";

test("recreates a stale repository-managed OpenCode runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "neta-setup-opencode-"));
	const managed = join(root, "vendor/opencode/runtime");
	try {
		await mkdir(managed, { recursive: true });
		await writeFile(join(managed, "state"), "stale");
		let creates = 0;
		await ensureOpenCodeCheckout({
			fork: managed,
			managedFork: managed,
			verify: async () => {
				if ((await readFile(join(managed, "state"), "utf8")) !== "reviewed") throw new Error("stale pin");
			},
			create: async () => {
				creates += 1;
				await mkdir(managed, { recursive: true });
				await writeFile(join(managed, "state"), "reviewed");
			},
		});
		expect(creates).toBe(1);
		expect(await readFile(join(managed, "state"), "utf8")).toBe("reviewed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("does not overwrite a stale explicit OpenCode override", async () => {
	const root = await mkdtemp(join(tmpdir(), "neta-setup-opencode-"));
	const managed = join(root, "vendor/opencode/runtime");
	const override = join(root, "custom-opencode");
	try {
		await mkdir(override, { recursive: true });
		await writeFile(join(override, "state"), "custom changes");
		let creates = 0;
		await expect(
			ensureOpenCodeCheckout({
				fork: override,
				managedFork: managed,
				verify: async () => {
					throw new Error("stale pin");
				},
				create: async () => {
					creates += 1;
				},
			}),
		).rejects.toThrow("stale pin");
		expect(creates).toBe(0);
		expect(await readFile(join(override, "state"), "utf8")).toBe("custom changes");
		expect(await access(override).then(() => true)).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
