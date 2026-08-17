import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedLeaderBackend } from "../src/detect.ts";
import {
	normalizeTierList,
	readStartupPreferences,
	startupPreferencesPath,
	writeStartupTierChoice,
} from "../src/startup/preferences.ts";
import {
	chooseSessionTiers,
	EmptyTierSelection,
	formatSessionTiers,
	type PreflightTerminal,
	parseSessionTiers,
	promptForLeaderBackend,
	StartupCancelled,
} from "../src/startup/preflight.ts";
import type { KeyInput } from "../src/startup/select.ts";
import { TIERS } from "../src/types.ts";

class ScriptedInput implements KeyInput {
	private listener: ((chunk: string) => void) | undefined;
	private readonly script: string[];
	constructor(script: string[]) {
		this.script = script;
	}
	setRawMode(): void {}
	setEncoding(): void {}
	resume(): void {}
	pause(): void {}
	on(_event: "data", listener: (chunk: string) => void): void {
		this.listener = listener;
		for (const [index, chunk] of this.script.entries()) setTimeout(() => this.listener?.(chunk), index + 1);
	}
	off(): void {
		this.listener = undefined;
	}
}

function terminal(script: string[], interactive = true): PreflightTerminal & { written: string[] } {
	const written: string[] = [];
	return {
		interactive,
		input: new ScriptedInput(script),
		output: { write: (text: string) => written.push(text) },
		written,
	};
}

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

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

describe("startup preferences", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "neta-prefs-"));
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("remembers nothing before the first run", () => {
		expect(readStartupPreferences(agentDir).tiers).toBeUndefined();
	});

	it("round-trips a choice in canonical order", () => {
		writeStartupTierChoice(["architect", "apprentice"], agentDir);
		expect(readStartupPreferences(agentDir).tiers).toEqual(["apprentice", "architect"]);
	});

	// A half-written file must never be observable, so the write lands by rename
	// and leaves no temporary behind.
	it("writes atomically and cleans up after itself", () => {
		writeStartupTierChoice(["expert"], agentDir);
		const leftovers = readdirSync(agentDir).filter((name) => name.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
		expect(existsSync(startupPreferencesPath(agentDir))).toBe(true);
	});

	// Remembering "no tiers" would break every later launch until the user found
	// the file, so it is refused at the one place that could record it.
	it("refuses to remember an empty choice", () => {
		expect(() => writeStartupTierChoice([], agentDir)).toThrow(/empty tier choice/);
		expect(existsSync(startupPreferencesPath(agentDir))).toBe(false);
	});

	it("reads a corrupt or foreign file as nothing remembered", () => {
		writeFileSync(startupPreferencesPath(agentDir), "{not json");
		expect(readStartupPreferences(agentDir).tiers).toBeUndefined();
		writeFileSync(startupPreferencesPath(agentDir), JSON.stringify({ tiers: "expert" }));
		expect(readStartupPreferences(agentDir).tiers).toBeUndefined();
		writeFileSync(startupPreferencesPath(agentDir), JSON.stringify({ tiers: [] }));
		expect(readStartupPreferences(agentDir).tiers).toBeUndefined();
	});

	it("accepts the legacy tier names earlier releases wrote", () => {
		expect(normalizeTierList(["senior", "intern", "nonsense"])).toEqual(["apprentice", "expert"]);
	});

	// The Neta user directory is the only place this lives; a project's settings
	// file is the user's to write and must not be rewritten by a launch.
	it("stays in the Neta user directory", () => {
		writeStartupTierChoice(["expert"], agentDir);
		expect(startupPreferencesPath(agentDir)).toBe(join(agentDir, "startup.json"));
		expect(JSON.parse(readFileSync(startupPreferencesPath(agentDir), "utf8"))).toEqual({ tiers: ["expert"] });
	});
});

describe("choosing session tiers", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "neta-prefs-"));
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("preselects every tier on the first ever run", async () => {
		const chosen = await chooseSessionTiers({ terminal: terminal([ENTER]), agentDir, report: () => {} });
		expect(chosen).toEqual([...TIERS]);
	});

	it("preselects the last confirmed choice on later runs", async () => {
		writeStartupTierChoice(["journeyman", "expert"], agentDir);
		const chosen = await chooseSessionTiers({ terminal: terminal([ENTER]), agentDir, report: () => {} });
		expect(chosen).toEqual(["journeyman", "expert"]);
	});

	it("remembers what was confirmed, for next time", async () => {
		// Uncheck apprentice, leaving the rest.
		await chooseSessionTiers({ terminal: terminal([" ", ENTER]), agentDir, report: () => {} });
		expect(readStartupPreferences(agentDir).tiers).toEqual(["journeyman", "expert", "architect"]);
	});

	it("refuses an empty selection rather than launching a session that cannot delegate", async () => {
		await expect(
			chooseSessionTiers({ terminal: terminal(["n", ENTER]), agentDir, report: () => {} }),
		).rejects.toBeInstanceOf(EmptyTierSelection);
		// And nothing was remembered, so the next launch still offers a real choice.
		expect(readStartupPreferences(agentDir).tiers).toBeUndefined();
	});

	it("cancels cleanly on esc, remembering nothing", async () => {
		await expect(
			chooseSessionTiers({ terminal: terminal([ESC]), agentDir, report: () => {} }),
		).rejects.toBeInstanceOf(StartupCancelled);
		expect(readStartupPreferences(agentDir).tiers).toBeUndefined();
	});

	// A pipe cannot answer, and silently narrowing what a session can staff
	// would be a worse answer than not asking.
	it("never prompts without a terminal, and enables every tier", async () => {
		const pipe = terminal([], false);
		expect(await chooseSessionTiers({ terminal: pipe, agentDir, report: () => {} })).toEqual([...TIERS]);
		expect(pipe.written).toEqual([]);
	});

	// The session is what matters; failing to write a preferences file is worth
	// one line, not a refused launch.
	it("still starts when the choice cannot be remembered", async () => {
		const said: string[] = [];
		const chosen = await chooseSessionTiers({
			terminal: terminal([ENTER]),
			agentDir,
			write: () => {
				throw new Error("disk is full");
			},
			report: (line) => said.push(line),
		});
		expect(chosen).toEqual([...TIERS]);
		expect(said.join("\n")).toContain("disk is full");
	});
});

describe("the leader selector", () => {
	it("returns the backend the user landed on", async () => {
		expect((await promptForLeaderBackend(terminal([DOWN, ENTER]), [claude, codex])).id).toBe("codex");
	});

	it("cancels cleanly on esc", async () => {
		await expect(promptForLeaderBackend(terminal([ESC]), [claude, codex])).rejects.toBeInstanceOf(StartupCancelled);
	});
});

describe("session tiers over the environment", () => {
	it("round-trips through the control plane's variable", () => {
		expect(parseSessionTiers(formatSessionTiers(["architect", "apprentice"]))).toEqual(["apprentice", "architect"]);
	});

	// A control plane started by an older launcher, or by hand, must keep every
	// tier rather than silently losing the ability to delegate.
	it("reads an absent, empty or unrecognizable value as every tier", () => {
		expect(parseSessionTiers(undefined)).toEqual([...TIERS]);
		expect(parseSessionTiers("")).toEqual([...TIERS]);
		expect(parseSessionTiers("wizard,sorcerer")).toEqual([...TIERS]);
	});

	it("drops names it does not know but keeps the ones it does", () => {
		expect(parseSessionTiers("expert,wizard")).toEqual(["expert"]);
	});
});
