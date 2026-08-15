#!/usr/bin/env node
/**
 * Stands in for an installed agent CLI. It records how Neta launched it — argv
 * and the environment it was given — and exits, so a test can check the whole
 * launch path without a real model, a real login, or a real terminal UI.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Generated config lives in a session directory that Neta removes as soon as
 * the leader exits, so it is read here while it still exists.
 */
function capture(paths) {
	const files = {};
	for (const path of paths) {
		try {
			if (path && existsSync(path) && statSync(path).isFile()) files[path] = readFileSync(path, "utf-8");
		} catch {
			// Not a readable file; nothing to record.
		}
	}
	return files;
}

const target = process.env.FAKE_LEADER_RECORD;
if (target) {
	const codexAgents = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "AGENTS.md") : undefined;
	writeFileSync(
		target,
		JSON.stringify({
			argv: process.argv.slice(2),
			cwd: process.cwd(),
			files: capture([...process.argv.slice(2), codexAgents]),
			env: {
				NETA_SOCKET: process.env.NETA_SOCKET ?? null,
				NETA_LEADER_TOKEN: process.env.NETA_LEADER_TOKEN ?? null,
				NETA_SESSION_ID: process.env.NETA_SESSION_ID ?? null,
				NETA_LEADER_BACKEND: process.env.NETA_LEADER_BACKEND ?? null,
				CODEX_HOME: process.env.CODEX_HOME ?? null,
				OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null,
				NETA_MUX: process.env.NETA_MUX ?? null,
				NETA_PANES: process.env.NETA_PANES ?? null,
			},
		}),
		"utf-8",
	);
}

process.exit(Number.parseInt(process.env.FAKE_LEADER_EXIT ?? "0", 10));
