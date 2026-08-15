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
 * OpenCode's permission model does not sandbox the shell, so bash writes are
 * caught by the same guard Claude Code uses, wired in as a bash permission
 * pattern list. That is a weaker guarantee than Codex's kernel sandbox, and the
 * launcher says so rather than implying they are equivalent.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	controlPlaneCommand,
	controlPlaneEnv,
	type LeaderAdapter,
	type LeaderLaunch,
	type LeaderLaunchContext,
} from "./types.ts";

/** Shell shapes that edit files. Denied outright for a leader. */
export const DENIED_BASH_PATTERNS = [
	"sed -i*",
	"tee *",
	"patch *",
	"git commit*",
	"git apply*",
	"git checkout*",
	"git restore*",
	"git reset*",
];

export function openCodeConfig(context: LeaderLaunchContext, instructionsPath: string): string {
	const { command, args } = controlPlaneCommand(context);
	const bash: Record<string, "allow" | "deny"> = {};
	for (const pattern of DENIED_BASH_PATTERNS) bash[pattern] = "deny";
	bash["*"] = "allow";

	return JSON.stringify(
		{
			$schema: "https://opencode.ai/config.json",
			instructions: [instructionsPath],
			permission: { edit: "deny", bash },
			mcp: {
				neta: {
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

	async prepare(context: LeaderLaunchContext): Promise<LeaderLaunch> {
		const instructionsPath = join(context.sessionDir, "leader.md");
		await writeFile(instructionsPath, `${context.leaderPrompt}\n`, "utf-8");

		return {
			command: context.backend.path,
			args: [...context.extraArgs],
			env: { ...controlPlaneEnv(context), OPENCODE_CONFIG_CONTENT: openCodeConfig(context, instructionsPath) },
			warnings: [
				"OpenCode has no kernel sandbox: shell writes are blocked by permission patterns, which is weaker than Codex's read-only sandbox.",
			],
		};
	}
}
