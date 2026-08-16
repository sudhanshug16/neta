#!/usr/bin/env node
/**
 * Stands in for an installed agent CLI. It records how Neta launched it — argv
 * and the environment it was given — and exits, so a test can check the whole
 * launch path without a real model, a real login, or a real terminal UI.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
				NETA_DIR: process.env.NETA_DIR ?? null,
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

// Launch tests use this to stand in for the control plane's durable registry
// write. The fixture is still a real leader process, so liveness checks use
// its actual pid just as they do in production.
if (process.env.FAKE_LEADER_REGISTER_SESSION === "1" && process.env.NETA_DIR && process.env.NETA_SESSION_ID) {
	const sessions = join(process.env.NETA_DIR, "sessions");
	mkdirSync(sessions, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(sessions, `${process.env.NETA_SESSION_ID}.json`),
		JSON.stringify({
			id: process.env.NETA_SESSION_ID,
			socket: process.env.NETA_SOCKET,
			token: process.env.NETA_LEADER_TOKEN,
			cwd: process.cwd(),
			leader: process.env.NETA_LEADER_BACKEND,
			pid: process.pid,
			startedAt: Date.now(),
			...(process.env.NETA_MUX_SESSION_NAME && (process.env.NETA_MUX === "zellij" || process.env.NETA_MUX === "tmux")
				? { mux: { id: process.env.NETA_MUX, name: process.env.NETA_MUX_SESSION_NAME } }
				: {}),
		}),
		"utf-8",
	);
	if (process.env.NETA_SESSION_LOCK_PATH && process.env.NETA_SESSION_LOCK_TOKEN) {
		const owner = join(process.env.NETA_SESSION_LOCK_PATH, "owner.json");
		try {
			if (JSON.parse(readFileSync(owner, "utf-8")).token === process.env.NETA_SESSION_LOCK_TOKEN)
				rmSync(process.env.NETA_SESSION_LOCK_PATH, { recursive: true, force: true });
		} catch {
			// A launcher that exited before this fixture is not a relevant test case.
		}
	}
}

const holdMs = Number.parseInt(process.env.FAKE_LEADER_HOLD_MS ?? "0", 10);
if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));

process.exit(Number.parseInt(process.env.FAKE_LEADER_EXIT ?? "0", 10));
