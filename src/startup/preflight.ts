/**
 * The startup preflight: the two questions `neta` asks before it starts a leader.
 *
 * Which agent leads, and which worker tiers this session may staff. Both are
 * asked once, in the launcher, and neither is asked again for the life of the
 * session — a resumed session restores what it was launched with rather than
 * re-reading today's preferences, because its recorded workers were staffed
 * under the old answer.
 *
 * Neither question is asked when nothing can answer it. A non-TTY launch (CI, a
 * pipe, a nested agent) never prompts: it takes the single installed backend or
 * refuses to guess, and it enables every tier.
 */

import { APP_NAME } from "../config.ts";
import type { DetectedLeaderBackend } from "../detect.ts";
import { TIERS, type Tier } from "../types.ts";
import { readStartupPreferences, writeStartupTierChoice } from "./preferences.ts";
import { CANCELLED, type Choice, type PickerIo, pickMany, pickOne } from "./select.ts";

/** The user pressed Esc or Ctrl-C at a startup selector. Nothing was started. */
export class StartupCancelled extends Error {
	constructor(what: string) {
		super(`Cancelled at the ${what} selector.`);
	}
}

/**
 * Every tier was unchecked and Enter was pressed. Distinct from cancelling,
 * because it is an answer rather than a withdrawal, and the user needs to hear
 * why it cannot be honored.
 */
export class EmptyTierSelection extends Error {
	constructor() {
		super(
			"No worker tiers were selected, so this session could not delegate anything. " +
				"Select at least one tier, or press Esc to cancel.",
		);
	}
}

/** How the preflight reaches the terminal. Injected whole, so tests never touch the real one. */
export interface PreflightTerminal extends PickerIo {
	/** True when both ends are a real terminal, so a selector can be drawn. */
	interactive: boolean;
}

/**
 * The launcher's terminal.
 *
 * Drawn on stderr, not stdout: `neta` is a command people pipe, and a selector
 * frame in a pipe is corruption. stdin has to be a TTY to read keys at all, and
 * stderr has to be one for the redraw escapes to mean anything.
 */
export function processPreflightTerminal(): PreflightTerminal {
	return {
		interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
		input: process.stdin,
		output: process.stderr,
	};
}

/** What each tier is for, in one line, so the checklist explains itself. */
const TIER_HINTS: Record<Tier, string> = {
	apprentice: "one named command, one exact edit, one bounded question",
	journeyman: "mechanical work with a precise spec",
	expert: "scoped features, fixes with tests, code review",
	architect: "real ambiguity: unknown causes, design, tradeoffs",
};

export function tierChoices(): Choice[] {
	return TIERS.map((tier) => ({ value: tier, label: tier, hint: TIER_HINTS[tier] }));
}

export function backendChoices(detected: readonly DetectedLeaderBackend[]): Choice[] {
	return detected.map((backend) => ({ value: backend.id, label: backend.name, hint: backend.path }));
}

/**
 * Ask which agent leads, with a real selector.
 *
 * Only reached when the caller has already exhausted the non-interactive
 * answers: an explicit `--leader`, a configured backend, or a single install.
 */
export async function promptForLeaderBackend(
	terminal: PreflightTerminal,
	detected: readonly DetectedLeaderBackend[],
): Promise<DetectedLeaderBackend> {
	const chosen = await pickOne(terminal, "Which agent leads?", backendChoices(detected));
	if (chosen === CANCELLED) throw new StartupCancelled("leader");
	const backend = detected.find((candidate) => candidate.id === chosen);
	// The picker can only return one of the values it was given.
	if (!backend) throw new StartupCancelled("leader");
	terminal.output.write(`${APP_NAME}: leader ${backend.name}\n`);
	return backend;
}

export interface SessionTierOptions {
	terminal: PreflightTerminal;
	agentDir: string;
	/** Test seam; defaults to the real preferences file. */
	read?: typeof readStartupPreferences;
	write?: typeof writeStartupTierChoice;
	report?: (line: string) => void;
}

/**
 * Ask which worker tiers this session may staff, and remember the answer.
 *
 * The checklist starts on the last confirmed choice, or on everything when
 * nothing has been confirmed yet. Confirming an empty list is refused rather
 * than accepted: a session that may staff no tier cannot delegate at all, and
 * the leader's one hard rule is that it must not do the work itself. Refusing at
 * the selector costs one keystroke; refusing after launch costs the session.
 */
export async function chooseSessionTiers(options: SessionTierOptions): Promise<Tier[]> {
	const { terminal, agentDir } = options;
	const readPreferences = options.read ?? readStartupPreferences;
	const writePreferences = options.write ?? writeStartupTierChoice;
	const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));

	// Nothing to ask with, so nothing is restricted. A pipe must not silently
	// narrow what a session can staff.
	if (!terminal.interactive) return [...TIERS];

	const remembered = readPreferences(agentDir).tiers;
	const chosen = await pickMany(
		terminal,
		"Which worker tiers can this session use?",
		tierChoices(),
		remembered ?? TIERS,
	);
	if (chosen === CANCELLED) throw new StartupCancelled("worker tier");
	const tiers = chosen as Tier[];
	if (tiers.length === 0) throw new EmptyTierSelection();

	try {
		writePreferences(tiers, agentDir);
	} catch (error) {
		// The session is fine; only the memory of it failed. Say so once and carry
		// on, rather than refusing a launch over a preferences file.
		report(
			`${APP_NAME}: could not remember the tier choice: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	report(`${APP_NAME}: worker tiers ${tiers.join(", ")}`);
	return tiers;
}

/** Session tiers as they arrive over the environment: "expert,architect". */
export function parseSessionTiers(value: string | undefined): Tier[] {
	if (value === undefined) return [...TIERS];
	const named = TIERS.filter((tier) => value.split(",").includes(tier));
	// An empty or unrecognizable value is not a restriction anyone asked for.
	return named.length > 0 ? named : [...TIERS];
}

/** The same list, for the environment. */
export function formatSessionTiers(tiers: readonly Tier[]): string {
	return TIERS.filter((tier) => tiers.includes(tier)).join(",");
}
