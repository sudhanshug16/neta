/**
 * The startup preflight's arrow-key selectors.
 *
 * Neta owns no session UI — the vendor's own TUI hosts the conversation. These
 * are a narrow launcher surface: two selectors that run before any vendor
 * process exists and hand the terminal back untouched. They are not a transcript
 * and they never render worker output.
 *
 * Deliberately not built on `@earendil-works/pi-tui`. That library is confined
 * to `src/watch-tui.ts` by design, its `SelectList` is single-select with no
 * checkbox state, and hosting it needs a full screen the launcher has no reason
 * to take over. What is needed here is a dozen lines of raw-mode key handling
 * plus a pure renderer, both of which are directly testable.
 *
 * Everything below the interactive loop is a pure function of state, so the
 * tests assert on frames and parsed keys rather than driving a real terminal.
 */

/** One selectable row. */
export interface Choice {
	value: string;
	label: string;
	/** Dim trailing detail: an install path, a tier's job description. */
	hint?: string;
}

/** A key press, already reduced to what a selector does with it. */
export type SelectorKey =
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "toggle" }
	| { kind: "confirm" }
	| { kind: "cancel" }
	| { kind: "all" }
	| { kind: "none" }
	| { kind: "jump"; index: number }
	| { kind: "ignored" };

const ESC = "\x1b";

/**
 * Decode one stdin chunk into key presses.
 *
 * A chunk can hold several presses (fast typing, or a paste), and an arrow key
 * arrives as a three-byte escape sequence in either the normal (`ESC [ A`) or
 * the application (`ESC O A`) cursor mode, so both are read. A lone ESC — one
 * not introducing a sequence — is the cancel key.
 */
