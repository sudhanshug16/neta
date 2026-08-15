/**
 * `neta watch` on a terminal: the interactive pane view.
 *
 * The plain renderer in watch.ts prints a worker's log as lines. This renders
 * the same stream as a conversation — the worker's prose as markdown, tool
 * calls as quiet one-liners, diffs colored — and adds an input line. What you
 * type becomes the worker's next turn (the same path as the leader's
 * neta_send), and when the worker is blocked on a question, the same input
 * answers it. The stream still comes from the control plane's non-consuming
 * `tail`, so watching and typing never disturb what the leader sees.
 */

import {
	Container,
	Editor,
	type EditorTheme,
	Loader,
	Markdown,
	type MarkdownTheme,
	ProcessTerminal,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { sendChannelRequest } from "./channel/client.ts";
import { APP_NAME } from "./config.ts";
import { formatUsage, isTerminalState, type WorkerLogEntry, type WorkerLogPage, type WorkerSummary } from "./types.ts";
import { resolveTarget } from "./watch.ts";

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

/**
 * The transcript: log entries mapped onto renderable blocks.
 *
 * Consecutive "text" entries are one assistant message arriving a paragraph at
 * a time, so they merge into a single markdown block instead of rendering as
 * disconnected fragments; anything else ends the run.
 */
export class TranscriptView extends Container {
	private tail: { component: Markdown; text: string } | undefined;

	append(entry: WorkerLogEntry): void {
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
			case "notify":
				this.addChild(new Text(`${style.cyan("»")} ${entry.text}`, 0, 0));
				return;
			case "say":
				this.addChild(new Text(`${style.magenta("→")} ${entry.text}`, 0, 0));
				return;
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
	const named = worker.name === worker.role ? worker.id : `${worker.id} ${worker.name}`;
	return [
		`${style.bold(named)} ${style.dim(`· ${worker.role}/${worker.tier} · ${worker.backend} · ${access}${room}`)}`,
		style.dim(`task: ${worker.task.replace(/\s+/g, " ").trim().slice(0, 300)}`),
	].join("\n");
}

function footerMessage(page: WorkerLogPage): string {
	const question = page.worker?.pendingQuestion;
	if (question) return `waiting — asks: ${question}`;
	const usage = formatUsage(page.worker?.usage);
	return usage ? `${page.state} · ${usage}` : page.state;
}

export interface WatchTuiOptions {
	workerId: string;
	sessionId?: string;
	agentDir?: string;
}

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
	const loader = new Loader(tui, style.cyan, style.dim, "connecting");
	const editor = new Editor(tui, editorTheme);
	footerSlot.addChild(loader);
	inputSlot.addChild(editor);
	inputSlot.addChild(new Text(style.dim("enter sends to the worker · ctrl+c closes this view"), 0, 0));
	for (const child of [header, transcript, footerSlot, inputSlot]) tui.addChild(child);

	let page: WorkerLogPage | undefined;
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
		loader.stop();
		footerSlot.clear();
		const usage = formatUsage(finalPage.worker?.usage);
		footerSlot.addChild(
			new Text(
				style.dim(
					`── ${finalPage.worker?.id ?? options.workerId} ${finalPage.state}${usage ? ` · ${usage}` : ""} ──`,
				),
				0,
				1,
			),
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
		// An answer unblocks a waiting worker; anything else queues as its next
		// turn. Both land in the log, so the transcript needs no local echo.
		const type = page?.worker?.pendingQuestion ? ("answer" as const) : ("send" as const);
		try {
			const response = await sendChannelRequest(target.address, {
				type,
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
			page = next;
			if (next.worker) header.setText(headerText(next.worker));
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
