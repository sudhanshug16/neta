/** Adapter lookup by backend id. */

import type { DetectedLeaderBackend } from "../detect.ts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { OpenCodeAdapter } from "./opencode.ts";
import type { LeaderAdapter } from "./types.ts";

export function adapterFor(id: DetectedLeaderBackend["id"]): LeaderAdapter {
	switch (id) {
		case "claude":
			return new ClaudeAdapter();
		case "codex":
			return new CodexAdapter();
		case "opencode":
			return new OpenCodeAdapter();
	}
}

export { ClaudeAdapter, CodexAdapter, OpenCodeAdapter };
export type { LeaderAdapter, LeaderLaunch, LeaderLaunchContext } from "./types.ts";
