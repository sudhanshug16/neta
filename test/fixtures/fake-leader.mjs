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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** What this stand-in claims to support, which is what Neta reads it off. */
const HELP =
	process.env.FAKE_LEADER_HELP ??
	"Fake CLI\n  --dangerously-bypass-hook-trust  Run enabled hooks\n  opencode plugin <module>  install plugin\n";

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

/**
 * Codex's hook trust, as Codex 0.147 implements it.
 *
 * A hook is filed under `<hooks file>:<event>:<group>:<hook>` and only runs when
 * the effective config records a `trusted_hash` matching what Codex computes for
 * the hook itself. The real hash function is Codex's; this fixture uses its own,
 * because what a test can check is that Neta arranged trust for the exact key
 * Codex reported, not that it guessed a hash it was told.
 */
function hookInventory(codexHome) {
	let hooksPath;
	let config;
	try {
		hooksPath = join(realpathSync(codexHome), "hooks.json");
		config = JSON.parse(readFileSync(hooksPath, "utf-8")).hooks ?? {};
	} catch {
		return [];
	}
	let trust = "";
	try {
		trust = readFileSync(join(codexHome, "config.toml"), "utf-8");
	} catch {
		// No config means nothing is trusted yet.
	}
	const entries = [];
	for (const [event, groups] of Object.entries(config)) {
		const eventName = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
		for (const [groupIndex, group] of (groups ?? []).entries()) {
			for (const [hookIndex, hook] of (group.hooks ?? []).entries()) {
				if (hook.type !== "command") continue;
				const key = `${hooksPath}:${eventName}:${groupIndex}:${hookIndex}`;
				const currentHash = `sha256:${createHash("sha256").update(`${eventName}:${hook.command}`).digest("hex")}`;
				const recorded = new RegExp(
					`\\[hooks\\.state\\."${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"]\\s*\\n\\s*trusted_hash\\s*=\\s*"([^"]+)"`,
				).exec(trust)?.[1];
				entries.push({
					key,
					eventName: event.charAt(0).toLowerCase() + event.slice(1),
					handlerType: "command",
					command: hook.command,
					sourcePath: hooksPath,
					enabled: true,
					isManaged: false,
					currentHash,
					trustStatus: recorded === undefined ? "untrusted" : recorded === currentHash ? "trusted" : "modified",
				});
			}
		}
	}
	return entries;
}

/** `codex app-server`, enough of it for `hooks/list`. */
async function runAppServer() {
	const entries = hookInventory(process.env.CODEX_HOME ?? ".");
	const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
	let buffered = "";
	process.stdin.on("data", (chunk) => {
		buffered += chunk.toString();
		let index = buffered.indexOf("\n");
		while (index >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			index = buffered.indexOf("\n");
			let request;
			try {
				request = JSON.parse(line);
			} catch {
				continue;
			}
			if (request.method === "initialize") {
				reply({ id: request.id, result: { userAgent: "fake/0.0.0", codexHome: process.env.CODEX_HOME ?? "" } });
			} else if (request.method === "hooks/list") {
				reply({
					id: request.id,
					result: { data: [{ cwd: process.cwd(), hooks: entries, warnings: [], errors: [] }] },
				});
			}
		}
	});
	await new Promise(() => {});
}

/**
 * Codex reports the id it assigned by running its SessionStart hooks — but only
 * the ones it has been told to trust, exactly like the installed build.
 *
 * Whether it withholds untrusted hooks at all is read from the same place Neta
 * reads it: this fixture's own `--help`. A build that does not advertise
 * `--dangerously-bypass-hook-trust` is a build from before hook trust, and it
 * runs its hooks as configured.
 */
function runSessionStartHooks(codexHome, sessionId, argv) {
	const bypass = argv.includes("--dangerously-bypass-hook-trust") || !/--dangerously-bypass-hook-trust/.test(HELP);
	let ran = false;
	for (const entry of hookInventory(codexHome)) {
		if (entry.eventName !== "sessionStart") continue;
		if (!bypass && entry.trustStatus !== "trusted" && entry.trustStatus !== "managed") continue;
		const child = spawn("/bin/sh", ["-c", entry.command], { stdio: ["pipe", "inherit", "inherit"] });
		child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, source: "startup" }));
		ran = true;
	}
	return ran;
}

/**
 * Call Neta's control plane the way a real vendor host does: over the MCP stdio
 * transport it was configured with, as JSON-RPC.
 *
 * A leader reaches most of the orchestrator through these tools and nothing
 * else — notes and room posts have no CLI at all — so a test that wants a
 * session's state built the way a session builds it drives it from here.
 * `FAKE_LEADER_MCP_CALLS` is a JSON array of `{name, arguments}`; every reply is
 * written to `FAKE_LEADER_MCP_RESULT`.
 */
async function callControlPlaneTools(child, calls) {
	const pending = new Map();
	let buffered = "";
	child.stdout.setEncoding("utf-8");
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		let index = buffered.indexOf("\n");
		while (index >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			index = buffered.indexOf("\n");
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const waiting = pending.get(message.id);
			if (waiting) {
				pending.delete(message.id);
				waiting(message);
			}
		}
	});

	let nextId = 1;
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, resolve);
			const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 30000);
			timer.unref?.();
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});

	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "fake-leader", version: "0.0.0" },
	});
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const results = [];
	for (const call of calls) {
		const reply = await request("tools/call", { name: call.name, arguments: call.arguments ?? {} });
		results.push({ name: call.name, error: reply.error, result: reply.result });
	}
	return results;
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
	console.log(HELP);
	process.exit(0);
}

// Answering `hooks/list` is a capability probe, not a session: it must never
// record a launch or start a control plane.
if (process.argv[2] === "app-server") {
	await runAppServer();
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
		runSessionStartHooks(process.env.CODEX_HOME, sessionId, process.argv.slice(2));
	}
	if (process.env.FAKE_LEADER_MCP_CALLS) {
		const calls = JSON.parse(readFileSync(process.env.FAKE_LEADER_MCP_CALLS, "utf-8"));
		const results = await callControlPlaneTools(child, calls);
		if (process.env.FAKE_LEADER_MCP_RESULT) {
			writeFileSync(process.env.FAKE_LEADER_MCP_RESULT, JSON.stringify(results), "utf-8");
		}
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
