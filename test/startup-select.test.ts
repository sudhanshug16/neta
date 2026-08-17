import { describe, expect, it } from "bun:test";
import {
	CANCELLED,
	type Choice,
	type KeyInput,
	type PickerIo,
	parseSelectorKeys,
	pickMany,
	pickOne,
	renderPicker,
} from "../src/startup/select.ts";

/** A stdin that replays scripted chunks, one per tick, like a person typing. */
class ScriptedInput implements KeyInput {
	rawMode = false;
	resumed = false;
	paused = false;
	private listener: ((chunk: string) => void) | undefined;
	private readonly script: string[];

	constructor(script: string[]) {
		this.script = [...script];
	}

	setRawMode(mode: boolean): void {
		this.rawMode = mode;
	}
	setEncoding(): void {}
	resume(): void {
		this.resumed = true;
	}
	pause(): void {
		this.paused = true;
	}
	on(_event: "data", listener: (chunk: string) => void): void {
		this.listener = listener;
		// Deliver on later ticks so the picker's own render runs in between, the
		// way it does against a real terminal.
		for (const [index, chunk] of this.script.entries()) {
			setTimeout(() => this.listener?.(chunk), index + 1);
		}
	}
	off(): void {
		this.listener = undefined;
	}
}

function io(script: string[]): PickerIo & { frames: string[]; input: ScriptedInput } {
	const frames: string[] = [];
	const input = new ScriptedInput(script);
	return { input, output: { write: (text: string) => frames.push(text) }, frames };
}

/** Built rather than written literally: a control character in a regex is a lint error. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plainLines = (lines: string[]): string[] => lines.map((line) => line.replace(ANSI, ""));

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

const tiers: Choice[] = [
	{ value: "apprentice", label: "apprentice", hint: "mechanical" },
	{ value: "journeyman", label: "journeyman", hint: "precise spec" },
	{ value: "expert", label: "expert", hint: "scoped work" },
	{ value: "architect", label: "architect", hint: "ambiguity" },
];

describe("selector key parsing", () => {
	it("reads both cursor modes as arrows", () => {
		expect(parseSelectorKeys("\x1b[A")).toEqual([{ kind: "up" }]);
		expect(parseSelectorKeys("\x1b[B")).toEqual([{ kind: "down" }]);
		expect(parseSelectorKeys("\x1bOA")).toEqual([{ kind: "up" }]);
		expect(parseSelectorKeys("\x1bOB")).toEqual([{ kind: "down" }]);
	});

	it("reads space, enter and the cancel keys", () => {
		expect(parseSelectorKeys(" ")).toEqual([{ kind: "toggle" }]);
		expect(parseSelectorKeys("\r")).toEqual([{ kind: "confirm" }]);
		expect(parseSelectorKeys("\n")).toEqual([{ kind: "confirm" }]);
		expect(parseSelectorKeys("\x03")).toEqual([{ kind: "cancel" }]);
		expect(parseSelectorKeys("\x1b")).toEqual([{ kind: "cancel" }]);
	});

	// A chunk can carry several presses; dropping the tail would silently lose
	// keys from a fast typist or a paste.
	it("splits a multi-key chunk", () => {
		expect(parseSelectorKeys(`${DOWN} ${ENTER}`)).toEqual([
			{ kind: "down" },
			{ kind: "toggle" },
			{ kind: "confirm" },
		]);
	});
});

describe("picker rendering", () => {
	it("marks the focused row and the checked rows", () => {
		const lines = renderPicker({
			title: "Which worker tiers?",
			choices: tiers,
			cursor: 1,
			checked: new Set(["apprentice", "expert"]),
			footer: "space toggles",
		});
		// Strip styling; what matters is the structure a reader sees.
		const plain = plainLines(lines);
		expect(plain[0]).toBe("Which worker tiers?");
		expect(plain[1]).toContain("[x] apprentice");
		expect(plain[2]).toStartWith("❯ [ ] journeyman");
		expect(plain[3]).toContain("[x] expert");
		expect(plain[4]).toContain("[ ] architect");
	});

	it("omits checkboxes for a single-select", () => {
		const lines = renderPicker({
			title: "Which agent leads?",
			choices: [{ value: "claude", label: "Claude Code", hint: "/bin/claude" }],
			cursor: 0,
			footer: "enter selects",
		});
		expect(plainLines(lines)[1]).toBe("❯ Claude Code /bin/claude");
	});
});

describe("pickOne", () => {
	it("moves with arrows and returns the focused value", async () => {
		const terminal = io([DOWN, ENTER]);
		expect(await pickOne(terminal, "Which agent leads?", tiers)).toBe("journeyman");
	});

	it("wraps around the ends", async () => {
		const terminal = io([UP, ENTER]);
		expect(await pickOne(terminal, "Which agent leads?", tiers)).toBe("architect");
	});

	it("cancels on esc without choosing anything", async () => {
		expect(await pickOne(io([ESC]), "Which agent leads?", tiers)).toBe(CANCELLED);
	});

	it("cancels on ctrl-c", async () => {
		expect(await pickOne(io(["\x03"]), "Which agent leads?", tiers)).toBe(CANCELLED);
	});

	// Whatever happens, the terminal is handed back the way it was found: raw
	// mode off, cursor visible, stdin paused.
	it("restores the terminal on every exit path", async () => {
		for (const script of [[ENTER], [ESC]]) {
			const terminal = io(script);
			await pickOne(terminal, "Which agent leads?", tiers);
			expect(terminal.input.rawMode).toBe(false);
			expect(terminal.input.paused).toBe(true);
			expect(terminal.frames.join("")).toContain("\x1b[?25h");
		}
	});
});

describe("pickMany", () => {
	it("starts on the preselection and confirms it unchanged", async () => {
		const terminal = io([ENTER]);
		expect(await pickMany(terminal, "Tiers?", tiers, ["expert", "architect"])).toEqual(["expert", "architect"]);
	});

	it("toggles the focused row with space", async () => {
		const terminal = io([" ", DOWN, " ", ENTER]);
		expect(await pickMany(terminal, "Tiers?", tiers, [])).toEqual(["apprentice", "journeyman"]);
	});

	it("unchecks an already-checked row", async () => {
		const terminal = io([" ", ENTER]);
		expect(await pickMany(terminal, "Tiers?", tiers, ["apprentice", "expert"])).toEqual(["expert"]);
	});

	it("returns values in choice order, not toggle order", async () => {
		const terminal = io([DOWN, DOWN, DOWN, " ", UP, UP, UP, " ", ENTER]);
		expect(await pickMany(terminal, "Tiers?", tiers, [])).toEqual(["apprentice", "architect"]);
	});

	it("checks and clears everything with a and n", async () => {
		expect(await pickMany(io(["a", ENTER]), "Tiers?", tiers, [])).toEqual([
			"apprentice",
			"journeyman",
			"expert",
			"architect",
		]);
		expect(await pickMany(io(["n", ENTER]), "Tiers?", tiers, ["expert"])).toEqual([]);
	});

	// Confirming nothing is a real answer the caller has to handle; it is not
	// the same as walking away, so it does not come back as CANCELLED.
	it("reports an empty confirmation as an empty list, not as a cancel", async () => {
		expect(await pickMany(io(["n", ENTER]), "Tiers?", tiers, ["expert"])).toEqual([]);
		expect(await pickMany(io([ESC]), "Tiers?", tiers, ["expert"])).toBe(CANCELLED);
	});

	it("ignores a preselection that names something not on offer", async () => {
		expect(await pickMany(io([ENTER]), "Tiers?", tiers, ["expert", "wizard"])).toEqual(["expert"]);
	});
});
