import { describe, expect, it } from "bun:test";
import type { DetectedLeaderBackend } from "../src/detect.ts";
import { chooseBackend, LaunchError } from "../src/launch.ts";
import { type PreflightTerminal, StartupCancelled } from "../src/startup/preflight.ts";
import type { KeyInput } from "../src/startup/select.ts";

/** A terminal that replays scripted keys and records what was drawn on it. */
function terminal(script: string[], interactive = true): PreflightTerminal & { written: string[] } {
	const written: string[] = [];
	let listener: ((chunk: string) => void) | undefined;
	const input: KeyInput = {
		setRawMode: () => {},
		setEncoding: () => {},
		resume: () => {},
		pause: () => {},
		on: (_event, handler) => {
			listener = handler as (chunk: string) => void;
			for (const [index, chunk] of script.entries()) setTimeout(() => listener?.(chunk), index + 1);
		},
		off: () => {
			listener = undefined;
		},
	};
	return { interactive, input, output: { write: (text: string) => written.push(text) }, written };
}

const claude: DetectedLeaderBackend = {
	id: "claude",
	name: "Claude Code",
	binary: "claude",
	install: "npm i -g @anthropic-ai/claude-code",
	path: "/bin/claude",
};
const codex: DetectedLeaderBackend = {
	id: "codex",
	name: "Codex",
	binary: "codex",
	install: "npm i -g @openai/codex",
	path: "/bin/codex",
};

describe("choosing the leader", () => {
	it("uses the only installed CLI without asking", async () => {
		expect((await chooseBackend([claude], undefined, undefined)).id).toBe("claude");
	});

	it("prefers --leader over settings", async () => {
		expect((await chooseBackend([claude, codex], "codex", "claude")).id).toBe("codex");
	});

	it("falls back to the configured backend", async () => {
		expect((await chooseBackend([claude, codex], undefined, "codex")).id).toBe("codex");
	});

	// Silently leading with a different agent than the one asked for would spend
	// the wrong subscription and use the wrong restrictions.
	it("refuses to substitute when the requested CLI is missing", async () => {
		await expect(chooseBackend([claude], "codex", undefined)).rejects.toThrow(
			/--leader asked for "codex".*Installed: claude/s,
		);
	});

	it("says how to install one when nothing is there", async () => {
		await expect(chooseBackend([], undefined, undefined)).rejects.toThrow(/No agent CLI found on PATH/);
		await expect(chooseBackend([], undefined, undefined)).rejects.toBeInstanceOf(LaunchError);
	});

	it("asks for a choice instead of guessing when several are installed and nothing can prompt", async () => {
		await expect(chooseBackend([claude, codex], undefined, undefined, terminal([], false))).rejects.toThrow(
			/Several agent CLIs are installed \(claude, codex\)/,
		);
	});

	it("draws a real selector when several are installed and a terminal can answer", async () => {
		const picker = terminal(["\x1b[B", "\r"]);
		expect((await chooseBackend([claude, codex], undefined, undefined, picker)).id).toBe("codex");
		// The selector was drawn, not a numeric readline menu.
		expect(picker.written.join("")).toContain("Which agent leads?");
	});

	it("cancels cleanly rather than guessing when the user presses esc", async () => {
		await expect(chooseBackend([claude, codex], undefined, undefined, terminal(["\x1b"]))).rejects.toBeInstanceOf(
			StartupCancelled,
		);
	});

	// Every non-interactive answer is exhausted first, so a session that can be
	// decided without asking is never interrupted by a selector.
	it("never draws a selector when the answer is already known", async () => {
		for (const [detected, requested, configured] of [
			[[claude], undefined, undefined],
			[[claude, codex], "codex", undefined],
			[[claude, codex], undefined, "claude"],
		] as const) {
			const picker = terminal(["\r"]);
			await chooseBackend([...detected], requested, configured, picker);
			expect(picker.written).toEqual([]);
		}
	});
});
