/**
 * Leader adapters.
 *
 * Neta does not host the leader's conversation — the vendor's own CLI does.
 * An adapter's whole job is to turn one Neta session into that vendor's way of
 * saying three things: here are your instructions, here is an MCP server, and
 * you may not edit files.
 *
 * The third one uses each vendor's native enforcement rather than a prompt,
 * because a leader that can edit will eventually edit.
 */

import type { CliInvocation } from "../cli-shim.ts";
import type { DetectedLeaderBackend } from "../detect.ts";
import type { MuxId } from "../mux/types.ts";

export interface LeaderLaunchContext {
	backend: DetectedLeaderBackend;
	cwd: string;
	/** Scratch directory for generated config; removed when the session ends. */
	sessionDir: string;
	sessionId: string;
	/** Stable durable id, paired with a fresh ephemeral sessionId on every run. */
	logicalSessionId?: string;
	/**
	 * Where this logical session's generated vendor state lives, across runs.
	 * Unlike `sessionDir` it is Neta-owned and outlives the process, because
	 * vendors record absolute paths into their own session indexes.
	 */
	leaderSessionDir?: string;
	/**
	 * The conversation id Neta assigned to a fresh session, for vendors that let
	 * the caller name one. Absent where the vendor assigns its own.
	 */
	leaderConversationId?: string;
	/** The exact vendor conversation to reopen. Absent for a fresh session. */
	resumeConversationId?: string;
	/** Where the vendor's session-start hook reports the id it assigned. */
	captureCommand?: { command: string; args: string[] };
	/** Directory the durable checkpoint lives in, for hooks that run outside this process. */
	agentDir?: string;
	/** Worker channel address and the token that authorizes managing workers. */
	socket: string;
	token: string;
	/** The leader's operating instructions, already built. */
	leaderPrompt: string;
	/** How to re-invoke the `neta` binary, for the MCP server command line. */
	invocation: CliInvocation;
	/** Hide the user's own MCP servers, leaving only Neta's. */
	strictMcp: boolean;
	/** Arguments the user passed through to the vendor CLI. */
	extraArgs: string[];
	/** The pane target resolved by the launcher before this adapter registers MCP. */
	mux: MuxId;
	panes: boolean;
	muxSessionName?: string;
	/** Native mux locators, needed when a vendor clears the MCP child's environment. */
	tmux?: string;
	zellij?: string;
	zellijSessionName?: string;
	zellijPaneId?: string;
	/** Session-private handoff written after a fresh Zellij assigns the leader pane. */
	zellijIdentityFile?: string;
}

export interface LeaderLaunch {
	command: string;
	args: string[];
	/** Added to the inherited environment. */
	env: Record<string, string>;
	/** Runs after the leader exits, before the session directory is removed. */
	cleanup?: () => Promise<void>;
	/** Restrictions this adapter could not apply, to be reported honestly at launch. */
	warnings: string[];
}

/** The name Neta's control plane is registered under, in every vendor's config. */
export const MCP_SERVER_NAME = "neta";

/**
 * Refuse a pass-through argument that would pick a different conversation.
 *
 * Neta owns which conversation the leader is in: a fresh session gets an id
 * Neta assigned, and a resume gets the exact id the checkpoint recorded. A
 * `--continue` or a second `--resume` after `--` would quietly land the user in
 * a different conversation while Neta went on writing this session's history.
 */
export function assertNoConversationSelectors(extraArgs: string[], selectors: readonly string[], vendor: string): void {
	const conflict = extraArgs.find((arg) => selectors.includes(arg) || selectors.some((s) => arg.startsWith(`${s}=`)));
	if (conflict) {
		throw new Error(
			`Neta manages the ${vendor} conversation for this session, so "${conflict}" cannot be passed through. ` +
				`Use \`neta resume <session-id>\` to reopen a session by its exact id.`,
		);
	}
}

export interface LeaderAdapter {
	readonly id: DetectedLeaderBackend["id"];
	prepare(context: LeaderLaunchContext): Promise<LeaderLaunch>;
	/**
	 * What the leader must actually type to call one of our tools.
	 *
	 * Hosts namespace MCP tools by server, and they do not agree on how, so a
	 * prompt that says `neta_spawn` is wrong everywhere. Each of these was read
	 * off the running CLI, not guessed.
	 */
	toolName(base: string): string;
}

/** Environment every control-plane process needs, whichever vendor starts it. */
export function controlPlaneEnv(context: LeaderLaunchContext): Record<string, string> {
	return {
		NETA_SOCKET: context.socket,
		NETA_LEADER_TOKEN: context.token,
		NETA_SESSION_ID: context.sessionId,
		NETA_CHECKPOINT_ID: context.logicalSessionId ?? context.sessionId,
		NETA_LEADER_BACKEND: context.backend.id,
		// Codex starts MCP servers with a cleared environment, so a control plane
		// that inherited nothing must still be told which Neta directory owns this
		// session, which conversation it is in, and whether it is a resume.
		...(context.agentDir ? { NETA_DIR: context.agentDir } : {}),
		...(context.leaderSessionDir ? { NETA_LEADER_SESSION_DIR: context.leaderSessionDir } : {}),
		...((context.resumeConversationId ?? context.leaderConversationId)
			? { NETA_LEADER_CONVERSATION_ID: (context.resumeConversationId ?? context.leaderConversationId) as string }
			: {}),
		...(context.resumeConversationId ? { NETA_RESUME: "1" } : {}),
		NETA_MUX: context.mux,
		NETA_PANES: context.panes ? "1" : "0",
		...(context.muxSessionName ? { NETA_MUX_SESSION_NAME: context.muxSessionName } : {}),
		...(context.tmux ? { TMUX: context.tmux } : {}),
		...(context.zellij ? { ZELLIJ: context.zellij } : {}),
		...(context.zellijSessionName ? { ZELLIJ_SESSION_NAME: context.zellijSessionName } : {}),
		...(context.zellijPaneId ? { ZELLIJ_PANE_ID: context.zellijPaneId } : {}),
		...(context.zellijIdentityFile ? { NETA_ZELLIJ_IDENTITY_FILE: context.zellijIdentityFile } : {}),
	};
}

/** The `neta mcp` command line, as command plus arguments. */
export function controlPlaneCommand(context: LeaderLaunchContext): { command: string; args: string[] } {
	return { command: context.invocation.command, args: [...context.invocation.prefixArgs, "mcp"] };
}
