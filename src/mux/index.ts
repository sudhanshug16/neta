/**
 * Picking a multiplexer.
 *
 * `auto` prefers Zellij, then tmux, then nothing. An explicit choice that is
 * not installed falls back to nothing rather than failing the session: panes
 * are a convenience, and losing them must never stop the work.
 */

import type { MuxMode } from "../settings.ts";
import { TmuxAdapter } from "./tmux.ts";
import type { MuxAdapter, ProcessSpec } from "./types.ts";
import { ZellijAdapter } from "./zellij.ts";

/** Headless: no panes, workers still run. */
export class NoMux implements MuxAdapter {
	readonly id = "none" as const;

	available(): boolean {
		return true;
	}

	inSession(): boolean {
		return false;
	}

	wrapLeader(): undefined {
		return undefined;
	}

	openPane(): boolean {
		return false;
	}
}

export function selectMux(
	mode: MuxMode,
	adapters: MuxAdapter[] = [new ZellijAdapter(), new TmuxAdapter()],
): MuxAdapter {
	if (mode === "none") return new NoMux();
	if (mode === "auto") {
		// Being inside a session beats preference order: a user already sitting in
		// tmux should get tmux panes, even with zellij installed.
		return adapters.find((a) => a.inSession() && a.available()) ?? adapters.find((a) => a.available()) ?? new NoMux();
	}
	const chosen = adapters.find((adapter) => adapter.id === mode);
	return chosen?.available() ? chosen : new NoMux();
}

export type { MuxAdapter, ProcessSpec };
export { TmuxAdapter, ZellijAdapter };
