/**
 * `neta watch` on a terminal: the interactive pane view.
 *
 * The plain renderer in watch.ts prints a worker's log as lines. This renders
 * the same stream as a conversation — the worker's prose as markdown, tool
 * calls as quiet one-liners, diffs colored, room posts as an attribution line
 * over a markdown body — and adds an input line. What you type becomes the
 * worker's next turn (the same path as the leader's neta_send), and when the
 * worker is blocked on a question, the same input answers it. The stream still
 * comes from the control plane's non-consuming `tail`, so watching and typing
 * never disturb what the leader sees.
 *
 * The conversation has two sides. Everything sent TO the worker — the opening
 * task brief, the leader's messages, what you type here — is the operator's
 * voice, and reads chat-style from the other edge: a block flush against the
 * RIGHT of the pane, attribution in brass, body in plain paper, wrapped
 * narrower than the pane so the alignment is visible, and never clamped or
 * markdown-rendered — what was sent is shown whole, as sent.
 *
 * `neta watch <room>` gets the same treatment minus the input line: one merged
 * transcript of the room's posts, fed by the non-consuming `room-tail`.
 */

import {
	type Component,
	Container,
	Editor,
	type EditorTheme,
	Loader,
	Markdown,
	type MarkdownTheme,
	ProcessTerminal,
	Text,
	TuiMainScreen,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sendChannelRequest } from "./channel/client.ts";
import { APP_NAME } from "./config.ts";
import { markWorkerPaneTerminal } from "./mux/panes.ts";
import {
	displayModel,
	isTerminalState,
	type RoomLogPage,
	type WorkerLogEntry,
	type WorkerLogPage,
	type WorkerState,
	type WorkerSummary,
} from "./types.ts";
import { metadataCandidates, resolveTarget, sayAuthor, sayEntry, sentMessage } from "./watch.ts";

const POLL_MS = 400;

const ansi = (open: number, close: number) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;

export const style = {
	bold: ansi(1, 22),
	dim: ansi(2, 22),
	italic: ansi(3, 23),
	underline: ansi(4, 24),
	strikethrough: ansi(9, 29),
	red: ansi(31, 39),
	green: ansi(32, 39),
	yellow: ansi(33, 39),
	magenta: ansi(35, 39),
	cyan: ansi(36, 39),
	/** Brass #d9a441 — the caret you type at, the operator's voice: everything sent to the worker. */
	brass: (text: string) => `\x1b[38;2;217;164;65m${text}\x1b[39m`,
};

/** Style applied line by line, so wrapping never carries a color past its text. */
function perLine(text: string, paint: (line: string) => string): string {
	return text
		.split("\n")
		.map((line) => paint(line))
		.join("\n");
}

const markdownTheme: MarkdownTheme = {
	heading: (text) => style.bold(style.cyan(text)),
	link: (text) => style.underline(style.cyan(text)),
	linkUrl: (text) => style.dim(text),
	code: (text) => style.yellow(text),
	codeBlock: (text) => text,
	codeBlockBorder: (text) => style.dim(text),
	quote: (text) => style.italic(text),
	quoteBorder: (text) => style.dim(text),
	hr: (text) => style.dim(text),
	listBullet: (text) => style.cyan(text),
	bold: (text) => style.bold(text),
	italic: (text) => style.italic(text),
	strikethrough: (text) => style.strikethrough(text),
	underline: (text) => style.underline(text),
};

const editorTheme: EditorTheme = {
	borderColor: (text) => style.dim(text),
	selectList: {
		selectedPrefix: (text) => style.cyan(text),
		selectedText: (text) => style.bold(text),
		description: (text) => style.dim(text),
		scrollInfo: (text) => style.dim(text),
		noMatch: (text) => style.dim(text),
	},
};

/** Unified-diff lines from the transport, colored the way every diff reads. */
export function colorDiff(text: string): string {
	return text
		.split("\n")
		.map((line, index) => {
			if (index === 0) return style.bold(line);
			if (line.startsWith("@@")) return style.cyan(line);
			if (line.startsWith("+")) return style.green(line);
			if (line.startsWith("-")) return style.red(line);
			return style.dim(line);
		})
		.join("\n");
}

const CLAMP_LINES = 12;

/**
 * Cut a wall of text down to something a pane can carry. The worker's own
 * prose is never clamped — it is the content, and a room post is the content
 * of a debate — but a status line or an error that arrives as two hundred
 * lines of dump collapses to its head.
 */
function clamp(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= CLAMP_LINES + 3) return text;
	return [...lines.slice(0, CLAMP_LINES), `… ${lines.length - CLAMP_LINES} more lines`].join("\n");
}

