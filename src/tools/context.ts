// The three working agreements and the module composing a session's
// context: agreement, charter (leader and lead only), skills, mission brief,
// task. The agreements are string imports so the bundle reads no files;
// charters and skills are read from disk at session launch.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Mission } from "../core/types.ts";
import agentAgreement from "./prompts/agent.md" with { type: "text" };
import leadAgreement from "./prompts/lead.md" with { type: "text" };
import leaderAgreement from "./prompts/leader.md" with { type: "text" };
import type { ActorKind } from "./schemas.ts";

export const BANNED_WORDS: readonly string[] = [
	"scout",
	"worker",
	"reviewer",
	"debater",
	"apprentice",
	"journeyman",
	"expert",
	"architect",
	"tier",
];

export function agreement(kind: ActorKind): string {
	switch (kind) {
		case "leader":
			return leaderAgreement;
		case "lead":
			return leadAgreement;
		case "agent":
			return agentAgreement;
	}
}

export interface Charter {
	text: string;
	hash: string;
	sources: string[];
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR") {
			return undefined;
		}
		throw error;
	}
}

// `<workspace root>/CHARTER.md`, then `~/.neta/CHARTER.md`: both inlined
// when both exist, workspace first. No charter gives `undefined`.
export function loadCharter(root: string, homeDir: string): Charter | undefined {
	const sources: string[] = [];
	const texts: string[] = [];
	for (const path of [join(root, "CHARTER.md"), join(homeDir, ".neta", "CHARTER.md")]) {
		const text = readText(path);
		if (text !== undefined) {
			sources.push(path);
			texts.push(text);
		}
	}
	if (texts.length === 0) {
		return undefined;
	}
	const text = texts.join("\n");
	return { text, hash: createHash("sha256").update(text, "utf8").digest("hex"), sources };
}

export interface SkillText {
	name: string;
	text: string;
}

function skillNames(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR") {
			return [];
		}
		throw error;
	}
	return entries.filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -".md".length));
}

function isTraversing(name: string): boolean {
	return name.includes("/") || name.includes("..");
}

// Each name resolves `<workspace root>/.neta/skills/<name>.md`, then
// `~/.neta/skills/<name>.md`. A missing skill reports the name and the
// available list; a traversing name is rejected.
export function loadSkills(
	names: string[],
	root: string,
	homeDir: string,
): { ok: true; skills: SkillText[] } | { ok: false; missing: string; available: string[] } {
	const dirs = [join(root, ".neta", "skills"), join(homeDir, ".neta", "skills")];
	const available = [...new Set(dirs.flatMap((dir) => skillNames(dir)))].sort();
	const skills: SkillText[] = [];
	for (const name of names) {
		if (name === "" || isTraversing(name)) {
			return { ok: false, missing: name, available };
		}
		let text: string | undefined;
		for (const dir of dirs) {
			text = readText(join(dir, `${name}.md`));
			if (text !== undefined) {
				break;
			}
		}
		if (text === undefined) {
			return { ok: false, missing: name, available };
		}
		skills.push({ name, text });
	}
	return { ok: true, skills };
}

export interface ContextInput {
	kind: ActorKind;
	charter?: Charter;
	skills?: SkillText[];
	mission?: Mission;
	task?: string;
}

function missionBrief(mission: Mission): string {
	const lines = [
		`# Mission: ${mission.name} (#${mission.number})`,
		`Objective: ${mission.objective}`,
		`Access: ${mission.access}`,
	];
	if (mission.worktree !== undefined) {
		lines.push(`Worktree: ${mission.worktree.path}`);
	}
	for (const change of mission.changes) {
		lines.push(`Accepted: ${change.text}`);
	}
	return lines.join("\n");
}

export function composeContext(input: ContextInput): string {
	const parts = [agreement(input.kind)];
	// Charters reach leader and lead contexts only.
	if (input.kind !== "agent" && input.charter !== undefined) {
		parts.push(`# Charter\n${input.charter.text}`);
	}
	for (const skill of input.skills ?? []) {
		parts.push(`# Skill: ${skill.name}\n${skill.text}`);
	}
	if (input.mission !== undefined) {
		parts.push(missionBrief(input.mission));
	}
	if (input.task !== undefined) {
		parts.push(`# Task\n${input.task}`);
	}
	return parts.join("\n\n");
}
