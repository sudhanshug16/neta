/**
 * Flavors: the playbooks the leader reaches for when a task has a familiar
 * shape.
 *
 * They ship as ordinary skill files rather than hardcoded behaviour, so the
 * leader only pays for them when it uses one, and so users can read, edit and
 * add their own. The shipped copies are written into the user directory on
 * startup; to customise one, copy it into `.neta/skills/` in your project — the
 * project copy wins and is never overwritten.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { FlavorRef } from "./leader.ts";

interface FlavorSkill {
	name: string;
	description: string;
	body: string;
}

const IMPLEMENT: FlavorSkill = {
	name: "implement",
	description: "build or fix something end to end: decompose, delegate by tier, review, iterate until clean",
	body: `---
name: implement
description: Build something end to end with workers - decompose, delegate by tier, review, iterate until clean.
---

# implement

Use this when the user wants something built or fixed and the shape of the
solution is already clear enough to start.

## 1. Understand before delegating

Read the code yourself. You cannot write a task a worker can act on if you do
not know which files it touches. If the cause is unknown, run \`investigate\`
first and come back.

## 2. Decompose

Split the work into pieces that can be handed over whole. A good piece names its
files, its acceptance test, and what "done" means. If you cannot write that
sentence, the piece is not understood yet.

## 3. Delegate

- Named command, inventory/read, or exactly specified small change -> apprentice.
- Mechanical, fully specified implementation -> journeyman.
- Normal feature or bug fix with tests -> expert.
- Piece where the approach is still open -> architect.

Only one writer runs at a time. Sequence the writing pieces; run scouts and
reviewers alongside them if that helps.

## 4. Review

When the writer finishes, spawn a reviewer (expert, read-only) on the diff. Give
it the commit range and what to look for. Check the reviewer's findings against
the code yourself before acting on them: a confident wrong review costs more
than no review.

## 5. Iterate

Feed real findings back to a writer with an exact instruction. Stop when the
change is correct and the project's checks pass - not when a worker says it is
done.

## 6. Land it

Do whatever the charter allows: commit is the worker's job, the PR or merge is
yours if you were given that authority. If the charter is silent on landing,
finish the work and report it as ready.
`,
};

const DECIDE: FlavorSkill = {
	name: "decide",
	description: "resolve a real tradeoff by staging a debate between architect workers, then judging it",
	body: `---
name: decide
description: Resolve a real tradeoff by running a debate between architect workers in a room, then judging it.
---

# decide

Use this when there is a genuine tradeoff - two defensible options, different
failure modes - and picking wrong is expensive. Architecture questions are
usually this, often with an \`investigate\` in front to get the facts first.

## 1. Frame the question

Write the question so that both answers are respectable. "Should we use X?" is
not a question; "X buys us A at the cost of B - is A worth B here?" is. State
the constraints that actually bind: deadlines, data volume, who maintains it.

## 2. Stage the debate

Spawn one debater per position, architect tier, all into the same room, and seed the
room with the framed question and the constraints. Give each debater its
position and tell it to argue from this codebase, not from general principle.

## 3. Run fixed rounds

Two or three rounds. Between rounds, read the room transcript and send each
debater the one thing it has not answered. Stop when arguments start repeating -
that is the signal you have the real disagreement, not more of it.

## 4. Judge

Decide yourself. Do not spawn a judge to avoid making the call; you are the
lead. Weigh the arguments against the constraints you wrote down in step 1.

## 5. Write the memo

Report a decision memo: the question, the decision, why, and the losing
arguments recorded honestly - including what would have to change for the other
option to win. A decision whose dissent is written down can be revisited
cheaply; one without it gets relitigated from scratch.
`,
};

const INVESTIGATE: FlavorSkill = {
	name: "investigate",
	description: "map unfamiliar code or reproduce a bug with parallel scouts, then synthesize one answer",
	body: `---
name: investigate
description: Map unfamiliar code or reproduce a bug with parallel scouts, then synthesize one answer.
---

# investigate

Use this when you do not yet know enough: unfamiliar subsystem, bug with an
unknown cause, "how does this work" questions. Feeds \`implement\` and
\`decide\`.

## 1. Split by question, not by folder

Give each scout a distinct question it can answer on its own: "where does the
session id come from", "what happens on the second retry", "reproduce the
failure and report the exact command". Scouts run read-only, so run them in
parallel.

## 2. Keep them from duplicating

If the questions overlap, put the scouts in one room and tell them to post what
they have found. Otherwise skip the room; it is overhead.

## 3. Wait

Wait for the scouts. There is nothing useful to do until they report.

## 4. Synthesize once

Read the reports and write one answer yourself. Verify anything load-bearing
against the code before you repeat it - scouts report what they believe, and
belief and reality diverge.

State plainly what is still unknown, and whether a null result means "safe" or
"we could not tell". Then say what you propose to do about it.
`,
};

export const FLAVORS: FlavorSkill[] = [IMPLEMENT, DECIDE, INVESTIGATE];

/**
 * Write the shipped flavors into the user directory and return where they
 * landed, so the leader's instructions can point at real paths.
 *
 * A project copy in `.neta/skills/<name>/SKILL.md` wins and is never
 * overwritten, which is how a user edits one.
 */
export async function materializeFlavors(agentDir: string, cwd?: string): Promise<FlavorRef[]> {
	const root = join(agentDir, "skills");
	const refs: FlavorRef[] = [];
	for (const flavor of FLAVORS) {
		const projectCopy = cwd ? join(cwd, CONFIG_DIR_NAME, "skills", flavor.name, "SKILL.md") : undefined;
		if (projectCopy && existsSync(projectCopy)) {
			refs.push({ name: flavor.name, path: projectCopy, description: flavor.description });
			continue;
		}
		const dir = join(root, flavor.name);
		await mkdir(dir, { recursive: true });
		const file = join(dir, "SKILL.md");
		await writeFile(file, flavor.body, "utf-8");
		refs.push({ name: flavor.name, path: file, description: flavor.description });
	}
	return refs;
}