/**
 * A message sent TO the worker, rendered chat-style: the block hugs the RIGHT
 * edge of the pane, the attribution line is brass, the body plain paper. Long
 * lines wrap at ~2/3 of the pane so the alignment stays visible, but nothing
 * is ever clamped, and the body stays plain text rather than markdown — a
 * markdown renderer fights the alignment, and full visibility beats
 * formatting. Rendering is a pure function of the width the TUI passes in, so
 * a terminal resize re-wraps and re-aligns the block on the next render.
 */
export class SentBlock implements Component {
	private readonly label: string;
	private readonly body: string;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(label: string, body: string) {
		this.label = label;
		this.body = body;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const measure = Math.max(1, Math.min(width, Math.max(20, Math.floor((width * 2) / 3))));
		const flush = (line: string) => `${" ".repeat(Math.max(0, width - visibleWidth(line)))}${line}`;
		const body = wrapTextWithAnsi(this.body.replace(/\t/g, "   "), measure);
		this.cachedWidth = width;
		this.cachedLines = ["", flush(style.brass(`« ${this.label}`)), ...body.map(flush), ""];
		return this.cachedLines;
	}
}

/**
 * The transcript: log entries mapped onto renderable blocks.
 *
 * Consecutive "text" entries are one assistant message arriving a paragraph at
 * a time, so they merge into a single markdown block instead of rendering as
 * disconnected fragments; anything else ends the run.
 */
export class TranscriptView extends Container {
	private tail: { component: Markdown; text: string } | undefined;

	append(raw: WorkerLogEntry): void {
		// The operator's voice: what was sent to the worker arrives in the log as
		// a prefixed status entry, and renders as a right-aligned block — checked
		// before the clamp, because a sent message is content, never a dump.
		const sent = sentMessage(raw);
		if (sent) {
			this.tail = undefined;
			this.addChild(new SentBlock(sent.label, sent.text));
			return;
		}
		const entry =
			raw.kind === "text" || raw.kind === "diff" || raw.kind === "say" ? raw : { ...raw, text: clamp(raw.text) };
		if (entry.kind !== "text") this.tail = undefined;
		switch (entry.kind) {
			case "text":
				if (this.tail) {
					this.tail.text = `${this.tail.text}\n\n${entry.text}`;
					this.tail.component.setText(this.tail.text);
				} else {
					const component = new Markdown(entry.text, 0, 1, markdownTheme);
					this.tail = { component, text: entry.text };
					this.addChild(component);
				}
				return;
			case "thought":
				this.addChild(
					new Text(
						perLine(entry.text, (line) => style.dim(style.italic(line))),
						0,
						0,
					),
				);
				return;
			case "tool":
				this.addChild(new Text(style.dim(`● ${entry.text}`), 0, 0));
				return;
			case "diff":
				this.addChild(new Text(colorDiff(entry.text), 0, 1));
				return;
			case "progress":
				this.addChild(new Text(`${style.cyan("»")} ${entry.text}`, 0, 0));
				return;
			case "say": {
				// A room post reads like the worker's own prose: the violet arrow
				// attributes it, and the body renders as a full markdown block.
				const author = sayAuthor(entry);
				this.addChild(new Text(style.magenta(author ? `→ ${author}` : "→"), 0, 0));
				this.addChild(new Markdown(entry.text, 0, 1, markdownTheme));
				return;
			}
			case "error":
				this.addChild(
					new Text(
						perLine(entry.text, (line) => style.red(`! ${line}`)),
						0,
						0,
					),
				);
				return;
			default:
				this.addChild(new Text(style.dim(`· ${entry.text}`), 0, 0));
				return;
		}
	}
}

function headerText(worker: WorkerSummary): string {
	const access = worker.writer ? "writer" : "read-only";
	const room = worker.room ? ` · room ${worker.room}` : "";
	const model = displayModel(worker);
	const session = model || worker.mode ? ` · ${[model, worker.mode].filter(Boolean).join("/")}` : "";
	const bridge = worker.agentInfo ? ` · via ${worker.agentInfo}` : "";
	const named = worker.name === worker.role ? worker.id : `${worker.id} ${worker.name}`;
	return [
		`${style.bold(named)} ${style.dim(`· ${worker.role}/${worker.tier} · ${worker.backend}${bridge} · ${access}${room}${session}`)}`,
		style.dim(`task: ${worker.task.replace(/\s+/g, " ").trim().slice(0, 300)}`),
	].join("\n");
}

/** The loader's message: state, or the question the worker is blocked on. Metadata lives on the status line. */
function footerMessage(page: WorkerLogPage): string {
	const question = page.worker?.pendingQuestion;
	return question ? `waiting — asks: ${question}` : page.state;
}

