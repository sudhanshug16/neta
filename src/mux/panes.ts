/**
 * Worker views.
 *
 * Each worker gets a tab running `neta watch <id>`, which streams that worker's
 * log. The tab is a window onto the worker, not the worker itself: the agent
 * process stays under Neta's control, so watching one costs nothing and closing
 * one breaks nothing.
 *
 * The command carries the session id and the directory to find it in, rather
 * than relying on the environment: multiplexers start these from their own
 * server process, whose environment is not ours.
 */

import type { CliInvocation } from "../cli-shim.ts";
import type { WorkerPaneHost } from "../orchestrator/manager.ts";
import { isTerminalState, type WorkerState, type WorkerSummary } from "../types.ts";
import { TmuxAdapter } from "./tmux.ts";
import type { MuxAdapter, ProcessSpec } from "./types.ts";
import { ZellijAdapter } from "./zellij.ts";

export type PaneOpenOutcome = { opened: true } | { opened: false; reason: string };

/**
 * What the tab is called. A tab bar has a few characters per tab before it
 * starts eliding, so the id comes first — it is what every command takes — and
 * the name gets whatever room is left.
 */
export function tabTitle(id: string, name: string, stateOrLimit?: WorkerState | number, limit = 22): string {
	const state = typeof stateOrLimit === "number" ? undefined : stateOrLimit;
	if (typeof stateOrLimit === "number") limit = stateOrLimit;
	const marker = state === "done" ? "✓" : state === "failed" ? "failed" : state === "killed" ? "killed" : "";
	const suffix = marker ? ` ${marker}` : "";
	const label = `${id} ${name}`.replace(/\s+/g, " ").trim();
	if (`${label}${suffix}`.length <= limit) return `${label}${suffix}`;
	const available = Math.max(1, limit - suffix.length - 1);
	return `${label.slice(0, available).trimEnd()}…${suffix}`;
}

export const NETA_PANE_ENV = "NETA_PANE";

/**
 * A watcher may rename only a pane Neta marked when it opened it. That guard
 * keeps `neta watch` in an ordinary user-owned terminal from renaming it.
 */
export function markWorkerPaneTerminal(
	worker: WorkerSummary,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (!isTerminalState(worker.state) || !env[NETA_PANE_ENV]) return false;
	const mux = env.TMUX ? new TmuxAdapter() : env.ZELLIJ ? new ZellijAdapter() : undefined;
	return mux?.renameCurrentPane?.(tabTitle(worker.id, worker.name, worker.state)) ?? false;
}

export function createPaneHost(
	mux: MuxAdapter,
	invocation: CliInvocation,
	sessionId: string,
	cwd: string,
	agentDir: string,
	sessionName?: string,
): WorkerPaneHost | undefined {
	if (mux.id === "none" || (!sessionName && !mux.inSession())) return undefined;

	// `neta watch` takes a worker id or a room name; the pane command is the same.
	const open = (title: string, spec: ProcessSpec): PaneOpenOutcome => {
		try {
			const opened = mux.openPane(
				title,
				{ ...spec, env: { ...spec.env, [NETA_PANE_ENV]: title } },
				cwd,
				sessionName,
			);
			if (opened) return { opened: true };
			return { opened: false, reason: `could not open a ${mux.id} view` };
		} catch (error) {
			return { opened: false, reason: error instanceof Error ? error.message : String(error) };
		}
	};
	const openView = (title: string, target: string): PaneOpenOutcome =>
		open(title, {
			command: invocation.command,
			args: [...invocation.prefixArgs, "watch", target, "--session", sessionId, "--dir", agentDir],
		});

	return {
		open: (worker: WorkerSummary) => openView(tabTitle(worker.id, worker.name), worker.id),
		openRoom: (room: string) => openView(tabTitle(room, ""), room),
		attach: (worker: WorkerSummary, resume: ProcessSpec) => open(tabTitle(worker.id, `${worker.name} tui`), resume),
	};
}
