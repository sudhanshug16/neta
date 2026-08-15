/**
 * tmux adapter.
 *
 * tmux takes a command and its arguments as separate argv entries and runs them
 * without a shell, so worker tasks and file paths never need quoting.
 */

import { spawnSync } from "node:child_process";
import { findOnPath } from "../detect.ts";
import type { MuxAdapter, ProcessSpec } from "./types.ts";

/** `tmux new-session -s <name> -- cmd args…` */
export function newSessionArgs(sessionName: string, leader: ProcessSpec): string[] {
	return ["new-session", "-s", sessionName, "--", leader.command, ...leader.args];
}

/**
 * `tmux new-window -d -n <title> -c <cwd> -- cmd args…`
 *
 * A window, not a split: workers belong beside the leader, not on top of it.
 * Splitting the leader's window shrinks the thing the user is actually typing
 * into, and five workers make it unusable. `-d` leaves the leader focused, and
 * the window closes by itself when the watcher exits.
 */
export function newWindowArgs(title: string, spec: ProcessSpec, cwd: string): string[] {
	return ["new-window", "-d", "-n", title, "-c", cwd, "-e", `NETA_PANE=${title}`, "--", spec.command, ...spec.args];
}

export class TmuxAdapter implements MuxAdapter {
	readonly id = "tmux" as const;

	available(): boolean {
		return findOnPath("tmux") !== undefined;
	}

	inSession(): boolean {
		return Boolean(process.env.TMUX);
	}

	wrapLeader(leader: ProcessSpec, sessionName: string): ProcessSpec | undefined {
		if (this.inSession()) return undefined;
		return { command: "tmux", args: newSessionArgs(sessionName, leader), env: leader.env };
	}

	openPane(title: string, spec: ProcessSpec, cwd: string): boolean {
		if (!this.inSession()) return false;
		const result = spawnSync("tmux", newWindowArgs(title, spec, cwd), {
			env: { ...process.env, ...spec.env },
			stdio: "ignore",
		});
		return result.status === 0;
	}
}