/**
 * The pinned line under the input box. The header says who a worker is, but
 * the header scrolls away with the transcript; this line does not. It renders
 * the widest metadata candidate that fits, so a narrow pane sheds cost first,
 * then tokens, and always keeps id, model and state.
 */
export class StatusLine implements Component {
	private candidates: string[] = [];

	update(worker: WorkerSummary, state: WorkerState): void {
		this.candidates = metadataCandidates(worker, state);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const narrowest = this.candidates.at(-1);
		if (narrowest === undefined) return [];
		const fitting = this.candidates.find((candidate) => visibleWidth(candidate) <= width) ?? narrowest;
		return [style.dim(truncateToWidth(fitting, width, "…"))];
	}
}

export interface WatchTuiOptions {
	workerId: string;
	sessionId?: string;
	agentDir?: string;
}

export const WORKER_INPUT_HINT = "enter steers this worker now · ctrl+c closes this view";

export async function watchWorkerTui(options: WatchTuiOptions): Promise<number> {
	const target = resolveTarget(options.sessionId, process.cwd(), options.agentDir);
	if (!target) {
		console.error(`No Neta session found. Start one with \`${APP_NAME}\`, or pass --session <id>.`);
		return 1;
	}

	const tui = new TuiMainScreen(new ProcessTerminal());
	const header = new Text("", 0, 0);
	const transcript = new TranscriptView();
	const footerSlot = new Container();
	const inputSlot = new Container();
	const statusLine = new StatusLine();
	const loader = new Loader(tui, style.cyan, style.dim, "connecting");
	const editor = new Editor(tui, editorTheme);
	footerSlot.addChild(loader);
	inputSlot.addChild(editor);
	inputSlot.addChild(new Text(style.dim(WORKER_INPUT_HINT), 0, 0));
	for (const child of [header, transcript, footerSlot, inputSlot, statusLine]) tui.addChild(child);

	let briefed = false;
	let finished = false;
	let closed = false;
	let exitCode = 0;
	/** Printed after the terminal is back to normal, where it can be read. */
	let partingWords: string | undefined;
	let resolveClosed = () => {};
	const closedPromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	const close = (code: number) => {
		if (closed) return;
		closed = true;
		exitCode = code;
		loader.stop();
		tui.stop();
		resolveClosed();
	};

	const finish = (finalPage: WorkerLogPage) => {
		finished = true;
		if (finalPage.worker) markWorkerPaneTerminal(finalPage.worker);
		loader.stop();
		footerSlot.clear();
		footerSlot.addChild(
			new Text(style.dim(`── ${finalPage.worker?.id ?? options.workerId} ${finalPage.state} ──`), 0, 1),
		);
		inputSlot.clear();
		inputSlot.addChild(
			new Text(
				style.dim(`(${APP_NAME} attach ${options.workerId} to open this in its own CLI · enter to close)`),
				0,
				0,
			),
		);
		tui.setFocus(null);
	};

	tui.addInputListener((data) => {
		if (data === "\x03") {
			close(0);
			return { consume: true };
		}
		if (finished && (data === "\r" || data === "\n")) {
			close(0);
			return { consume: true };
		}
		return undefined;
	});

	const deliver = async (text: string) => {
		// This request reaches the exact same cancel-and-reprompt primitive as
		// `neta_send`. The pane is a second surface, not a weaker queue-only path.
		try {
			const response = await sendChannelRequest(target.address, {
				type: "pane-input",
				token: target.token,
				workerId: options.workerId,
				text,
			});
			if (!response.ok) transcript.append({ at: Date.now(), kind: "error", text: response.error });
		} catch (error) {
			transcript.append({
				at: Date.now(),
				kind: "error",
				text: `Could not reach the leader: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		tui.requestRender();
	};

	editor.onSubmit = (submitted) => {
		const text = submitted.trim();
		if (!text || finished) return;
		editor.setText("");
		editor.addToHistory(text);
		void deliver(text);
	};

	tui.setFocus(editor);
	loader.start();
	tui.start();

	const poll = async () => {
		let since = 0;
		while (!closed) {
			let response: Awaited<ReturnType<typeof sendChannelRequest>>;
			try {
				response = await sendChannelRequest(target.address, {
					type: "tail",
					token: target.token,
					workerId: options.workerId,
					since,
				});
			} catch {
				// The leader is gone; a finished transcript was still worth reading.
				close(finished ? 0 : 1);
				return;
			}
			if (!response.ok) {
				partingWords = response.error;
				close(1);
				return;
			}
			const next = response.data as WorkerLogPage | undefined;
			if (!next) {
				partingWords = "The leader sent no log page; is this a current Neta session?";
				close(1);
				return;
			}
			if (next.worker) {
				header.setText(headerText(next.worker));
				statusLine.update(next.worker, next.state);
				// The header's one-line "task:" summary truncates; the full brief —
				// the first thing ever sent to the worker — opens the transcript,
				// ahead of the entries this same page carries.
				if (!briefed) {
					briefed = true;
					transcript.addChild(new SentBlock("task", next.worker.task));
				}
			}
			for (const entry of next.entries) transcript.append(entry);
			since = next.cursor;
			if (isTerminalState(next.state) && !finished) finish(next);
			if (!finished) loader.setMessage(footerMessage(next));
			// The leader has moved on to a new batch; this view closes itself.
			if (next.archived) {
				close(0);
				return;
			}
			tui.requestRender();
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	};

	void poll();
	await closedPromise;
	if (partingWords) console.error(partingWords);
	return exitCode;
}

/** Which room this is and who is in it, in the worker header's grammar. */
function roomHeaderText(room: string, page: RoomLogPage): string {
	const members = page.members.map((member) => `${member.id} ${member.name} (${member.backend})`).join(", ");
	return `${style.bold(`room ${room}`)}${members ? ` ${style.dim(`· ${members}`)}` : ""}`;
}

/** The loader's message: who is still talking. */
function roomFooterMessage(page: RoomLogPage): string {
	if (page.members.length === 0) return "waiting for members";
	const active = page.members.filter((member) => !isTerminalState(member.state)).length;
	return `${active} of ${page.members.length} members active`;
}

export interface WatchRoomTuiOptions {
	room: string;
	sessionId?: string;
	agentDir?: string;
}

/**
 * The room's merged transcript as a pane: every member's posts in one place,
 * each rendered as an attributed markdown block. Read-only — talking to a
 * member goes through its own pane; posting to the room is the leader's move.
 */
export async function watchRoomTui(options: WatchRoomTuiOptions): Promise<number> {
	const target = resolveTarget(options.sessionId, process.cwd(), options.agentDir);
	if (!target) {
		console.error(`No Neta session found. Start one with \`${APP_NAME}\`, or pass --session <id>.`);
		return 1;
	}

	const tui = new TuiMainScreen(new ProcessTerminal());
	const header = new Text("", 0, 0);
	const transcript = new TranscriptView();
	const footerSlot = new Container();
	const loader = new Loader(tui, style.cyan, style.dim, "connecting");
	footerSlot.addChild(loader);
	footerSlot.addChild(new Text(style.dim("a room view only reads · ctrl+c closes this view"), 0, 0));
	for (const child of [header, transcript, footerSlot]) tui.addChild(child);

	let finished = false;
	let closed = false;
	let exitCode = 0;
	/** Printed after the terminal is back to normal, where it can be read. */
	let partingWords: string | undefined;
	let resolveClosed = () => {};
	const closedPromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	const close = (code: number) => {
		if (closed) return;
		closed = true;
		exitCode = code;
		loader.stop();
		tui.stop();
		resolveClosed();
	};

	const finish = () => {
		finished = true;
		loader.stop();
		footerSlot.clear();
		footerSlot.addChild(new Text(style.dim(`── room ${options.room} done ── (enter to close)`), 0, 1));
	};

	tui.addInputListener((data) => {
		if (data === "\x03") {
			close(0);
			return { consume: true };
		}
		if (finished && (data === "\r" || data === "\n")) {
			close(0);
			return { consume: true };
		}
		return undefined;
	});

	loader.start();
	tui.start();

	const poll = async () => {
		let since = 0;
		while (!closed) {
			let response: Awaited<ReturnType<typeof sendChannelRequest>>;
			try {
				response = await sendChannelRequest(target.address, {
					type: "room-tail",
					token: target.token,
					room: options.room,
					since,
				});
			} catch {
				// The leader is gone; a finished exchange was still worth reading.
				close(finished ? 0 : 1);
				return;
			}
			if (!response.ok) {
				partingWords = response.error;
				close(1);
				return;
			}
			const page = response.data as RoomLogPage | undefined;
			if (!page) {
				partingWords = "The leader sent no room page; is this a current Neta session?";
				close(1);
				return;
			}
			header.setText(roomHeaderText(options.room, page));
			for (const post of page.posts) transcript.append(sayEntry(post));
			since = page.cursor;
			if (page.done && !finished) finish();
			if (!finished) loader.setMessage(roomFooterMessage(page));
			// The leader has moved on to a new batch; this view closes itself.
			if (page.archived) {
				close(0);
				return;
			}
			tui.requestRender();
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	};

	void poll();
	await closedPromise;
	if (partingWords) console.error(partingWords);
	return exitCode;
}
