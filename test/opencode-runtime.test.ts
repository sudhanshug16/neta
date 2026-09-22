import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeInvocation } from "../src/opencode/runtime.ts";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function git(directory: string, args: string[]): Promise<string> {
	const result = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, status] = await Promise.all([
		new Response(result.stdout).text(),
		new Response(result.stderr).text(),
		result.exited,
	]);
	if (status !== 0) throw new Error(stderr);
	return stdout;
}

async function fixture(): Promise<{ root: string; fork: string; shell: string }> {
	const root = await mkdtemp(join(tmpdir(), "neta-opencode-runtime-"));
	const fork = join(root, "fork");
	const shell = "export const NetaShell = () => null;\n";
	const lock = "fixture lock\n";
	const marker = '{"integrationVersion":2}\n';
	await mkdir(fork, { recursive: true });
	await git(fork, ["init", "--quiet"]);
	await git(fork, ["config", "user.name", "Fixture"]);
	await git(fork, ["config", "user.email", "fixture@example.invalid"]);
	await git(fork, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "fixture"]);
	await mkdir(join(fork, "packages/cli/src/acp"), { recursive: true });
	await mkdir(join(fork, "packages/tui/src/neta"), { recursive: true });
	await writeFile(join(fork, "bun.lock"), lock);
	await writeFile(join(fork, "neta-fork.json"), marker);
	await writeFile(join(fork, "packages/cli/src/acp/service.ts"), "export {};\n");
	await writeFile(join(fork, "packages/tui/src/neta/shell.tsx"), shell);
	await mkdir(join(root, "vendor/opencode"), { recursive: true });
	const commit = (await git(fork, ["rev-parse", "HEAD"])).trim();
	await writeFile(
		join(root, "vendor/opencode/integration.json"),
		JSON.stringify({
			format: 1,
			repository: "https://github.com/anomalyco/opencode.git",
			commit,
			integrationVersion: 2,
			lockSha256: sha256(lock),
			files: {
				"bun.lock": sha256(lock),
				"neta-fork.json": sha256(marker),
				"packages/cli/src/acp/service.ts": sha256("export {};\n"),
				"packages/tui/src/neta/shell.tsx": sha256(shell),
			},
		}),
	);
	return { root, fork, shell };
}

test("selects a source fork only when it matches the reviewed pin", async () => {
	const { root, fork } = await fixture();
	try {
		expect(openCodeInvocation({ root, environment: { NETA_OPENCODE_DIR: fork, NETA_BUN: "fixture-bun" } })).toEqual({
			command: "fixture-bun",
			args: ["run", "--cwd", join(fork, "packages/cli"), "./src/index.ts"],
			apiVersion: 2,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses a source fork when a reviewed UI file drifts", async () => {
	const { root, fork, shell } = await fixture();
	try {
		await writeFile(join(fork, "packages/tui/src/neta/shell.tsx"), `${shell}// unreviewed tab bar\n`);
		expect(() => openCodeInvocation({ root, environment: { NETA_OPENCODE_DIR: fork } })).toThrow(
			"does not match the reviewed integration (reviewed source differs: packages/tui/src/neta/shell.tsx)",
		);
		expect(() => openCodeInvocation({ root, environment: { NETA_OPENCODE_DIR: fork } })).toThrow(
			"NETA_OPENCODE_DIR=/path/to/clean-neta-opencode-v2 bun run setup:opencode",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("preserves an explicit OpenCode binary override", () => {
	expect(openCodeInvocation({ environment: { NETA_OPENCODE_BIN: "/custom/opencode" } })).toEqual({
		command: "/custom/opencode",
		args: [],
	});
});
