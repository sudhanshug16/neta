/**
 * The one thing the startup preflight remembers: which worker tiers the user
 * last confirmed for a session.
 *
 * It lives in the Neta user directory, next to sessions and checkpoints, and
 * never in a project's `.neta/settings.json`. Two reasons. Settings are a policy
 * the user writes and reads — tier-to-backend mappings, mux mode, charters — and
 * a value the launcher rewrites on every run does not belong in a file people
 * hand-edit and commit. And the choice is about this machine's session, not
 * about the project, so a repository should not carry it.
 *
 * There is no separate "default tiers" workflow. The first run preselects
 * everything; every run after that preselects what was confirmed last time.
 * One remembered value, one meaning.
 */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { isTier, LEGACY_TIER_ALIASES, TIERS, type Tier } from "../types.ts";

/** File name under the Neta user directory. */
export const STARTUP_PREFERENCES_FILE = "startup.json";

export interface StartupPreferences {
	/** The last confirmed tier choice, in canonical tier order. Absent before the first run. */
	tiers?: Tier[];
}

export function startupPreferencesPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, STARTUP_PREFERENCES_FILE);
}

/** Canonical tier order, deduplicated, legacy names accepted. Unknown names dropped. */
export function normalizeTierList(values: readonly unknown[]): Tier[] {
	const seen = new Set<Tier>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const canonical = isTier(value)
			? value
			: (LEGACY_TIER_ALIASES[value as keyof typeof LEGACY_TIER_ALIASES] as Tier | undefined);
		if (canonical) seen.add(canonical);
	}
	return TIERS.filter((tier) => seen.has(tier));
}

/**
 * Read the remembered choice. An unreadable or malformed file reads as "nothing
 * remembered" rather than failing the launch: the cost of being wrong here is
 * one extra keystroke, and refusing to start a session over a preferences file
 * would be worse than forgetting it.
 */
export function readStartupPreferences(agentDir: string = getAgentDir()): StartupPreferences {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(startupPreferencesPath(agentDir), "utf8"));
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const tiers = (parsed as { tiers?: unknown }).tiers;
	if (!Array.isArray(tiers)) return {};
	const normalized = normalizeTierList(tiers);
	// An empty list is not a choice anyone confirmed, so it is not remembered.
	return normalized.length > 0 ? { tiers: normalized } : {};
}

/**
 * Persist the confirmed tier choice, atomically: a temporary file in the same
 * directory, fsynced, then renamed over the target. A half-written preferences
 * file would be read as "nothing remembered" on the next run, which is survivable
 * — but a rename is cheap and makes it impossible.
 *
 * Refuses an empty choice. Nothing may record "this session may use no tiers":
 * a session like that cannot delegate, and remembering it would break every
 * later launch until the user found the file.
 */
export function writeStartupTierChoice(tiers: readonly Tier[], agentDir: string = getAgentDir()): void {
	const normalized = normalizeTierList(tiers);
	if (normalized.length === 0) {
		throw new Error("Refusing to remember an empty tier choice; a session with no tiers cannot delegate.");
	}
	const path = startupPreferencesPath(agentDir);
	const existing = readStartupPreferences(agentDir);
	const body = `${JSON.stringify({ ...existing, tiers: normalized }, null, 2)}\n`;
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	chmodSync(agentDir, 0o700);
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		const handle = openSync(temporary, "wx", 0o600);
		try {
			writeSync(handle, body);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		// Persist the rename as well as the file contents. Without the directory
		// fsync, a power loss can forget the last confirmed global choice even
		// though the temporary file itself was durable.
		const directoryHandle = openSync(agentDir, "r");
		try {
			fsyncSync(directoryHandle);
		} finally {
			closeSync(directoryHandle);
		}
	} finally {
		rmSync(temporary, { force: true });
	}
}
