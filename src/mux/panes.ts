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
import type { WorkerSummary } from "../types.ts";
import type { MuxAdapter } from "./types.ts";

export type PaneOpenOutcome = { opened: true } | { opened: false; reason: string };

/**
 * What the tab is called. A tab bar has a few characters per tab before it
 * starts eliding, so the id comes first — it is what every command takes — and
 * the name gets whatever room is left.
 */
export function tabTitle(id: string, name: string, limit = 22): string {
	const label = `${id} ${name}`.replace(/\s+/g, " ").trim();
	return label.length <= limit ? label : `${label.slice(0, limit - 1).trimEnd()}…`;
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
	const openView = (title: string, target: string): PaneOpenOutcome => {
		try {
			const opened = mux.openPane(
				title,
				{
					command: invocation.command,
					args: [...invocation.prefixArgs, "watch", target, "--session", sessionId, "--dir", agentDir],
				},
				cwd,
				sessionName,
			);
			if (opened) return { opened: true };
			return { opened: false, reason: `could not open a ${mux.id} view` };
		} catch (error) {
			return { opened: false, reason: error instanceof Error ? error.message : String(error) };
		}
	};

	return {
		open: (worker: WorkerSummary) => openView(tabTitle(worker.id, worker.name), worker.id),
		openRoom: (room: string) => openView(tabTitle(room, ""), room),
	};
}
