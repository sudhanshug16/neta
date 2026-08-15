/**
 * Worker panes.
 *
 * Each worker gets a pane running `neta watch <id>`, which streams that
 * worker's log. The pane is a window onto the worker, not the worker itself:
 * the agent process stays under Neta's control, so watching one costs nothing
 * and closing one breaks nothing.
 *
 * The pane command carries a session id rather than the socket path and token,
 * because multiplexers start panes from their own server process with their own
 * environment. `neta watch` looks the rest up in the session registry, which is
 * readable only by this user.
 */

import type { CliInvocation } from "../cli-shim.ts";
import type { WorkerPaneHost } from "../orchestrator/manager.ts";
import type { MuxAdapter } from "./types.ts";

export function createPaneHost(
	mux: MuxAdapter,
	invocation: CliInvocation,
	sessionId: string,
	cwd: string,
	onFailure: (message: string) => void,
): WorkerPaneHost | undefined {
	if (mux.id === "none" || !mux.inSession()) return undefined;
	return {
		open(worker) {
			const opened = mux.openPane(
				`${worker.id} ${worker.role}`,
				{
					command: invocation.command,
					args: [...invocation.prefixArgs, "watch", worker.id, "--session", sessionId],
				},
				cwd,
			);
			if (!opened) onFailure(`Could not open a ${mux.id} pane for ${worker.id}; it runs headless.`);
		},
	};
}
