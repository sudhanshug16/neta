/**
 * Zellij adapter.
 *
 * Zellij starts a session from a layout file rather than from a command line,
 * so leading with it means writing a small KDL layout whose single pane runs
 * the leader. Worker panes are opened afterwards with `zellij action new-pane`.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findOnPath } from "../detect.ts";
import type { MuxAdapter, ProcessSpec } from "./types.ts";

interface CommandResult {
	status: number | null;
	stdout: string;
	stderr?: string;
	error?: { message: string };
}

interface CommandOptions {
	env?: Record<string, string | undefined>;
}

export type ZellijCommandRunner = (command: string, args: string[], options?: CommandOptions) => CommandResult;

const runCommand: ZellijCommandRunner = (command, args, options) =>
	spawnSync(command, args, { encoding: "utf-8", env: options?.env });

/** KDL strings escape backslash and double quote; nothing else needs quoting here. */
function kdlString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The layout the leader's session starts from.
 *
 * Two things here are not decoration. The tab template restores zellij's own
 * tab bar and status bar: a custom layout replaces them, and without them a
 * user gets worker tabs they cannot see and no on-screen hint for how to quit.
 * And `close_on_exit` on the leader means quitting the leader closes its pane,
 * which lets the session end on its own instead of stranding the user inside a
 * multiplexer they did not ask to be in.
 */
export function leaderLayout(leader: ProcessSpec): string {
	// Zellij sessions have their own server process. Starting the leader through
	// `env` makes this launch's values explicit even if a future server reuses an
	// earlier session's environment.
	const command = leader.env ? "/usr/bin/env" : leader.command;
	const args = leader.env
		? [
				...Object.entries(leader.env)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([name, value]) => `${name}=${value}`),
				leader.command,
				...leader.args,
			]
		: leader.args;
	const renderedArgs = args.map(kdlString).join(" ");
	const lines = [
		"layout {",
		"    default_tab_template {",
		"        pane size=1 borderless=true {",
		'            plugin location="zellij:tab-bar"',
		"        }",
		"        children",
		"        pane size=2 borderless=true {",
		'            plugin location="zellij:status-bar"',
		"        }",
		"    }",
		// The leader has to sit inside an explicit `tab`. A pane declared at the top
		// level becomes a tab that skips the template, which is why the leader's
		// tab had no tab bar while every worker tab did.
		`    tab name=${kdlString("leader")} {`,
		`        pane name=${kdlString("neta leader")} close_on_exit=true command=${kdlString(command)} {`,
		renderedArgs ? `            args ${renderedArgs}` : undefined,
		"        }",
		"    }",
		"}",
		"",
	];
	return lines.filter((line) => line !== undefined).join("\n");
}

/**
 * Start a new session running the layout.
 *
 * It has to be `--new-session-with-layout`, not `--layout`: combined with
 * `--session`, `--layout` means "add this layout as a tab to that session", so
 * zellij looks for a session that does not exist yet and exits with "There is
 * no active session!". `--new-session-with-layout` always creates one.
 */
export function newSessionArgs(sessionName: string, layoutPath: string): string[] {
	return [
		"--session",
		sessionName,
		"--new-session-with-layout",
		layoutPath,
		// Otherwise every finished session stays in `zellij list-sessions` as
		// "EXITED - attach to resurrect", and a few days of Neta leaves a list of
		// dead sessions the user has to clean up by hand. There is nothing to
		// resurrect: the leader and its workers are gone.
		"options",
		"--session-serialization",
		"false",
	];
}

/** `zellij attach <name>` reconnects a later `neta` invocation to its leader. */
export function attachSessionArgs(sessionName: string): string[] {
	return ["attach", sessionName];
}

/** `zellij kill-session <name>` removes a session whose leader is gone. */
export function killSessionArgs(sessionName: string): string[] {
	return ["kill-session", sessionName];
}

