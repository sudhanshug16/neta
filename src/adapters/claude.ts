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
	assertNoConversationSelectors,
	controlPlaneCommand,
	controlPlaneEnv,
	type LeaderAdapter,
	type LeaderLaunch,
	type LeaderLaunchContext,
	MCP_SERVER_NAME,
} from "./types.ts";

/**
 * Typed tools a leader must not have.
 *
 * The subagent tools are here for the same reason as the edit tools. A leader
 * whose worker tools go missing has been observed spawning Claude Code's own
 * `Agent` instead — work that Neta cannot see, cannot gate, and cannot report
 * honestly, done under the name of delegation. Denying it turns that failure
 * back into what it should be: the leader stops and says the tools are gone.
 */
export const DENIED_TOOLS = ["Edit", "Write", "NotebookEdit", "Agent", "Task"];

/** Room for the longest `neta_wait` Neta will run, plus a margin. */
const MAX_WAIT_MS = 960_000;

export function mcpConfig(context: LeaderLaunchContext): string {
	const { command, args } = controlPlaneCommand(context);
	return JSON.stringify(
		{ mcpServers: { [MCP_SERVER_NAME]: { type: "stdio", command, args, env: controlPlaneEnv(context) } } },
		null,
		2,
	);
}

export function settingsConfig(context: LeaderLaunchContext): string {
	const guard = [context.invocation.command, ...context.invocation.prefixArgs, "guard"].map(shellQuote).join(" ");
	return JSON.stringify(
		{
			permissions: {
				// Without this, Claude Code asks the user to approve every worker tool
				// the first time the leader reaches for it — including inside a
				// blocking wait, where there is nobody watching to say yes. Delegation
				// is the point of the session; it is not a thing to approve.
				allow: [`mcp__${MCP_SERVER_NAME}`],
				deny: DENIED_TOOLS,
			},
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guard }] }],
			},
		},
		null,
		2,
	);
}

/** Pass-through arguments that would move the leader to another conversation. */
export const CLAUDE_CONVERSATION_SELECTORS = ["--continue", "-c", "--resume", "-r", "--session-id", "--fork-session"];

export class ClaudeAdapter implements LeaderAdapter {
	readonly id = "claude" as const;

	// Verified against Claude Code: `mcp__<server>__<tool>`.
	toolName(base: string): string {
		return `mcp__${MCP_SERVER_NAME}__${base}`;
	}

	async prepare(context: LeaderLaunchContext): Promise<LeaderLaunch> {
		assertNoConversationSelectors(context.extraArgs, CLAUDE_CONVERSATION_SELECTORS, "Claude Code");
		const mcpPath = join(context.sessionDir, "mcp.json");
		const settingsPath = join(context.sessionDir, "settings.json");
		await writeFile(mcpPath, mcpConfig(context), "utf-8");
		await writeFile(settingsPath, settingsConfig(context), "utf-8");

		// Claude Code takes the conversation id both ways: `--session-id` names a
		// fresh session, `--resume` reopens exactly that one. Everything else about
		// the launch — prompt, MCP registration, settings — is rebuilt from the
		// currently installed Neta, so a resumed session runs today's code.
		const conversation = context.resumeConversationId
			? ["--resume", context.resumeConversationId]
			: context.leaderConversationId
				? ["--session-id", context.leaderConversationId]
				: [];

		const args = [
			...conversation,
			"--append-system-prompt",
			context.leaderPrompt,
			"--mcp-config",
			mcpPath,
			"--settings",
			settingsPath,
			...(context.strictMcp ? ["--strict-mcp-config"] : []),
			...context.extraArgs,
		];

		return {
			command: context.backend.path,
			args,
			env: {
				...controlPlaneEnv(context),
				// `neta_wait` blocks on purpose — it is how an idle leader wakes with
				// results. Claude Code's default MCP tool timeout is two minutes, after
				// which it backgrounds the call and tells the leader to carry on, which
				// is the opposite of what a wait is for.
				MCP_TOOL_TIMEOUT: String(MAX_WAIT_MS),
			},
			warnings: [],
		};
	}
}
