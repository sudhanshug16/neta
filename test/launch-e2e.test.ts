/**
 * The whole launch path, end to end: `neta` detects a CLI on PATH, generates
 * that vendor's config, starts it, and cleans up after it exits. The vendor is
 * a fixture that records how it was called, so this exercises everything except
 * the model itself.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFile, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ZellijAdapter } from "../src/mux/zellij.ts";
import { listSessions, writeSessionRecord } from "../src/session.ts";
import { waitFor } from "./helpers.ts";

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

async function launch(
	backend: string,
	extra: string[] = [],
	beforeLaunch?: (agentDir: string) => void,
	extraEnv: Record<string, string> = {},
): Promise<LaunchRecord> {
	const binDir = fakeBackend(backend);
	const agentDir = scratch("neta-home-");
	const cwd = scratch("neta-repo-");
	const record = join(scratch("neta-record-"), "launch.json");
	beforeLaunch?.(agentDir);

	await run(process.execPath, [CLI, "--leader", backend, "--mux", "none", ...extra], {
		cwd,
		env: {
			...process.env,
			PATH: `${binDir}${delimiter}${process.env.PATH}`,
			NETA_DIR: agentDir,
			FAKE_LEADER_RECORD: record,
			...extraEnv,
			// Keep the Codex overlay away from the developer's real home.
			CODEX_HOME: join(agentDir, "codex"),
		},
	});

	return JSON.parse(readFileSync(record, "utf-8")) as LaunchRecord;
}

function launchProcess(
	backend: string,
	cwd: string,
	env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
	const child = spawn(process.execPath, [CLI, "--leader", backend, "--mux", "none"], {
		cwd,
		env,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code: signal ? 1 : (code ?? 0), stderr }));
	});
}

function codexMcpEnvironment(launched: LaunchRecord): Record<string, string> {
	const override = launched.argv.find((arg) => arg.startsWith("mcp_servers.neta.env="));
	if (!override) throw new Error("Codex launch did not declare the Neta MCP environment");
	return Object.fromEntries(
		[...override.matchAll(/([A-Z][A-Z0-9_]*) = ("(?:[^"\\]|\\.)*")/g)].map((match) => [
			match[1],
			JSON.parse(match[2]) as string,
		]),
	);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("neta (launching a leader)", () => {
	it("starts Claude Code with instructions, a control plane and restrictions", async () => {
		const launched = await launch("claude");

		const prompt = launched.argv[launched.argv.indexOf("--append-system-prompt") + 1];
		expect(prompt).toContain("You are Neta, a leader");
		// The name Claude Code will actually accept, not the bare tool name.
		expect(prompt).toContain("mcp__neta__neta_delegate");
		expect(prompt).not.toContain("mcp__neta__neta_spawn");

		const mcp = JSON.parse(launched.files[launched.argv[launched.argv.indexOf("--mcp-config") + 1]]);
		expect(mcp.mcpServers.neta.args.at(-1)).toBe("mcp");
		expect(mcp.mcpServers.neta.env.NETA_MUX).toBe("none");
		expect(mcp.mcpServers.neta.env.NETA_PANES).toBe("0");

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
		expect(launched.argv).toContain('mcp_servers.neta.default_tools_approval_mode="approve"');
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
		expect(launched.env.NETA_PANES).toBe("0");
	});

	// A launch with no terminal cannot ask which tiers to staff, and must not
	// guess a narrower answer: a piped or CI launch keeps the whole ladder.
	it("enables every worker tier when nothing could be asked", async () => {
		const launched = await launch("claude");

		expect(launched.env.NETA_TIERS).toBe("apprentice,journeyman,expert,architect");
	});

	it("passes the real Zellij caller identity to Codex's manager without ambient secrets", async () => {
		const binDir = fakeBackend("codex");
		const zellij = join(binDir, "zellij");
		writeFileSync(zellij, "#!/bin/sh\nexit 0\n", "utf-8");
		chmodSync(zellij, 0o755);
		const agentDir = scratch("neta-home-");
		const cwd = scratch("neta-repo-");
		const record = join(scratch("neta-record-"), "launch.json");

		await run(process.execPath, [CLI, "--leader", "codex", "--mux", "zellij"], {
			cwd,
			env: {
				...process.env,
				PATH: `${binDir}${delimiter}${process.env.PATH}`,
				NETA_DIR: agentDir,
				FAKE_LEADER_RECORD: record,
				CODEX_HOME: join(agentDir, "codex"),
				ZELLIJ: "0",
				ZELLIJ_SESSION_NAME: "user-session",
				ZELLIJ_PANE_ID: "41",
				AWS_SECRET_ACCESS_KEY: "must-not-reach-manager",
			},
		});

		const managerEnv = codexMcpEnvironment(JSON.parse(readFileSync(record, "utf-8")) as LaunchRecord);
		expect(managerEnv).toMatchObject({
			NETA_MUX: "zellij",
			NETA_MUX_SESSION_NAME: "user-session",
			ZELLIJ: "0",
			ZELLIJ_SESSION_NAME: "user-session",
			ZELLIJ_PANE_ID: "41",
		});
		expect(managerEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
	});

	it("does not forge a missing Zellij pane identity and pane opening fails closed", async () => {
		const binDir = fakeBackend("codex");
		const zellij = join(binDir, "zellij");
		writeFileSync(zellij, "#!/bin/sh\nexit 0\n", "utf-8");
		chmodSync(zellij, 0o755);
		const agentDir = scratch("neta-home-");
		const cwd = scratch("neta-repo-");
		const record = join(scratch("neta-record-"), "launch.json");

		await run(process.execPath, [CLI, "--leader", "codex", "--mux", "zellij"], {
			cwd,
			env: {
				...process.env,
				PATH: `${binDir}${delimiter}${process.env.PATH}`,
				NETA_DIR: agentDir,
				FAKE_LEADER_RECORD: record,
				CODEX_HOME: join(agentDir, "codex"),
				ZELLIJ: "0",
				ZELLIJ_SESSION_NAME: "user-session",
				ZELLIJ_PANE_ID: "",
			},
		});

		const managerEnv = codexMcpEnvironment(JSON.parse(readFileSync(record, "utf-8")) as LaunchRecord);
		expect(managerEnv.ZELLIJ_PANE_ID).toBeUndefined();
		let calls = 0;
		const adapter = new ZellijAdapter(() => {
			calls += 1;
			return { status: 0, stdout: "[]" };
		}, managerEnv);
		expect(adapter.openPane("ro1 scout", { command: "neta", args: ["watch", "ro1"] }, cwd, "user-session")).toBe(
			false,
		);
		expect(calls).toBe(0);
	});

	it("passes arguments after -- through to the vendor CLI", async () => {
		const launched = await launch("claude", ["--", "--model", "opus"]);

		expect(launched.argv.slice(-2)).toEqual(["--model", "opus"]);
	});

	it("sweeps a crashed session before starting a leader", async () => {
		const socket = join(tmpdir(), `neta-launch-stale-${process.pid}-${Date.now()}.sock`);
		const launched = await launch("claude", [], (agentDir) => {
			writeFileSync(socket, "stale");
			writeSessionRecord(
				{
					id: "dead",
					socket,
					token: "token",
					cwd: "/stale",
					leader: "claude",
					pid: 2147483646,
					startedAt: 0,
				},
				agentDir,
			);
		});

		expect(launched.env.NETA_SOCKET).toMatch(/neta-.*\.sock$/);
		expect(existsSync(socket)).toBe(false);
	});

	it("tears down a dead same-directory tmux husk before starting a fresh session", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-home-");
		const cwd = scratch("neta-repo-");
		const muxRecord = join(scratch("neta-mux-record-"), "tmux.txt");
		const tmux = join(binDir, "tmux");
		writeFileSync(tmux, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TMUX_RECORD"\n', "utf-8");
		chmodSync(tmux, 0o755);
		writeSessionRecord(
			{
				id: "dead-tmux-husk",
				socket: "/tmp/neta-dead-tmux-husk.sock",
				token: "token",
				cwd,
				leader: "claude",
				pid: 2147483646,
				startedAt: 0,
				mux: { id: "tmux", name: "neta-dead-tmux-husk" },
			},
			agentDir,
		);

		await run(process.execPath, [CLI, "--leader", "claude", "--mux", "none"], {
			cwd,
			env: {
				...process.env,
				PATH: `${binDir}${delimiter}${process.env.PATH}`,
				NETA_DIR: agentDir,
				TMUX_RECORD: muxRecord,
				FAKE_LEADER_REGISTER_SESSION: "1",
			},
		});

		expect(readFileSync(muxRecord, "utf-8").trim().split("\n")).toEqual([
			"kill-session",
			"-t",
			"neta-dead-tmux-husk",
		]);
		const records = readdirSync(join(agentDir, "sessions")).filter((name) => name.endsWith(".json"));
		expect(records).toHaveLength(1);
		expect(records[0]).not.toBe("dead-tmux-husk.json");
	});

	it("refuses a second headless launch in the same real directory without adding a registry entry", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-home-");
		const cwd = scratch("neta-repo-");
		writeSessionRecord(
			{
				id: "headless-live",
				socket: "/tmp/neta-headless-live.sock",
				token: "token",
				cwd,
				leader: "claude",
				pid: process.pid,
				startedAt: 1_700_000_000_000,
			},
			agentDir,
		);

		await expect(
			run(process.execPath, [CLI, "--leader", "claude", "--mux", "none"], {
				cwd,
				env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}`, NETA_DIR: agentDir },
			}),
		).rejects.toThrow(
			/headless-live.*pid .*started .*neta workers --session headless-live.*neta watch <worker>.*neta kill <worker>.*kill /s,
		);
		expect(readdirSync(join(agentDir, "sessions")).filter((name) => name.endsWith(".json"))).toEqual([
			"headless-live.json",
		]);
	});

	it("reattaches a live tmux directory session instead of launching another leader", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-home-");
		const cwd = scratch("neta-repo-");
		const attachRecord = join(scratch("neta-attach-"), "tmux.txt");
		const tmux = join(binDir, "tmux");
		writeFileSync(tmux, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TMUX_ATTACH_RECORD"\n', "utf-8");
		chmodSync(tmux, 0o755);
		writeSessionRecord(
			{
				id: "tmux-live",
				socket: "/tmp/neta-tmux-live.sock",
				token: "token",
				cwd,
				leader: "claude",
				pid: process.pid,
				startedAt: Date.now(),
				mux: { id: "tmux", name: "neta-tmux-live" },
			},
			agentDir,
		);

		await run(process.execPath, [CLI, "--leader", "claude", "--mux", "none"], {
			cwd,
			env: {
				...process.env,
				PATH: `${binDir}${delimiter}${process.env.PATH}`,
				NETA_DIR: agentDir,
				TMUX_ATTACH_RECORD: attachRecord,
			},
		});

		expect(readFileSync(attachRecord, "utf-8").trim().split("\n")).toEqual(["attach", "-t", "neta-tmux-live"]);
		expect(readdirSync(join(agentDir, "sessions")).filter((name) => name.endsWith(".json"))).toEqual([
			"tmux-live.json",
		]);
	});

	it("prefers an attachable same-directory session regardless of registry file order", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-home-");
		const cwd = scratch("neta-repo-");
		const attachRecord = join(scratch("neta-attach-"), "tmux.txt");
		const tmux = join(binDir, "tmux");
		writeFileSync(tmux, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TMUX_ATTACH_RECORD"\n', "utf-8");
		chmodSync(tmux, 0o755);
		writeSessionRecord(
			{
				id: "a-headless-newer",
				socket: "/tmp/neta-headless-newer.sock",
				token: "token",
				cwd,
				leader: "claude",
				pid: process.pid,
				startedAt: 1_700_000_000_001,
			},
			agentDir,
		);
		writeSessionRecord(
			{
				id: "z-tmux-older",
				socket: "/tmp/neta-tmux-older.sock",
				token: "token",
				cwd,
				leader: "claude",
				pid: process.pid,
				startedAt: 1_700_000_000_000,
				mux: { id: "tmux", name: "neta-tmux-older" },
			},
			agentDir,
		);

		await run(process.execPath, [CLI, "--leader", "claude", "--mux", "none"], {
			cwd,
			env: {
				...process.env,
				PATH: `${binDir}${delimiter}${process.env.PATH}`,
				NETA_DIR: agentDir,
				TMUX_ATTACH_RECORD: attachRecord,
			},
		});

		expect(readFileSync(attachRecord, "utf-8").trim().split("\n")).toEqual(["attach", "-t", "neta-tmux-older"]);
	});

	it("lists every same-directory headless session when none can be reattached", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-home-");
		const cwd = scratch("neta-repo-");
		writeSessionRecord(
			{
				id: "first-headless",
				socket: "/tmp/neta-first-headless.sock",
				token: "token",
				cwd,
				leader: "claude",
				pid: process.pid,
				startedAt: 1_700_000_000_000,
			},
			agentDir,
		);
		writeSessionRecord(
			{
				id: "second-headless",
				socket: "/tmp/neta-second-headless.sock",
				token: "token",
				cwd,
				leader: "claude",
				pid: process.pid,
				startedAt: 1_700_000_000_001,
			},
			agentDir,
		);

		await expect(
			run(process.execPath, [CLI, "--leader", "claude", "--mux", "none"], {
				cwd,
				env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}`, NETA_DIR: agentDir },
			}),
		).rejects.toThrow(
			/second-headless.*pid .*started .*headless.*neta workers --session second-headless.*neta watch <worker>.*neta kill <worker>.*kill .*first-headless.*pid .*started .*headless.*neta workers --session first-headless.*neta watch <worker>.*neta kill <worker>.*kill /s,
		);
	});

	it("allows another directory to launch its own session", async () => {
		const otherDir = scratch("neta-other-repo-");
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-home-");
		writeSessionRecord(
			{
				id: "other-live",
				socket: "/tmp/neta-other-live.sock",
				token: "token",
				cwd: otherDir,
				leader: "claude",
				pid: process.pid,
				startedAt: Date.now(),
			},
			agentDir,
		);
		const cwd = scratch("neta-repo-");
		const record = join(scratch("neta-record-"), "launch.json");

		await run(process.execPath, [CLI, "--leader", "claude", "--mux", "none"], {
			cwd,
			env: {
				...process.env,
				PATH: `${binDir}${delimiter}${process.env.PATH}`,
				NETA_DIR: agentDir,
				FAKE_LEADER_RECORD: record,
			},
		});

		expect((JSON.parse(readFileSync(record, "utf-8")) as LaunchRecord).cwd).toBe(realpathSync(cwd));
	});

	it("sweeps a dead same-directory record before registering the replacement", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-home-");
		const cwd = scratch("neta-repo-");
		writeSessionRecord(
			{
				id: "dead-same-dir",
				socket: "/tmp/neta-dead-same-dir.sock",
				token: "token",
				cwd,
				leader: "claude",
				pid: 2147483646,
				startedAt: 0,
			},
			agentDir,
		);
		const record = join(scratch("neta-record-"), "launch.json");

		await run(process.execPath, [CLI, "--leader", "claude", "--mux", "none"], {
			cwd,
			env: {
				...process.env,
				PATH: `${binDir}${delimiter}${process.env.PATH}`,
				NETA_DIR: agentDir,
				FAKE_LEADER_RECORD: record,
				FAKE_LEADER_REGISTER_SESSION: "1",
			},
		});

		const records = readdirSync(join(agentDir, "sessions")).filter((name) => name.endsWith(".json"));
		expect(records).toHaveLength(1);
		expect(records[0]).not.toBe("dead-same-dir.json");
	});

	it("registers exactly one session when two launches race in one directory", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-home-");
		const cwd = scratch("neta-repo-");
		const env = {
			...process.env,
			PATH: `${binDir}${delimiter}${process.env.PATH}`,
			NETA_DIR: agentDir,
			FAKE_LEADER_REGISTER_SESSION: "1",
			FAKE_LEADER_HOLD_MS: "1000",
		};

		const first = launchProcess("claude", cwd, env);
		const second = launchProcess("claude", cwd, env);
		await waitFor(() => expect(listSessions(agentDir)).toHaveLength(1), 5000);
		expect(listSessions(agentDir)).toHaveLength(1);
		const outcomes = await Promise.all([first, second]);
		expect(outcomes.map((outcome) => outcome.code).sort()).toEqual([0, 1]);
		expect(outcomes.find((outcome) => outcome.code === 1)?.stderr).toContain("runs headless");
	});

	// Generated config carries a token; leaving it in /tmp after the session
	// would leave a usable key lying around.
	it("removes the generated config when the leader exits", async () => {
		const launched = await launch("claude");

		expect(existsSync(launched.argv[launched.argv.indexOf("--mcp-config") + 1])).toBe(false);
	});

	// The first real launch died here: zellij refused the arguments Neta gave it
	// and the user got no session at all. Panes are a convenience; losing them
	// must cost the panes, not the work.
	it("still starts the leader when the multiplexer fails to start", async () => {
		const binDir = fakeBackend("claude");
		const brokenMux = join(binDir, "zellij");
		writeFileSync(brokenMux, "#!/bin/sh\necho 'There is no active session!' >&2\nexit 1\n", "utf-8");
		chmodSync(brokenMux, 0o755);
		const agentDir = scratch("neta-home-");
		const record = join(scratch("neta-record-"), "launch.json");

		const { stderr } = await run(process.execPath, [CLI, "--leader", "claude", "--mux", "zellij"], {
			cwd: scratch("neta-repo-"),
			env: {
				...process.env,
				PATH: binDir,
				ZELLIJ: "",
				NETA_DIR: agentDir,
				FAKE_LEADER_RECORD: record,
			},
		});

		expect(stderr).toContain("zellij exited immediately");
		expect(stderr).toContain("without panes");
		const launched = JSON.parse(readFileSync(record, "utf-8")) as LaunchRecord;
		expect(launched.argv).toContain("--append-system-prompt");
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

	it("refuses an explicitly requested disabled leader backend", async () => {
		const binDir = fakeBackend("opencode");
		const agentDir = scratch("neta-home-");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ backends: { opencode: { disabled: true } } }));

		await expect(
			run(process.execPath, [CLI, "--leader", "opencode", "--mux", "none"], {
				cwd: scratch("neta-repo-"),
				env: { ...process.env, PATH: binDir, NETA_DIR: agentDir },
			}),
		).rejects.toThrow('Backend "opencode" is disabled in settings.');
	});
});
