/**
 * tmux adapter.
 *
 * tmux takes a command and its arguments as separate argv entries and runs them
 * without a shell, so worker tasks and file paths never need quoting.
 */

import { spawnSync } from "node:child_process";
import { findOnPath } from "../detect.ts";
import type { MuxAdapter, ProcessSpec } from "./types.ts";

/** `tmux new-session -s <name> -e VAR=value -- cmd args…` */
export function newSessionArgs(sessionName: string, leader: ProcessSpec): string[] {
	const environment = Object.entries(leader.env ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([name, value]) => ["-e", `${name}=${value}`]);
	return ["new-session", "-s", sessionName, ...environment, "--", leader.command, ...leader.args];
}

/** `tmux attach -t <name>` reconnects a later `neta` invocation to its leader. */
export function attachSessionArgs(sessionName: string): string[] {
	return ["attach", "-t", sessionName];
}

/** `tmux kill-session -t <name>` removes a session whose leader is gone. */
export function killSessionArgs(sessionName: string): string[] {
	return ["kill-session", "-t", sessionName];
}

/**
 * `tmux new-window -d -n <title> -c <cwd> -- cmd args…`
 *
 * A window, not a split: workers belong beside the leader, not on top of it.
 * Splitting the leader's window shrinks the thing the user is actually typing
 * into, and five workers make it unusable. `-d` leaves the leader focused, and
 * the window closes by itself when the watcher exits.
 */
export function newWindowArgs(title: string, spec: ProcessSpec, cwd: string, sessionName?: string): string[] {
	return [
		"new-window",
		...(sessionName ? ["-t", sessionName] : []),
		"-d",
		"-n",
		title,
		"-c",
		cwd,
		"-e",
		`NETA_PANE=${title}`,
		"--",
		spec.command,
		...spec.args,
	];
}

export class TmuxAdapter implements MuxAdapter {
	readonly id = "tmux" as const;

	available(): boolean {
		return findOnPath("tmux") !== undefined;
	}

	inSession(): boolean {
		return Boolean(process.env.TMUX);
	}

	sessionName(): string | undefined {
		if (!this.inSession()) return undefined;
		const result = spawnSync("tmux", ["display-message", "-p", "#S"], { encoding: "utf-8" });
		return result.status === 0 ? result.stdout.trim() || undefined : undefined;
	}

	wrapLeader(leader: ProcessSpec, sessionName: string): ProcessSpec | undefined {
		if (this.inSession()) return undefined;
		return { command: "tmux", args: newSessionArgs(sessionName, leader), env: leader.env };
	}

	openPane(title: string, spec: ProcessSpec, cwd: string, sessionName?: string): boolean {
		if (!sessionName && !this.inSession()) return false;
		const result = spawnSync("tmux", newWindowArgs(title, spec, cwd, sessionName), {
			env: { ...process.env, ...spec.env },
			encoding: "utf-8",
		});
		if (result.status === 0) return true;
		// tmux explains itself on stderr; throwing that away leaves a user with a
		// missing window and no reason for it.
		throw new Error(`tmux: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
	}
}