/**
 * `zellij action new-tab --name <title> --cwd <cwd> --close-on-exit -- cmd args…`
 *
 * A tab, not a pane in the leader's tab: workers are something you go and look
 * at, not something that shrinks the window you are typing in. `--close-on-exit`
 * is what lets a finished worker's tab clean itself up.
 */
export function newTabArgs(title: string, spec: ProcessSpec, cwd: string, sessionName?: string): string[] {
	const command = spec.env ? "/usr/bin/env" : spec.command;
	const args = spec.env
		? [
				...Object.entries(spec.env)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([name, value]) => `${name}=${value}`),
				spec.command,
				...spec.args,
			]
		: spec.args;
	return [
		...(sessionName ? ["--session", sessionName] : []),
		"action",
		"new-tab",
		"--name",
		title,
		"--cwd",
		cwd,
		"--close-on-exit",
		"--",
		command,
		...args,
	];
}

/** `--tab` adds tab fields to every pane in the session; it does not filter to one tab. */
export function listTabPanesArgs(sessionName: string): string[] {
	return ["--session", sessionName, "action", "list-panes", "--tab", "--json"];
}

/** Inspect stable tab ids and active state after a targeted focus action. */
export function listTabsArgs(sessionName: string): string[] {
	return ["--session", sessionName, "action", "list-tabs", "--state", "--json"];
}

/** Restore focus to one exact stable tab id without relying on its mutable name. */
export function goToTabByIdArgs(sessionName: string, tabId: number): string[] {
	return ["--session", sessionName, "action", "go-to-tab-by-id", String(tabId)];
}

/** Rename one proven tab id without focusing it. */
export function renameTabByIdArgs(sessionName: string, tabId: number, title: string): string[] {
	return ["--session", sessionName, "action", "rename-tab-by-id", String(tabId), title];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Zellij 0.44.3 exposes pane and tab ids as different fields. Resolve the tab
 * only when one non-plugin pane proves both the pane id and original tab name.
 * Both filters are load-bearing because pane ids and tab titles are separate,
 * and titles need not be unique.
 */
export function zellijTabId(stdout: string, paneId: string, originalTitle: string): number | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout) as unknown;
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const matches = parsed.filter(
		(row) =>
			isRecord(row) &&
			row.is_plugin === false &&
			(typeof row.id === "string" || typeof row.id === "number") &&
			String(row.id) === paneId &&
			row.tab_name === originalTitle &&
			typeof row.tab_id === "number" &&
			Number.isInteger(row.tab_id),
	);
	if (matches.length !== 1) return undefined;
	return matches[0].tab_id as number;
}

interface ZellijTab {
	id: number;
	name: string;
}

/** Resolve the calling terminal pane to exactly one stable tab id. */
export function zellijTabForPane(stdout: string, paneId: string): ZellijTab | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout) as unknown;
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const matches = parsed.filter(
		(row) =>
			isRecord(row) &&
			row.is_plugin === false &&
			(typeof row.id === "string" || typeof row.id === "number") &&
			String(row.id) === paneId &&
			typeof row.tab_id === "number" &&
			Number.isInteger(row.tab_id) &&
			typeof row.tab_name === "string",
	);
	if (matches.length !== 1) return undefined;
	return { id: matches[0].tab_id as number, name: matches[0].tab_name as string };
}

function zellijTabs(stdout: string): Map<number, string> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout) as unknown;
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
	const tabs = new Map<number, string>();
	for (const row of parsed) {
		if (
			!isRecord(row) ||
			typeof row.tab_id !== "number" ||
			!Number.isInteger(row.tab_id) ||
			typeof row.tab_name !== "string"
		) {
			return undefined;
		}
		const previous = tabs.get(row.tab_id);
		if (previous !== undefined && previous !== row.tab_name) return undefined;
		tabs.set(row.tab_id, row.tab_name);
	}
	return tabs;
}

