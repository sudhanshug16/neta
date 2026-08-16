/**
 * OpenCode as the leader.
 *
 * OpenCode takes everything from one config object, which Neta passes inline
 * through `OPENCODE_CONFIG_CONTENT` so nothing is written into the user's
 * config directory:
 *
 * - `instructions` points at a file holding the leader instructions.
 * - `mcp.neta` registers the control plane as a local server.
 * - `permission.edit: "deny"` removes the edit tools.
 *
 * OpenCode's permission config accepts ordered glob rules for bash commands.
 * Start from deny and allow only read-only inspection commands. This remains
 * weaker than Codex's kernel sandbox, but avoids a denylist that silently lets
 * a newly-shaped write command through.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	controlPlaneCommand,
	controlPlaneEnv,
	type LeaderAdapter,
	type LeaderLaunch,
	type LeaderLaunchContext,
	MCP_SERVER_NAME,
} from "./types.ts";

/** Explicit inspection commands allowed after the catch-all deny rule. */
export const READ_ONLY_BASH_PATTERNS = [
	"ls",
	"ls *",
	"cat",
	"cat *",
	"grep",
	"grep *",
	"rg",
	"rg *",
	"find",
	"find *",
	"head",
	"head *",
	"tail",
	"tail *",
	"wc",
	"wc *",
	"pwd",
	"which *",
	"type *",
	"stat *",
	"file *",
	"du *",
	"df",
	"df *",
	"git status",
	"git status *",
	"git log",
	"git log *",
	"git diff",
	"git diff *",
	"git show",
	"git show *",
	"git branch",
	"git branch *",
	"git rev-parse *",
	"git ls-files",
	"git ls-files *",
	"git grep *",
	"git blame *",
	"git show-ref",
	"git show-ref *",
	"git worktree list",
];

export function openCodeConfig(context: LeaderLaunchContext, instructionsPath: string): string {
	const { command, args } = controlPlaneCommand(context);
	const bash: Record<string, "allow" | "deny"> = { "*": "deny" };
	for (const pattern of READ_ONLY_BASH_PATTERNS) bash[pattern] = "allow";

	return JSON.stringify(
		{
			$schema: "https://opencode.ai/config.json",
			instructions: [instructionsPath],
			permission: { edit: "deny", bash },
			mcp: {
				[MCP_SERVER_NAME]: {
					type: "local",
					command: [command, ...args],
					enabled: true,
					environment: controlPlaneEnv(context),
				},
			},
		},
		null,
		2,
	);
}

export class OpenCodeAdapter implements LeaderAdapter {
	readonly id = "opencode" as const;

	// Verified against OpenCode, which joins with one underscore and no prefix.
	toolName(base: string): string {
		return `${MCP_SERVER_NAME}_${base}`;
	}

	async prepare(context: LeaderLaunchContext): Promise<LeaderLaunch> {
		const instructionsPath = join(context.sessionDir, "leader.md");
		await writeFile(instructionsPath, `${context.leaderPrompt}\n`, "utf-8");

		return {
			command: context.backend.path,
			args: [...context.extraArgs],
			env: { ...controlPlaneEnv(context), OPENCODE_CONFIG_CONTENT: openCodeConfig(context, instructionsPath) },
			warnings: [
				"OpenCode has no kernel sandbox: bash is denied by default and only read-only inspection commands are allowed, which is weaker than Codex's read-only sandbox.",
			],
		};
	}
}
