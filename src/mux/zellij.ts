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
export function newTabArgs(title: string, spec: ProcessSpec, cwd: string): string[] {
	return ["action", "new-tab", "--name", title, "--cwd", cwd, "--close-on-exit", "--", spec.command, ...spec.args];
}

export class ZellijAdapter implements MuxAdapter {
	readonly id = "zellij" as const;

	available(): boolean {
		return findOnPath("zellij") !== undefined;
	}

	inSession(): boolean {
		return Boolean(process.env.ZELLIJ);
	}

	wrapLeader(leader: ProcessSpec, sessionName: string, sessionDir: string): ProcessSpec | undefined {
		if (this.inSession()) return undefined;
		const layoutPath = join(sessionDir, "layout.kdl");
		writeFileSync(layoutPath, leaderLayout(leader), "utf-8");
		return { command: "zellij", args: newSessionArgs(sessionName, layoutPath), env: leader.env };
	}

	openPane(title: string, spec: ProcessSpec, cwd: string): boolean {
		if (!this.inSession()) return false;
		const result = spawnSync("zellij", newTabArgs(title, spec, cwd), {
			env: { ...process.env, ...spec.env },
			encoding: "utf-8",
		});
		if (result.status !== 0) {
			throw new Error(`zellij: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
		}
		// `action new-tab` has no background option, so every spawn yanked the user
		// off the leader and onto the new worker. Workers open behind you: hand
		// focus back to the leader's tab, which sessions Neta started always name
		// "leader". In a session Neta did not start there is no such tab, so fall
		// back to the positionally-previous one. Cosmetic either way, never fatal.
		const back = spawnSync("zellij", ["action", "go-to-tab-name", "leader"], { env: process.env, encoding: "utf-8" });
		if (back.status !== 0) {
			spawnSync("zellij", ["action", "go-to-previous-tab"], { env: process.env, encoding: "utf-8" });
		}
		return true;
	}
}