function openedZellijTab(before: string, after: string, title: string): boolean {
	const beforeTabs = zellijTabs(before);
	const afterTabs = zellijTabs(after);
	if (!beforeTabs || !afterTabs) return false;
	const added = [...afterTabs].filter(([id]) => !beforeTabs.has(id));
	return added.length === 1 && added[0][1] === title;
}

function isZellijTabActive(stdout: string, tabId: number): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout) as unknown;
	} catch {
		return false;
	}
	if (!Array.isArray(parsed)) return false;
	const matches = parsed.filter((row) => isRecord(row) && row.tab_id === tabId && row.active === true);
	return matches.length === 1;
}

/** Best-effort status rename: every missing or ambiguous fact fails closed. */
export function renameZellijTab(
	title: string,
	env: Record<string, string | undefined> = process.env,
	run: ZellijCommandRunner = runCommand,
): boolean {
	const sessionName = env.ZELLIJ_SESSION_NAME;
	const originalTitle = env.NETA_PANE;
	const paneId = env.ZELLIJ_PANE_ID;
	if (env.NETA_MUX !== "zellij" || !originalTitle || !sessionName || !paneId) return false;
	try {
		const listed = run("zellij", listTabPanesArgs(sessionName));
		if (listed.status !== 0) return false;
		const tabId = zellijTabId(listed.stdout, paneId, originalTitle);
		if (tabId === undefined) return false;
		return run("zellij", renameTabByIdArgs(sessionName, tabId, title)).status === 0;
	} catch {
		return false;
	}
}

export class ZellijAdapter implements MuxAdapter {
	readonly id = "zellij" as const;
	private readonly run: ZellijCommandRunner;
	private readonly env: Record<string, string | undefined>;

	constructor(run: ZellijCommandRunner = runCommand, env: Record<string, string | undefined> = process.env) {
		this.run = run;
		this.env = env;
	}

	available(): boolean {
		return findOnPath("zellij") !== undefined;
	}

	inSession(): boolean {
		return Boolean(this.env.ZELLIJ);
	}

	sessionName(): string | undefined {
		return this.env.ZELLIJ_SESSION_NAME || undefined;
	}

	wrapLeader(leader: ProcessSpec, sessionName: string, sessionDir: string): ProcessSpec | undefined {
		if (this.inSession()) return undefined;
		const layoutPath = join(sessionDir, "layout.kdl");
		writeFileSync(layoutPath, leaderLayout(leader), "utf-8");
		return { command: "zellij", args: newSessionArgs(sessionName, layoutPath), env: leader.env };
	}

	openPane(title: string, spec: ProcessSpec, cwd: string, sessionName?: string): boolean {
		const targetSession = sessionName ?? this.sessionName();
		const paneId = this.env.ZELLIJ_PANE_ID;
		if (!targetSession || !paneId || (!sessionName && !this.inSession())) return false;

		const before = this.run("zellij", listTabPanesArgs(targetSession));
		if (before.status !== 0) return false;
		const originalTab = zellijTabForPane(before.stdout, paneId);
		if (!originalTab) return false;

		this.run("zellij", newTabArgs(title, spec, cwd, targetSession), {
			env: { ...this.env, ...spec.env },
		});
		const after = this.run("zellij", listTabPanesArgs(targetSession));
		const opened = after.status === 0 && openedZellijTab(before.stdout, after.stdout, title);

		// new-tab always focuses the new tab. Restore the exact stable id belonging
		// to the calling pane, then verify active state because actions can report
		// success while printing errors such as "session not found".
		this.run("zellij", goToTabByIdArgs(targetSession, originalTab.id));
		const focused = this.run("zellij", listTabsArgs(targetSession));
		const restored = focused.status === 0 && isZellijTabActive(focused.stdout, originalTab.id);
		if (!opened) return false;
		if (!restored) throw new Error(`zellij: opened tab but could not restore focus to ${originalTab.name}`);
		return true;
	}

	renameCurrentPane(title: string, env: Record<string, string | undefined> = process.env): boolean {
		return renameZellijTab(title, env, this.run);
	}
}
