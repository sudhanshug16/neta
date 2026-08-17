/**
 * Terminal multiplexer adapters.
 *
 * Neta does not draw any UI of its own. When a multiplexer is available, each
 * worker gets a pane showing its live log, so a person can look at what a
 * worker is doing without asking the leader. With no multiplexer, workers run
 * headless and the leader is the only way to see them — nothing else changes.
 */

export type MuxId = "zellij" | "tmux" | "none";

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
	openPane(title: string, spec: ProcessSpec, cwd: string, sessionName?: string): boolean;
	/** Rename the current Neta-owned window/tab. The caller proves ownership. */
	renameCurrentPane?(title: string): boolean;
}
