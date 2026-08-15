import { describe, expect, it } from "vitest";
import type { DetectedLeaderBackend } from "../src/detect.ts";
import { chooseBackend, LaunchError } from "../src/launch.ts";

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
		const tty = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			await expect(chooseBackend([claude, codex], undefined, undefined)).rejects.toThrow(
				/Several agent CLIs are installed \(claude, codex\)/,
			);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
		}
	});
});
