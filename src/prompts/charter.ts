/**
 * CHARTER.md — the file that says what the leader may decide alone.
 *
 * Neta has no context loader of its own: the leader runs inside a vendor CLI,
 * so the charter is read here and folded into the instructions that CLI is
 * launched with. Project first, then the user's own default.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Charter {
	path: string;
	text: string;
	sources?: CharterSource[];
}

export interface CharterSource {
	path: string;
	text: string;
}

export function loadCharter(cwd: string, agentDir: string): Charter | undefined {
	const sources: CharterSource[] = [];
	for (const path of [join(cwd, "CHARTER.md"), join(agentDir, "CHARTER.md")]) {
		if (!existsSync(path)) continue;
		try {
			const text = readFileSync(path, "utf-8").trim();
			if (text) sources.push({ path, text });
		} catch {
			// Unreadable is the same as absent: the leader falls back to asking.
		}
	}
	if (!sources.length) return undefined;
	if (sources.length === 1) return sources[0];

	return {
		path: sources[0].path,
		text: sources.map((source) => `## Charter from ${source.path}\n\n${source.text}`).join("\n\n"),
		sources,
	};
}
