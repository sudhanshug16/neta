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

export interface LeaderLaunchContext {
	backend: DetectedLeaderBackend;
	cwd: string;
	/** Scratch directory for generated config; removed when the session ends. */
	sessionDir: string;
	sessionId: string;
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

export interface LeaderAdapter {
	readonly id: DetectedLeaderBackend["id"];
	prepare(context: LeaderLaunchContext): Promise<LeaderLaunch>;
}

/** Environment every control-plane process needs, whichever vendor starts it. */
export function controlPlaneEnv(context: LeaderLaunchContext): Record<string, string> {
	return {
		NETA_SOCKET: context.socket,
		NETA_LEADER_TOKEN: context.token,
		NETA_SESSION_ID: context.sessionId,
		NETA_LEADER_BACKEND: context.backend.id,
	};
}

/** The `neta mcp` command line, as command plus arguments. */
export function controlPlaneCommand(context: LeaderLaunchContext): { command: string; args: string[] } {
	return { command: context.invocation.command, args: [...context.invocation.prefixArgs, "mcp"] };
}
