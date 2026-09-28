import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LifecycleToolContext, lifecycleHandlers } from "../src/tools/handlers/lifecycle.ts";
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
		expect(excerpt).toContain("[... middle omitted ...]");
		expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
		const setupFailure = safeExcerpt(
			`Running project:setup\n${"install progress\n".repeat(500)}rake aborted!\nActiveRecord::RecordInvalid: Validation failed: source address\n${"backtrace line\n".repeat(500)}`,
		);
		expect(setupFailure).toContain("Running project:setup");
		expect(setupFailure).toContain("[error lines]");
		expect(setupFailure).toContain("ActiveRecord::RecordInvalid: Validation failed: source address");
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
		expect(bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
		await writeSetupDiagnostic(dir, {
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
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("diagnostic tool pages redacted log text and marks upstream truncation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neta-setup-pages-"));
	const previous = process.env.NETA_DIR;
	process.env.NETA_DIR = dir;
	try {
		await writeSetupDiagnostic(dir, {
			workspaceId: "w",
			number: 1,
			name: "failed",
			objective: "test",
			access: "readWrite",
			repoRoot: "/repo",
			branch: "mission/1-failed",
			base: "main",
			at: new Date(0).toISOString(),
			error: new WtError(["switch"], {
				stdout: "",
				stderr: `Bearer secret\n${"x".repeat(9000)}\n[output truncated]`,
				code: 23,
			}),
		});
		const context = { actor: { kind: "leader", workspaceId: "w" } } as LifecycleToolContext;
		let cursor: string | undefined;
		let firstCursor: string | undefined;
		let log = "";
		for (let index = 0; index < 10; index++) {
			const page = await lifecycleHandlers.setup_diagnostic(context, { number: 1, cursor });
			if (!page.ok) throw new Error(page.message);
			expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThanOrEqual(4096);
			const data = page.data as { text: string; sourceTruncated: boolean; truncated: boolean; nextCursor?: string };
			expect(data.sourceTruncated).toBe(true);
			log += data.text;
			cursor = data.nextCursor;
			if (!firstCursor) firstCursor = cursor;
			if (!cursor) {
				expect(data.truncated).toBe(false);
				break;
			}
		}
		expect(log).toContain("Bearer [redacted]");
		expect(log).toContain("[output truncated]");
		expect(log).not.toContain("Bearer secret");
		expect(
			await lifecycleHandlers.setup_diagnostic(context, { number: 1, stream: "stdout", cursor: firstCursor }),
		).toMatchObject({ ok: false });
	} finally {
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});
