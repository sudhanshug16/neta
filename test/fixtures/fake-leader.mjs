#!/usr/bin/env node
/**
 * Stands in for an installed agent CLI. It records how Neta launched it — argv
 * and the environment it was given — and exits, so a test can check the whole
 * launch path without a real model, a real login, or a real terminal UI.
 *
 * With FAKE_LEADER_HOST_MCP it also does the two things a real vendor CLI does
 * that resume depends on: it starts Neta's control plane the way its own MCP
 * config says to, and (Codex) it runs the SessionStart hook it was configured
 * with. That makes a resume test cover the real chain — launcher, vendor,
 * control plane, checkpoint — with no model anywhere in it.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Claude Code takes it as a file, Codex as `-c` TOML overrides, OpenCode inline in its config. */
function controlPlaneSpec(argv) {
	const configIndex = argv.indexOf("--mcp-config");
	if (configIndex !== -1) {
		const config = JSON.parse(readFileSync(argv[configIndex + 1], "utf-8")).mcpServers.neta;
		return { command: config.command, args: config.args, env: config.env };
	}
	const openCode = openCodeConfig();
	if (openCode) {
		const [command, ...args] = openCode.mcp.neta.command;
		return { command, args, env: openCode.mcp.neta.environment };
	}
	const value = (key) =>
		argv.find((arg) => arg.startsWith(`mcp_servers.neta.${key}=`))?.slice(`mcp_servers.neta.${key}=`.length);
	const command = value("command");
	if (!command) return undefined;
	const args = JSON.parse(value("args") ?? "[]");
	const env = Object.fromEntries(
		[...(value("env") ?? "").matchAll(/([A-Za-z_][A-Za-z0-9_]*) = ("(?:[^"\\]|\\.)*")/g)].map((match) => [
			match[1],
			JSON.parse(match[2]),
		]),
	);
	return { command: JSON.parse(command), args, env };
}

function openCodeConfig() {
	try {
		return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "");
	} catch {
		return undefined;
	}
}

/**
 * OpenCode reports the id it assigned by handing every bus event to its
 * plugins. The generated plugin is loaded and driven for real here, so the test
 * exercises Neta's plugin rather than a description of it.
 */
async function runOpenCodeCapturePlugin(sessionId) {
	const plugin = openCodeConfig()?.plugin?.[0];
	if (!plugin) return false;
	const module = await import(plugin);
	const hooks = await module.default({ directory: process.cwd() });
	// A subagent's child session and another directory's session must be ignored.
	const info = { id: sessionId, directory: process.cwd(), projectID: "p", title: "New session", version: "1" };
	await hooks.event?.({
		event: {
			type: "session.created",
			properties: { info: { ...info, id: "ses_childXXXXXXXXXXXXXXXXXX", parentID: info.id } },
		},
	});
	await hooks.event?.({
		event: {
			type: "session.created",
			properties: { info: { ...info, directory: "/somewhere/else", id: "ses_elsewhereXXXXXXXXXXXXXX" } },
		},
	});
	await hooks.event?.({ event: { type: "session.created", properties: { info } } });
	return true;
}

/** Codex reports the id it assigned by running its SessionStart hooks. */
function runSessionStartHooks(codexHome, sessionId) {
	let hooks;
	try {
		hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf-8")).hooks?.SessionStart ?? [];
	} catch {
		return false;
	}
	let ran = false;
	for (const matcher of hooks) {
		for (const hook of matcher.hooks ?? []) {
			if (hook.type !== "command") continue;
			const child = spawn("/bin/sh", ["-c", hook.command], { stdio: ["pipe", "inherit", "inherit"] });
			child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, source: "startup" }));
			ran = true;
		}
	}
	return ran;
}

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

