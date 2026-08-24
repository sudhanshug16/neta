/**
 * tmux adapter.
 *
 * tmux takes a command and its arguments as separate argv entries and runs them
 * without a shell, so worker tasks and file paths never need quoting.
 */

import { spawnSync } from "node:child_process";
import { findOnPath } from "../detect.ts";
import type { MuxAdapter, PaneOpenOutcome, ProcessSpec } from "./types.ts";

interface CommandResult {
	status: number | null;
	stdout: string;
	stderr?: string;
	error?: { message: string };
}

interface CommandOptions {
	env?: Record<string, string | undefined>;
}

export type TmuxCommandRunner = (command: string, args: string[], options?: CommandOptions) => CommandResult;

const runCommand: TmuxCommandRunner = (command, args, options) =>
	spawnSync(command, args, { encoding: "utf-8", env: options?.env });

/** tmux expands `#` sequences in format-aware title arguments; `##` is a literal `#`. */
export function tmuxLiteralTitle(title: string): string {
	return title.replaceAll("#", "##");
}

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
	const environment = Object.entries(spec.env ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([name, value]) => ["-e", `${name}=${value}`]);
	return [
		"new-window",
		...(sessionName ? ["-t", sessionName] : []),
		"-d",
		"-n",
		tmuxLiteralTitle(title),
		"-c",
		cwd,
		...environment,
		"--",
		spec.command,
		...spec.args,
	];
}

/** Rename only the window containing the calling watcher. */
export function renameWindowArgs(target: string, title: string): string[] {
	return ["rename-window", "-t", target, tmuxLiteralTitle(title)];
}

export class TmuxAdapter implements MuxAdapter {
	readonly id = "tmux" as const;
	private readonly run: TmuxCommandRunner;

	constructor(run: TmuxCommandRunner = runCommand) {
		this.run = run;
	}

	available(): boolean {
		return findOnPath("tmux") !== undefined;
	}

	inSession(): boolean {
		return Boolean(process.env.TMUX);
	}

	sessionName(): string | undefined {
		if (!this.inSession()) return undefined;
		const result = this.run("tmux", ["display-message", "-p", "#S"]);
		return result.status === 0 ? result.stdout.trim() || undefined : undefined;
	}

	wrapLeader(leader: ProcessSpec, sessionName: string): ProcessSpec | undefined {
		if (this.inSession()) return undefined;
		return { command: "tmux", args: newSessionArgs(sessionName, leader), env: leader.env };
	}

	openPane(title: string, spec: ProcessSpec, cwd: string, sessionName?: string): PaneOpenOutcome {
		const targetSession = sessionName ?? this.sessionName();
		if (!targetSession && !this.inSession()) return { status: "failed", reason: "tmux: no active session" };
		const result = this.run("tmux", newWindowArgs(title, spec, cwd, sessionName), {
			env: { ...process.env, ...spec.env },
		});
		if (result.status === 0) return { status: "opened" };
		// tmux explains itself on stderr; throwing that away leaves a user with a
		// missing window and no reason for it.
		return {
			status: "failed",
			reason: `tmux: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`,
		};
	}

	renameCurrentPane(title: string, env: Record<string, string | undefined> = process.env): boolean {
		const target = env.TMUX_PANE;
		if (env.NETA_MUX !== this.id || !env.NETA_PANE || !target) return false;
		const result = this.run("tmux", renameWindowArgs(target, title));
		return result.status === 0;
	}
}
