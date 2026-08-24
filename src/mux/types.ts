/**
 * Terminal multiplexer adapters.
 *
 * Neta does not draw any UI of its own. When a multiplexer is available, each
 * worker gets a pane showing its live log, so a person can look at what a
 * worker is doing without asking the leader. With no multiplexer, workers run
 * headless and the leader is the only way to see them — nothing else changes.
 */

export type MuxId = "zellij" | "tmux" | "none";

/** Exact identity needed before Neta can reconcile or clean up a view. */
export interface PaneIdentity {
	mux: Exclude<MuxId, "none">;
	sessionName: string;
	title: string;
	tabId?: number;
	/** IDs present before the open command, retained only in memory for safe reconciliation. */
	beforeTabIds?: number[];
}

export type PaneOpenOutcome =
	| { status: "opened"; identity?: PaneIdentity }
	| { status: "unconfirmed"; reason: string; identity: PaneIdentity }
	| { status: "failed"; reason: string; identity?: PaneIdentity };

export type PaneCloseOutcome =
	| { status: "closed" }
	| { status: "ambiguous"; reason: string }
	| { status: "failed"; reason: string };

/** A process to run: no shell, so nothing needs quoting. */
export interface ProcessSpec {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface MuxAdapter {
	readonly id: MuxId;
	/** The multiplexer's binary is on PATH. */
	available(): boolean;
	/** This process is running inside one of its sessions, so panes can be opened. */
	inSession(): boolean;
	/** The current session's name, when the multiplexer exposes one. */
	sessionName(): string | undefined;
	/**
	 * Wrap the leader so it starts inside a fresh multiplexer session. Returns
	 * undefined when it should be run as-is (already inside a session, or this
	 * adapter does not manage sessions).
	 */
	wrapLeader(leader: ProcessSpec, sessionName: string, sessionDir: string): ProcessSpec | undefined;
	/** Open a pane running the command, targeting a named session when one is known. */
	openPane(
		title: string,
		spec: ProcessSpec,
		cwd: string,
		sessionName?: string,
	): PaneOpenOutcome | Promise<PaneOpenOutcome>;
	/** Recheck a successful launch whose tab listing was stale or ambiguous. */
	reconcilePane?(identity: PaneIdentity): PaneOpenOutcome | Promise<PaneOpenOutcome>;
	/** Close only an exact, independently verified view identity. */
	closePane?(identity: PaneIdentity): PaneCloseOutcome | Promise<PaneCloseOutcome>;
	/** Rename the exact Neta-owned window/tab identified by the caller's environment. */
	renameCurrentPane?(title: string, env?: Record<string, string | undefined>): boolean;
}
