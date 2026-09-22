import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOpenCodeCheckout } from "../scripts/setup-opencode.ts";

test("backs up local edits before replacing a stale repository-managed OpenCode runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "neta-setup-opencode-"));
	const managed = join(root, "vendor/opencode/runtime");
	try {
		await mkdir(managed, { recursive: true });
		await writeFile(join(managed, "state"), "stale");
		let creates = 0;
		await ensureOpenCodeCheckout({
			fork: managed,
			managed: true,
			verify: async (fork) => {
				if ((await readFile(join(fork, "state"), "utf8")) !== "reviewed") throw new Error("stale pin");
			},
			create: async (fork) => {
				creates += 1;
				await mkdir(fork, { recursive: true });
				await writeFile(join(fork, "state"), "reviewed");
			},
		});
		expect(creates).toBe(1);
		expect(await readFile(join(managed, "state"), "utf8")).toBe("reviewed");
		const backups = (await readdir(join(root, "vendor/opencode"))).filter((entry) =>
			entry.startsWith(".neta-opencode-backup-"),
		);
		expect(backups).toHaveLength(1);
		const [backup] = backups;
		if (!backup) throw new Error("Expected stale checkout backup");
		expect(await readFile(join(root, "vendor/opencode", backup, "state"), "utf8")).toBe("stale");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("does not overwrite a stale explicit OpenCode override at the managed path", async () => {
	const root = await mkdtemp(join(tmpdir(), "neta-setup-opencode-"));
	const managed = join(root, "vendor/opencode/runtime");
	const override = join(managed, "../runtime");
	try {
		await mkdir(override, { recursive: true });
		await writeFile(join(override, "state"), "custom changes");
		let creates = 0;
		await expect(
			ensureOpenCodeCheckout({
				fork: override,
				managed: false,
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

test("keeps the stale managed checkout when replacement creation fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "neta-setup-opencode-"));
	const managed = join(root, "vendor/opencode/runtime");
	try {
		await mkdir(managed, { recursive: true });
		await writeFile(join(managed, "state"), "local edits");
		await expect(
			ensureOpenCodeCheckout({
				fork: managed,
				managed: true,
				verify: async () => {
					throw new Error("stale pin");
				},
				create: async () => {
					throw new Error("replacement creation failed");
				},
			}),
		).rejects.toThrow("replacement creation failed");
		expect(await readFile(join(managed, "state"), "utf8")).toBe("local edits");
		expect(
			(await readdir(join(root, "vendor/opencode"))).filter((entry) => entry.startsWith(".neta-opencode-backup-")),
		).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
