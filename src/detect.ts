/**
 * Leader backend detection.
 *
 * The leader runs in the native UI of an installed agent CLI (Claude Code,
 * Codex, OpenCode). A backend counts as installed when its CLI is on PATH;
 * login state is only knowable by starting it, so auth problems surface at
 * launch with instructions rather than blocking detection.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export interface LeaderBackendSpec {
	/** Backend key; matches the `backends` settings entry used to launch it. */
	id: "claude" | "codex" | "opencode";
	/** Human name, shown when picking a leader. */
	name: string;
	/** Executable whose presence on PATH marks the backend as installed. */
	binary: string;
	/** Install command to show when nothing is installed. */
	install: string;
}

/** Detection order is also default-preference order. */
export const LEADER_BACKENDS: LeaderBackendSpec[] = [
	{ id: "claude", name: "Claude Code", binary: "claude", install: "npm install -g @anthropic-ai/claude-code" },
	{ id: "codex", name: "Codex", binary: "codex", install: "npm install -g @openai/codex" },
	{ id: "opencode", name: "OpenCode", binary: "opencode", install: "npm install -g opencode-ai" },
];

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"];

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function findOnPath(binary: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
	const names = process.platform === "win32" ? WINDOWS_EXTENSIONS.map((extension) => binary + extension) : [binary];
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

export interface DetectedLeaderBackend extends LeaderBackendSpec {
	/** Absolute path of the detected CLI. */
	path: string;
}

export function detectLeaderBackends(env: Record<string, string | undefined> = process.env): DetectedLeaderBackend[] {
	const found: DetectedLeaderBackend[] = [];
	for (const spec of LEADER_BACKENDS) {
		const path = findOnPath(spec.binary, env);
		if (path) found.push({ ...spec, path });
	}
	return found;
}
