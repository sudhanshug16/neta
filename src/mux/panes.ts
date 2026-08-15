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
	onFailure: (message: string) => void,
): WorkerPaneHost | undefined {
	if (mux.id === "none" || !mux.inSession()) return undefined;

	return {
		open(worker: WorkerSummary) {
			try {
				const opened = mux.openPane(
					tabTitle(worker.id, worker.name),
					{
						command: invocation.command,
						args: [...invocation.prefixArgs, "watch", worker.id, "--session", sessionId, "--dir", agentDir],
					},
					cwd,
				);
				if (!opened) onFailure(`Could not open a ${mux.id} view for ${worker.id}; it runs headless.`);
			} catch (error) {
				onFailure(
					`Could not open a ${mux.id} view for ${worker.id}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		},
	};
}
