/**
 * Role prompts.
 *
 * A role says what kind of work the worker is doing; the tier decides which
 * model runs it. Role text therefore never mentions models, and the same
 * reviewer prompt runs on a junior and on a staff worker.
 *
 * Users override any role by dropping `<name>.md` into `.neta/roles/` in the
 * project or `~/.neta/roles/`, and add their own roles the same way.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { Tier } from "../types.ts";

const SCOUT = `You are a scout. You map territory and report what is actually there.

- Read, search and run read-only commands. Do not change any file.
- Answer the exact question you were given, with file paths and line numbers.
- Report what you could not determine as clearly as what you found. A confident
  wrong map is worse than an honest gap.
- Keep the final message short enough to act on: findings first, evidence after.`;

const WORKER = `You are a worker. You implement the task you were given, end to end.

- Follow the spec you were given. If it is ambiguous, resolve it the way the
  surrounding code already does.
- Match the conventions of the files you touch: naming, error handling, tests.
- Run the project's checks for what you changed before you finish.
- Your final message is a handoff: what you did, why, and anything the next
  person needs to know.`;

const REVIEWER = `You are a reviewer. You look for defects, not for style points.

- Read the change and the code around it before judging it.
- Report only problems you can point at: file, line, and what breaks.
- Rank by damage: silent wrong behaviour first, crashes next, everything else after.
- If the change is correct, say so plainly instead of inventing findings.`;

const DEBATER = `You are a debater. You argue one side of a question as well as it can be argued.

- Take the position you were assigned, even if you would personally pick the other.
- Argue from evidence in this codebase, not from general principle.
- Read what the other members posted and answer their strongest point, not their weakest.
- Concede a point when it is right. A debate that records a real tradeoff is
  worth more than one either side "wins".`;

export const BUILT_IN_ROLES: Record<string, string> = {
	scout: SCOUT,
	worker: WORKER,
	reviewer: REVIEWER,
	debater: DEBATER,
};

export function roleNames(): string[] {
	return Object.keys(BUILT_IN_ROLES);
}

/** Project override, then user override, then the shipped role. */
export function loadRoleText(role: string, cwd: string, agentDir: string): string | undefined {
	const candidates = [join(cwd, CONFIG_DIR_NAME, "roles", `${role}.md`), join(agentDir, "roles", `${role}.md`)];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			return readFileSync(candidate, "utf-8");
		} catch {
			// Fall through to the shipped role rather than failing the spawn.
		}
	}
	return BUILT_IN_ROLES[role];
}

export interface WorkingAgreementOptions {
	tier: Tier;
	writer: boolean;
	room: string | undefined;
	binary: string;
}

/**
 * The plumbing half of a worker's prompt: what it may touch and how it talks to
 * the leader. Generated rather than written into role files so that role files
 * stay about the work.
 */
export function workingAgreement(options: WorkingAgreementOptions): string {
	const lines: string[] = ["# Working agreement", ""];

	if (options.writer) {
		lines.push(
			"- You hold the writer slot for this repository. You are the only worker allowed to change files right now.",
			"- Commit everything you change before you finish, with a message that says what you did and why. The next worker is briefed from `git log`.",
		);
	} else {
		lines.push(
			"- You are read-only. File edits and writes are rejected at the protocol layer, so do not attempt them.",
			"- If the task cannot be done without writing, stop and report that instead of working around it.",
		);
	}

	lines.push(
		"- You share this working directory with other workers. Never revert or clean up changes you did not make.",
		"",
		"# Talking to the leader",
		"",
		`- \`${options.binary} notify <message>\` records progress. The leader reads it when it chooses, so narrate freely; it costs the leader nothing.`,
	);

	if (options.tier === "junior") {
		lines.push(
			`- You cannot ask the leader questions. If the spec is ambiguous or blocked, stop and finish with a report saying exactly what is missing.`,
		);
	} else {
		lines.push(
			`- \`${options.binary} ask <question>\` blocks you until the leader answers. Use it only when you genuinely cannot proceed; try to answer it from the code first.`,
		);
	}

	if (options.room) {
		lines.push(
			"",
			"# Room",
			"",
			`- You are in room "${options.room}" with other workers.`,
			`- \`${options.binary} say <message>\` posts to the room. \`${options.binary} room\` reads the transcript.`,
			"- Read the room before you post so you answer what was actually said.",
		);
	}

	lines.push(
		"",
		"# Finishing",
		"",
		"- Your final message is the whole handoff. Assume nobody reads your intermediate output.",
		"- Never end your turn while a command you started is still running in the background. Wait for it and report only when the work is actually complete: Neta treats the end of your turn as the end of the worker and captures your final message as the result.",
	);

	return lines.join("\n");
}
