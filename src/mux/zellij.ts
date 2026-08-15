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

export function leaderLayout(leader: ProcessSpec): string {
	const args = leader.args.map(kdlString).join(" ");
	const lines = [
		"layout {",
		`    pane name=${kdlString("neta leader")} command=${kdlString(leader.command)} {`,
		args ? `        args ${args}` : undefined,
		"    }",
		"}",
		"",
	];
	return lines.filter((line) => line !== undefined).join("\n");
}

/** `zellij action new-pane --name <title> --cwd <cwd> -- cmd args…` */
export function newPaneArgs(title: string, spec: ProcessSpec, cwd: string): string[] {
	return ["action", "new-pane", "--name", title, "--cwd", cwd, "--", spec.command, ...spec.args];
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
		return { command: "zellij", args: ["--session", sessionName, "--layout", layoutPath], env: leader.env };
	}

	openPane(title: string, spec: ProcessSpec, cwd: string): boolean {
		if (!this.inSession()) return false;
		const result = spawnSync("zellij", newPaneArgs(title, spec, cwd), {
			env: { ...process.env, ...spec.env },
			stdio: "ignore",
		});
		return result.status === 0;
	}
}
