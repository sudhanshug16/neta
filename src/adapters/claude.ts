/**
 * Claude Code as the leader.
 *
 * Three mechanisms, all native to Claude Code:
 *
 * - `--append-system-prompt` carries the leader instructions.
 * - `--mcp-config` registers Neta's control plane.
 * - `--settings` denies the file-editing tools and installs a PreToolUse hook
 *   on Bash. The deny rules stop the typed tools; the hook is what stops
 *   `sed -i` and `echo > file`, which are the ways a determined model edits
 *   files without an edit tool.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellQuote } from "../cli-shim.ts";
import {
	controlPlaneCommand,
	controlPlaneEnv,
	type LeaderAdapter,
	type LeaderLaunch,
	type LeaderLaunchContext,
} from "./types.ts";

/** Typed tools a leader must not have. */
export const DENIED_TOOLS = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

export function mcpConfig(context: LeaderLaunchContext): string {
	const { command, args } = controlPlaneCommand(context);
	return JSON.stringify(
		{ mcpServers: { neta: { type: "stdio", command, args, env: controlPlaneEnv(context) } } },
		null,
		2,
	);
}

export function settingsConfig(context: LeaderLaunchContext): string {
	const guard = [context.invocation.command, ...context.invocation.prefixArgs, "guard"].map(shellQuote).join(" ");
	return JSON.stringify(
		{
			permissions: { deny: DENIED_TOOLS },
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guard }] }],
			},
		},
		null,
		2,
	);
}

export class ClaudeAdapter implements LeaderAdapter {
	readonly id = "claude" as const;

	async prepare(context: LeaderLaunchContext): Promise<LeaderLaunch> {
		const mcpPath = join(context.sessionDir, "mcp.json");
		const settingsPath = join(context.sessionDir, "settings.json");
		await writeFile(mcpPath, mcpConfig(context), "utf-8");
		await writeFile(settingsPath, settingsConfig(context), "utf-8");

		const args = [
			"--append-system-prompt",
			context.leaderPrompt,
			"--mcp-config",
			mcpPath,
			"--settings",
			settingsPath,
			...(context.strictMcp ? ["--strict-mcp-config"] : []),
			...context.extraArgs,
		];

		return { command: context.backend.path, args, env: controlPlaneEnv(context), warnings: [] };
	}
}
