/**
 * What each vendor is actually told. These are the flags and config keys that
 * were verified against the installed CLIs; if a vendor renames one, this is
 * where it shows up.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter, DENIED_TOOLS } from "../src/adapters/claude.ts";
import { CodexAdapter, createHomeOverlay, preserveRefreshedAuth } from "../src/adapters/codex.ts";
import { OpenCodeAdapter } from "../src/adapters/opencode.ts";
import type { LeaderLaunchContext } from "../src/adapters/types.ts";

const dirs: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "neta-adapter-"));
	dirs.push(dir);
	return dir;
}

function context(overrides: Partial<LeaderLaunchContext> = {}): LeaderLaunchContext {
	return {
		backend: {
			id: "claude",
			name: "Claude Code",
			binary: "claude",
			install: "npm i -g",
			path: "/usr/local/bin/claude",
		},
		cwd: "/repo",
		sessionDir: scratch(),
		sessionId: "s1",
		socket: "/tmp/neta-s1.sock",
		token: "tok",
		leaderPrompt: "# You are Neta, a leader",
		invocation: { command: "/usr/bin/node", prefixArgs: ["/opt/neta/cli.js"] },
		strictMcp: false,
		extraArgs: [],
		...overrides,
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Claude Code adapter", () => {
	it("passes the instructions, the control plane and the restrictions", async () => {
		const ctx = context();
		const launch = await new ClaudeAdapter().prepare(ctx);

		expect(launch.command).toBe("/usr/local/bin/claude");
		expect(launch.args).toContain("--append-system-prompt");
		expect(launch.args[launch.args.indexOf("--append-system-prompt") + 1]).toContain("You are Neta");

		const mcp = JSON.parse(readFileSync(launch.args[launch.args.indexOf("--mcp-config") + 1], "utf-8"));
		expect(mcp.mcpServers.neta.command).toBe("/usr/bin/node");
		expect(mcp.mcpServers.neta.args).toEqual(["/opt/neta/cli.js", "mcp"]);
		expect(mcp.mcpServers.neta.env.NETA_SOCKET).toBe("/tmp/neta-s1.sock");
		expect(mcp.mcpServers.neta.env.NETA_LEADER_TOKEN).toBe("tok");
	});

	it("denies the edit tools and guards bash", async () => {
		const launch = await new ClaudeAdapter().prepare(context());

		const settings = JSON.parse(readFileSync(launch.args[launch.args.indexOf("--settings") + 1], "utf-8"));
		expect(settings.permissions.deny).toEqual(DENIED_TOOLS);
		const hook = settings.hooks.PreToolUse[0];
		expect(hook.matcher).toBe("Bash");
		expect(hook.hooks[0].command).toBe("'/usr/bin/node' '/opt/neta/cli.js' 'guard'");
	});

	it("only hides the user's own MCP servers when asked to", async () => {
		expect((await new ClaudeAdapter().prepare(context())).args).not.toContain("--strict-mcp-config");
		expect((await new ClaudeAdapter().prepare(context({ strictMcp: true }))).args).toContain("--strict-mcp-config");
	});

	it("passes through the user's own arguments last", async () => {
		const launch = await new ClaudeAdapter().prepare(context({ extraArgs: ["--model", "opus"] }));

		expect(launch.args.slice(-2)).toEqual(["--model", "opus"]);
	});
});

describe("Codex adapter", () => {
	it("registers the control plane and turns on the read-only sandbox", async () => {
		const launch = await new CodexAdapter().prepare(
			context({ backend: { id: "codex", name: "Codex", binary: "codex", install: "", path: "/usr/bin/codex" } }),
		);

		expect(launch.args).toContain('sandbox_mode="read-only"');
		expect(launch.args).toContain('approval_policy="never"');
		expect(launch.args).toContain('mcp_servers.neta.command="/usr/bin/node"');
		expect(launch.args).toContain('mcp_servers.neta.args=["/opt/neta/cli.js", "mcp"]');
		expect(launch.args.find((arg) => arg.startsWith("mcp_servers.neta.env="))).toContain(
			'NETA_SOCKET = "/tmp/neta-s1.sock"',
		);
	});

	// Codex has no flag for extra instructions, so the session runs against a
	// home directory that is the real one plus our AGENTS.md.
	it("overlays the home directory, keeping the user's own global instructions", async () => {
		const realHome = scratch();
		writeFileSync(join(realHome, "AGENTS.md"), "Always use tabs.");
		writeFileSync(join(realHome, "auth.json"), '{"token":"real"}');
		mkdirSync(join(realHome, "sessions"));

		const overlay = await createHomeOverlay(realHome, scratch(), "# You are Neta, a leader");

		const agents = readFileSync(join(overlay, "AGENTS.md"), "utf-8");
		expect(agents).toContain("Always use tabs.");
		expect(agents).toContain("You are Neta");
		// Credentials and history stay in the real home, reached through links.
		expect(lstatSync(join(overlay, "auth.json")).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(overlay, "sessions")).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(overlay, "AGENTS.md")).isSymbolicLink()).toBe(false);
	});

	it("works when the user has no global instructions yet", async () => {
		const overlay = await createHomeOverlay(join(scratch(), "missing"), scratch(), "leader prompt");

		expect(readFileSync(join(overlay, "AGENTS.md"), "utf-8").trim()).toBe("leader prompt");
	});

	// Codex replaces auth.json when it refreshes a token, which would strand the
	// new credentials inside a temporary directory.
	it("copies refreshed credentials back into the real home", async () => {
		const realHome = scratch();
		writeFileSync(join(realHome, "auth.json"), '{"token":"old"}');
		const overlay = await createHomeOverlay(realHome, scratch(), "prompt");
		rmSync(join(overlay, "auth.json"));
		writeFileSync(join(overlay, "auth.json"), '{"token":"refreshed"}');

		preserveRefreshedAuth(overlay, realHome);

		expect(readFileSync(join(realHome, "auth.json"), "utf-8")).toContain("refreshed");
	});

	it("leaves the real credentials alone when nothing was refreshed", async () => {
		const realHome = scratch();
		writeFileSync(join(realHome, "auth.json"), '{"token":"real"}');
		const overlay = await createHomeOverlay(realHome, scratch(), "prompt");

		preserveRefreshedAuth(overlay, realHome);

		expect(readFileSync(join(realHome, "auth.json"), "utf-8")).toContain("real");
	});
});

describe("OpenCode adapter", () => {
	it("passes one inline config with instructions, MCP and permissions", async () => {
		const launch = await new OpenCodeAdapter().prepare(
			context({
				backend: { id: "opencode", name: "OpenCode", binary: "opencode", install: "", path: "/usr/bin/opencode" },
			}),
		);

		const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
		expect(existsSync(config.instructions[0])).toBe(true);
		expect(readFileSync(config.instructions[0], "utf-8")).toContain("You are Neta");
		expect(config.permission.edit).toBe("deny");
		expect(config.permission.bash["sed -i*"]).toBe("deny");
		expect(config.permission.bash["*"]).toBe("allow");
		expect(config.mcp.neta.command).toEqual(["/usr/bin/node", "/opt/neta/cli.js", "mcp"]);
		expect(config.mcp.neta.environment.NETA_LEADER_TOKEN).toBe("tok");
	});

	// Saying "read-only" about a leader whose shell is only pattern-checked would
	// overstate what the user is getting.
	it("says out loud that its restriction is weaker than a sandbox", async () => {
		const launch = await new OpenCodeAdapter().prepare(context());

		expect(launch.warnings.join(" ")).toContain("no kernel sandbox");
	});
});