export function parseSelectorKeys(data: string): SelectorKey[] {
	const keys: SelectorKey[] = [];
	for (let index = 0; index < data.length; index++) {
		const char = data[index];
		if (char === ESC) {
			const introducer = data[index + 1];
			const final = data[index + 2];
			if ((introducer === "[" || introducer === "O") && final !== undefined) {
				index += 2;
				if (final === "A") keys.push({ kind: "up" });
				else if (final === "B") keys.push({ kind: "down" });
				else keys.push({ kind: "ignored" });
				continue;
			}
			keys.push({ kind: "cancel" });
			continue;
		}
		// Ctrl-C and Ctrl-D both mean "I am done here"; so does q.
		if (char === "\x03" || char === "\x04" || char === "q") keys.push({ kind: "cancel" });
		else if (char === "\r" || char === "\n") keys.push({ kind: "confirm" });
		else if (char === " ") keys.push({ kind: "toggle" });
		else if (char === "k" || char === "p") keys.push({ kind: "up" });
		else if (char === "j" || char === "\t") keys.push({ kind: "down" });
		else if (char === "a") keys.push({ kind: "all" });
		else if (char === "n") keys.push({ kind: "none" });
		else if (char >= "1" && char <= "9") keys.push({ kind: "jump", index: Number(char) - 1 });
		else keys.push({ kind: "ignored" });
	}
	return keys;
}

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[39m`;

export interface PickerFrame {
	title: string;
	choices: Choice[];
	cursor: number;
	/** Present for a checkbox picker; absent for a single-select. */
	checked?: Set<string>;
	footer: string;
}

/**
 * One rendered frame, as lines. The hints line up in a column so a reader scans
 * labels down the left and detail down the right.
 */
export function renderPicker(frame: PickerFrame): string[] {
	const width = Math.max(0, ...frame.choices.map((choice) => choice.label.length));
	const lines = [bold(frame.title)];
	for (const [index, choice] of frame.choices.entries()) {
		const focused = index === frame.cursor;
		const pointer = focused ? cyan("❯") : " ";
		const box = frame.checked ? `${frame.checked.has(choice.value) ? "[x]" : "[ ]"} ` : "";
		const label = focused ? bold(choice.label.padEnd(width)) : choice.label.padEnd(width);
		const hint = choice.hint ? ` ${dim(choice.hint)}` : "";
		lines.push(`${pointer} ${box}${label}${hint}`.trimEnd());
	}
	lines.push(dim(frame.footer));
	return lines;
}

const ONE_FOOTER = "↑↓ move · enter selects · esc cancels";
const MANY_FOOTER = "space toggles · ↑↓ move · a all · n none · enter confirms · esc cancels";

/** Where a selector reads keys from. Narrow on purpose, so tests can supply one. */
export interface KeyInput {
	setRawMode?(mode: boolean): unknown;
	resume(): unknown;
	pause(): unknown;
	setEncoding?(encoding: BufferEncoding): unknown;
	on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
	off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

/** Where a selector draws. `process.stderr` in practice: stdout may be a pipe. */
export interface KeyOutput {
	write(text: string): unknown;
}

export interface PickerIo {
	input: KeyInput;
	output: KeyOutput;
}

/** The user pressed Esc or Ctrl-C. Callers stop; they never fall back to a guess. */
export const CANCELLED = Symbol("neta.picker.cancelled");
export type Cancelled = typeof CANCELLED;

/**
 * Draw a frame, then redraw in place on every key.
 *
 * The cursor is hidden for the duration and the frame is erased on the way out,
 * so what the terminal keeps is only the one-line summary the caller prints. A
 * selector that left its own scaffolding behind would be the first thing the
 * user saw above their vendor CLI.
 */
async function runPicker(
	io: PickerIo,
	initial: PickerFrame,
	step: (frame: PickerFrame, key: SelectorKey) => PickerFrame | "confirm" | "cancel",
): Promise<PickerFrame | Cancelled> {
	const { input, output } = io;
	let frame = initial;
	let drawnLines = 0;

	const draw = () => {
		// Move back over the previous frame and clear to the end of the screen,
		// rather than clearing the whole screen: the launcher is a normal shell
		// session and everything above this frame is the user's scrollback.
		const rewind = drawnLines > 0 ? `\x1b[${drawnLines}A\r\x1b[0J` : "\r\x1b[0J";
		const lines = renderPicker(frame);
		drawnLines = lines.length;
		output.write(`${rewind}${lines.join("\n")}\n`);
	};

	input.setEncoding?.("utf8");
	const previousRaw = input.setRawMode !== undefined;
	output.write("\x1b[?25l");
	if (previousRaw) input.setRawMode?.(true);
	input.resume();
	draw();

	try {
		return await new Promise<PickerFrame | Cancelled>((resolve) => {
			const onData = (chunk: string | Buffer) => {
				for (const key of parseSelectorKeys(chunk.toString())) {
					const next = step(frame, key);
					if (next === "cancel") {
						input.off("data", onData);
						resolve(CANCELLED);
						return;
					}
					if (next === "confirm") {
						input.off("data", onData);
						resolve(frame);
						return;
					}
					frame = next;
				}
				draw();
			};
			input.on("data", onData);
		});
	} finally {
		// Erase the frame and restore the terminal in the same order for every
		// exit path, including a rejected promise.
		if (drawnLines > 0) output.write(`\x1b[${drawnLines}A\r\x1b[0J`);
		output.write("\x1b[?25h");
		if (previousRaw) input.setRawMode?.(false);
		input.pause();
	}
}

function move(frame: PickerFrame, delta: number): PickerFrame {
	const count = frame.choices.length;
	if (count === 0) return frame;
	return { ...frame, cursor: (frame.cursor + delta + count) % count };
}

/** Pick exactly one row. Returns the chosen value, or CANCELLED. */
export async function pickOne(
	io: PickerIo,
	title: string,
	choices: Choice[],
	initialIndex = 0,
): Promise<string | Cancelled> {
	if (choices.length === 0) throw new Error("pickOne needs at least one choice.");
	const start: PickerFrame = {
		title,
		choices,
		cursor: Math.min(Math.max(0, initialIndex), choices.length - 1),
		footer: ONE_FOOTER,
	};
	const result = await runPicker(io, start, (frame, key) => {
		switch (key.kind) {
			case "up":
				return move(frame, -1);
			case "down":
				return move(frame, 1);
			case "jump":
				return key.index < frame.choices.length ? { ...frame, cursor: key.index } : frame;
			case "confirm":
			case "toggle":
				return "confirm";
			case "cancel":
				return "cancel";
			default:
				return frame;
		}
	});
	if (result === CANCELLED) return CANCELLED;
	return result.choices[result.cursor].value;
}

/**
 * Toggle any number of rows. Returns the checked values in the order the
 * choices were given — not in click order — so the result is stable, or
 * CANCELLED.
 *
 * An empty selection is returned as an empty array rather than refused here:
 * what "nothing selected" means belongs to the caller, and Neta's caller
 * refuses it with an explanation instead of silently launching.
 */
export async function pickMany(
	io: PickerIo,
	title: string,
	choices: Choice[],
	preselected: readonly string[],
): Promise<string[] | Cancelled> {
	if (choices.length === 0) throw new Error("pickMany needs at least one choice.");
	const known = new Set(choices.map((choice) => choice.value));
	const start: PickerFrame = {
		title,
		choices,
		cursor: 0,
		checked: new Set([...preselected].filter((value) => known.has(value))),
		footer: MANY_FOOTER,
	};
	const withChecked = (frame: PickerFrame, checked: Set<string>): PickerFrame => ({ ...frame, checked });
	const result = await runPicker(io, start, (frame, key) => {
		const checked = frame.checked ?? new Set<string>();
		switch (key.kind) {
			case "up":
				return move(frame, -1);
			case "down":
				return move(frame, 1);
			case "toggle": {
				const value = frame.choices[frame.cursor].value;
				const next = new Set(checked);
				if (!next.delete(value)) next.add(value);
				return withChecked(frame, next);
			}
			case "jump": {
				if (key.index >= frame.choices.length) return frame;
				const value = frame.choices[key.index].value;
				const next = new Set(checked);
				if (!next.delete(value)) next.add(value);
				return withChecked({ ...frame, cursor: key.index }, next);
			}
			case "all":
				return withChecked(frame, new Set(frame.choices.map((choice) => choice.value)));
			case "none":
				return withChecked(frame, new Set());
			case "confirm":
				return "confirm";
			case "cancel":
				return "cancel";
			default:
				return frame;
		}
	});
	if (result === CANCELLED) return CANCELLED;
	const checked = result.checked ?? new Set<string>();
	return result.choices.filter((choice) => checked.has(choice.value)).map((choice) => choice.value);
}
