/**
 * Codex as the leader.
 *
 * Codex has the strongest restriction of the three and the weakest instruction
 * hook, so this adapter is shaped by that trade.
 *
 * - Restriction: `-s read-only -a never` is a kernel sandbox. It covers the
 *   shell, so there is no `sed -i` hole to patch and no hook to install.
 * - MCP: `-c mcp_servers.neta.*` overrides, which is also why the control plane
 *   is reachable at all — the sandbox denies socket connections from the
 *   model's shell, but MCP servers run outside it.
 * - Instructions: Codex has no "append to system prompt" flag. It does read
 *   `$CODEX_HOME/AGENTS.md`, so Neta runs the session against an overlay home:
 *   every entry of the real home is symlinked in, and only AGENTS.md is
 *   replaced with the user's own text plus the leader instructions. Sessions,
 *   history and credentials still live in the real home through those links.
 */

import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	controlPlaneCommand,
	controlPlaneEnv,
	type LeaderAdapter,
	type LeaderLaunch,
	type LeaderLaunchContext,
	MCP_SERVER_NAME,
} from "./types.ts";

/** TOML basic string. Codex parses each `-c` value as TOML. */
function tomlString(value: string): string {
	return JSON.stringify(value);
}

export function configOverrides(context: LeaderLaunchContext): string[] {
	const { command, args } = controlPlaneCommand(context);
	const env = Object.entries(controlPlaneEnv(context))
		.map(([name, value]) => `${name} = ${tomlString(value)}`)
		.join(", ");
	return [
		"-c",
		`mcp_servers.${MCP_SERVER_NAME}.command=${tomlString(command)}`,
		"-c",
		`mcp_servers.${MCP_SERVER_NAME}.args=[${args.map(tomlString).join(", ")}]`,
		"-c",
		`mcp_servers.${MCP_SERVER_NAME}.env={ ${env} }`,
		"-c",
		'sandbox_mode="read-only"',
		"-c",
		'approval_policy="never"',
	];
}

export function realCodexHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.CODEX_HOME ?? join(homedir(), ".codex");
}

/**
 * Build the overlay home and return its path. Everything is a symlink except
 * AGENTS.md, so Codex behaves exactly as it does normally apart from the extra
 * instructions.
 */
export async function createHomeOverlay(realHome: string, sessionDir: string, instructions: string): Promise<string> {
	const overlay = join(sessionDir, "codex-home");
	await mkdir(overlay, { recursive: true });

	let existing = "";
	if (existsSync(realHome)) {
		for (const entry of readdirSync(realHome)) {
			if (entry === "AGENTS.md") continue;
			try {
				symlinkSync(join(realHome, entry), join(overlay, entry));
			} catch {
				// An entry we cannot link is one Codex will simply not see; that is
				// better than refusing to start the session.
			}
		}
		const agents = join(realHome, "AGENTS.md");
		if (existsSync(agents)) existing = `${readFileSync(agents, "utf-8").trim()}\n\n`;
	}

	await writeFile(join(overlay, "AGENTS.md"), `${existing}${instructions}\n`, "utf-8");
	return overlay;
}

/**
 * Codex refreshes credentials by replacing auth.json, which turns our symlink
 * into a real file inside the overlay. Copy it back so the refresh is not lost
 * when the session ends.
 */
export function preserveRefreshedAuth(overlay: string, realHome: string): void {
	const overlayAuth = join(overlay, "auth.json");
	if (!existsSync(overlayAuth)) return;
	try {
		if (lstatSync(overlayAuth).isSymbolicLink()) return;
		copyFileSync(overlayAuth, join(realHome, "auth.json"));
	} catch {
		// Nothing to do: the user logs in again if it mattered.
	}
}

export class CodexAdapter implements LeaderAdapter {
	readonly id = "codex" as const;

	// Verified against Codex: the same scheme Claude Code uses.
	toolName(base: string): string {
		return `mcp__${MCP_SERVER_NAME}__${base}`;
	}

	async prepare(context: LeaderLaunchContext): Promise<LeaderLaunch> {
		const realHome = realCodexHome();
		const overlay = await createHomeOverlay(realHome, context.sessionDir, context.leaderPrompt);

		return {
			command: context.backend.path,
			args: [...configOverrides(context), ...context.extraArgs],
			env: { ...controlPlaneEnv(context), CODEX_HOME: overlay },
			cleanup: async () => preserveRefreshedAuth(overlay, realHome),
			warnings: [],
		};
	}
}