// Neta gates its session-id capture on the installed CLI advertising the
// mechanism it needs: hooks for Codex, plugins for OpenCode.
if (process.argv.includes("--help") && process.env.FAKE_LEADER_HELP !== "") {
	console.log(
		process.env.FAKE_LEADER_HELP ??
			"Fake CLI\n  --dangerously-bypass-hook-trust  Run enabled hooks\n  opencode plugin <module>  install plugin\n",
	);
	process.exit(0);
}

const target = process.env.FAKE_LEADER_RECORD;
if (target) {
	const codexAgents = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "AGENTS.md") : undefined;
	const codexHooks = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "hooks.json") : undefined;
	const openCode = openCodeConfig();
	const openCodeFiles = openCode ? [...(openCode.instructions ?? []), ...(openCode.plugin ?? [])] : [];
	writeFileSync(
		target,
		JSON.stringify({
			argv: process.argv.slice(2),
			cwd: process.cwd(),
			files: capture([
				...process.argv.slice(2),
				codexAgents,
				codexHooks,
				...openCodeFiles.map((path) => (path.startsWith("file://") ? fileURLToPath(path) : path)),
			]),
			env: {
				NETA_DIR: process.env.NETA_DIR ?? null,
				NETA_SOCKET: process.env.NETA_SOCKET ?? null,
				NETA_LEADER_TOKEN: process.env.NETA_LEADER_TOKEN ?? null,
				NETA_SESSION_ID: process.env.NETA_SESSION_ID ?? null,
				NETA_CHECKPOINT_ID: process.env.NETA_CHECKPOINT_ID ?? null,
				NETA_LEADER_BACKEND: process.env.NETA_LEADER_BACKEND ?? null,
				NETA_LEADER_CONVERSATION_ID: process.env.NETA_LEADER_CONVERSATION_ID ?? null,
				NETA_LEADER_SESSION_DIR: process.env.NETA_LEADER_SESSION_DIR ?? null,
				NETA_RESUME: process.env.NETA_RESUME ?? null,
				CODEX_HOME: process.env.CODEX_HOME ?? null,
				OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null,
				NETA_MUX: process.env.NETA_MUX ?? null,
				NETA_PANES: process.env.NETA_PANES ?? null,
			},
		}),
		"utf-8",
	);
}

// Behave like the vendor host: start Neta's control plane as configured, run
// the session-start hook, and stay up until the test says the user quit.
if (process.env.FAKE_LEADER_HOST_MCP === "1") {
	const spec = controlPlaneSpec(process.argv.slice(2));
	if (!spec) {
		console.error("fake leader: no Neta MCP server was configured");
		process.exit(3);
	}
	const child = spawn(spec.command, spec.args, {
		env: { ...process.env, ...spec.env },
		stdio: ["pipe", "pipe", "inherit"],
	});
	// Captured before anything can await it: a control plane killed mid-test has
	// already closed by the time the fixture is told the user quit.
	const closed = new Promise((resolve) => child.once("close", resolve));
	child.on("error", () => {});
	child.stdin.on("error", () => {});
	if (process.env.OPENCODE_CONFIG_CONTENT) {
		const resumed = process.argv.indexOf("--session");
		const sessionId = resumed === -1 ? `ses_${randomUUID().replaceAll("-", "")}` : process.argv[resumed + 1];
		await runOpenCodeCapturePlugin(sessionId);
	} else if (process.env.CODEX_HOME) {
		const resumed = process.argv.indexOf("resume");
		const sessionId = resumed === -1 ? randomUUID() : process.argv[resumed + 1];
		runSessionStartHooks(process.env.CODEX_HOME, sessionId);
	}
	const quitFile = process.env.FAKE_LEADER_QUIT_FILE;
	const deadline = Date.now() + Number.parseInt(process.env.FAKE_LEADER_MAX_MS ?? "60000", 10);
	while (Date.now() < deadline) {
		if (quitFile && existsSync(quitFile)) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	// Closing stdin is how a real vendor tells the control plane the session is
	// over, and it is what makes the shutdown a graceful one.
	child.stdin.end();
	await closed;
	process.exit(0);
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
