/**
 * The whole launch path, end to end: `neta` detects a CLI on PATH, generates
 * that vendor's config, starts it, and cleans up after it exits. The vendor is
 * a fixture that records how it was called, so this exercises everything except
 * the model itself.
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));
const run = promisify(execFile);

interface LaunchRecord {
	argv: string[];
	cwd: string;
	/** Config files as they were when the leader started, before Neta cleaned up. */
	files: Record<string, string>;
	env: Record<string, string | null>;
}

const dirs: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A directory holding a shim named like the vendor's binary, first on PATH. */
function fakeBackend(name: string): string {
	const dir = scratch(`neta-bin-${name}-`);
	const shim = join(dir, name);
	writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${FAKE_LEADER} "$@"\n`, "utf-8");
	chmodSync(shim, 0o755);
	return dir;
}

async function launch(backend: string, extra: string[] = []): Promise<LaunchRecord> {
	const binDir = fakeBackend(backend);
	const agentDir = scratch("neta-home-");
	const cwd = scratch("neta-repo-");
	const record = join(scratch("neta-record-"), "launch.json");

	await run(process.execPath, [CLI, "--leader", backend, "--mux", "none", ...extra], {
		cwd,
		env: {
			...process.env,
			PATH: `${binDir}${delimiter}${process.env.PATH}`,
			NETA_DIR: agentDir,
			FAKE_LEADER_RECORD: record,
			// Keep the Codex overlay away from the developer's real home.
			CODEX_HOME: join(agentDir, "codex"),
		},
	});

	return JSON.parse(readFileSync(record, "utf-8")) as LaunchRecord;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("neta (launching a leader)", () => {
	it("starts Claude Code with instructions, a control plane and restrictions", async () => {
		const launched = await launch("claude");

		const prompt = launched.argv[launched.argv.indexOf("--append-system-prompt") + 1];
		expect(prompt).toContain("You are Neta, a leader");
		expect(prompt).toContain("neta_spawn");

		const mcp = JSON.parse(launched.files[launched.argv[launched.argv.indexOf("--mcp-config") + 1]]);
		expect(mcp.mcpServers.neta.args.at(-1)).toBe("mcp");

		const settings = JSON.parse(launched.files[launched.argv[launched.argv.indexOf("--settings") + 1]]);
		expect(settings.permissions.deny).toContain("Edit");
		expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("guard");

		expect(launched.env.NETA_SOCKET).toMatch(/neta-.*\.sock$/);
		expect(launched.env.NETA_LEADER_TOKEN).toHaveLength(32);
		expect(launched.env.NETA_LEADER_BACKEND).toBe("claude");
	});

	it("starts Codex sandboxed, with its instructions in an overlay home", async () => {
		const launched = await launch("codex");

		expect(launched.argv).toContain('sandbox_mode="read-only"');
		expect(launched.argv).toContain('approval_policy="never"');
		expect(launched.env.CODEX_HOME).toContain("codex-home");
		expect(launched.files[join(launched.env.CODEX_HOME ?? "", "AGENTS.md")]).toContain("You are Neta");
	});

	it("starts OpenCode with one inline config", async () => {
		const launched = await launch("opencode");

		const config = JSON.parse(launched.env.OPENCODE_CONFIG_CONTENT ?? "{}");
		expect(config.permission.edit).toBe("deny");
		expect(config.mcp.neta.command.at(-1)).toBe("mcp");
	});

	// Panes are opened by the control plane, which is a child of the leader
	// rather than of the launcher, so `--mux` has to travel by environment.
	it("passes the multiplexer choice down to the process that opens panes", async () => {
		const launched = await launch("claude");

		expect(launched.env.NETA_MUX).toBe("none");
		expect(launched.env.NETA_PANES).toBe("1");
	});

	it("passes arguments after -- through to the vendor CLI", async () => {
		const launched = await launch("claude", ["--", "--model", "opus"]);

		expect(launched.argv.slice(-2)).toEqual(["--model", "opus"]);
	});

	// Generated config carries a token; leaving it in /tmp after the session
	// would leave a usable key lying around.
	it("removes the generated config when the leader exits", async () => {
		const launched = await launch("claude");

		expect(existsSync(launched.argv[launched.argv.indexOf("--mcp-config") + 1])).toBe(false);
	});

	it("refuses to lead with a CLI that is not installed", async () => {
		const agentDir = scratch("neta-home-");
		await expect(
			run(process.execPath, [CLI, "--leader", "codex"], {
				cwd: scratch("neta-repo-"),
				env: { ...process.env, PATH: fakeBackend("claude"), NETA_DIR: agentDir },
			}),
		).rejects.toThrow(/asked for "codex".*Installed: claude/s);
	});
});
