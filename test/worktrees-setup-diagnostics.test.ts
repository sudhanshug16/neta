import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXCERPT_BYTES,
	readSetupDiagnostic,
	safeExcerpt,
	writeSetupDiagnostic,
} from "../src/worktrees/setup-diagnostics.ts";
import { WtError } from "../src/worktrees/wt.ts";

test("setup diagnostics are private, bounded, and redact unsafe excerpts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neta-setup-diagnostic-"));
	try {
		expect(
			safeExcerpt(
				'\u001b[31mred\u001b[0m\u001b]0;hidden\u0007\r\u0000 "password":"private" Bearer abc postgres://user:pass@localhost/db',
			),
		).toBe('red "password":"[redacted]" Bearer [redacted] postgres://[redacted]@localhost/db');
		const excerpt = safeExcerpt(`token=secret\u001b[31m\u0000\n${"x".repeat(EXCERPT_BYTES * 2)}`);
		expect(excerpt).toContain("token=[redacted]");
		expect(excerpt).not.toContain("secret");
		expect(excerpt).toContain("[truncated]");
		const error = new WtError(["switch"], { stdout: excerpt, stderr: "password=hunter2", code: 1 });
		const saved = await writeSetupDiagnostic(dir, {
			workspaceId: "w",
			number: 1,
			name: "n",
			objective: "o",
			access: "readOnly",
			repoRoot: "/repo",
			branch: "mission/1-n",
			base: "main",
			at: new Date(0).toISOString(),
			error,
		});
		expect(saved.stderr).toContain("password=[redacted]");
		expect(await readSetupDiagnostic(dir, "w", 1)).toMatchObject({ number: 1 });
		expect((await stat(join(dir, "worktree-setup", "w", "1.json"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(dir, "worktree-setup", "w"))).mode & 0o777).toBe(0o700);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("retention keeps foreign files and bounds concurrent owned diagnostic writes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neta-setup-diagnostic-"));
	try {
		const owned = join(dir, "worktree-setup", "w");
		await mkdir(owned, { recursive: true });
		await writeFile(join(owned, "foreign.txt"), "do not remove");
		const writes = Array.from({ length: 25 }, (_, index) =>
			writeSetupDiagnostic(dir, {
				workspaceId: "w",
				number: index + 1,
				name: "n",
				objective: "o",
				access: "readOnly",
				repoRoot: "/repo",
				branch: `mission/${index + 1}-n`,
				base: "main",
				at: new Date(0).toISOString(),
				error: new WtError(["switch"], {
					stdout: "x".repeat(EXCERPT_BYTES),
					stderr: `Bearer secret https://user:pass@example.test ${"y".repeat(EXCERPT_BYTES)}`,
					code: 1,
				}),
			}),
		);
		await Promise.all(writes);
		expect(await Bun.file(join(owned, "foreign.txt")).text()).toBe("do not remove");
		const files = await readdir(owned);
		expect(files.filter((name) => /^\d+\.json$/.test(name)).length).toBeLessThanOrEqual(20);
		const bytes = await Promise.all(
			files.filter((name) => /^\d+\.json$/.test(name)).map(async (name) => (await stat(join(owned, name))).size),
		);
		expect(bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(128 * 1024);
		await expect(
			writeSetupDiagnostic(dir, {
				workspaceId: "w",
				number: 99,
				name: "n",
				objective: "x".repeat(128 * 1024),
				access: "readOnly",
				repoRoot: "/repo",
				branch: "mission/99-n",
				base: "main",
				at: "now",
				error: new Error("failed"),
			}),
		).rejects.toThrow("retention byte limit");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
