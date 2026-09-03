// The terminal chat (08, T8.4): `neta` attaches to the workspace leader's
// conversation. Line-based, never a TUI: `workspace.open`, then
// `conversation.tail` for the last 20 blocks through the same renderer, then
// stdin lines become `conversation.prompt`s whose replies stream from `turn`
// notifications until the turn ends.
import type { Block, Leader, Workspace } from "../core/types.ts";
import type { ConversationTailResult, StateNotification, TurnNotification } from "../node/protocol.ts";
import { CliError, type NodeClient } from "./client.ts";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const HISTORY_LIMIT = 20;

function width(): number {
	return process.stdout.columns ?? 100;
}

// One block to its terminal form, or null to skip it. Text is verbatim, no
// prefix; thought is a dim single line rewritten in place with `\r` (TTY
// only); tool and diff are one dim `·` line each, never re-rendered; status
// is one dim `—` line; a user block is one dim `> ` line. Off a TTY there is
// no dimming and thought blocks are skipped.
export function renderBlock(b: Block, tty: boolean): string | null {
	if (b.role === "user") {
		return tty ? `${DIM}> ${b.text}${RESET}\n` : `> ${b.text}\n`;
	}
	if (b.kind === "text") {
		return b.text;
	}
	if (b.kind === "thought") {
		if (!tty) {
			return null;
		}
		const first = b.text.split("\n")[0] ?? "";
		return `${DIM}${first.slice(0, width())}${RESET}\r`;
	}
	if (b.kind === "status") {
		return tty ? `${DIM}— ${b.text}${RESET}\n` : `— ${b.text}\n`;
	}
	return tty ? `${DIM}· ${b.text}${RESET}\n` : `· ${b.text}\n`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function report(error: unknown): number {
	if (error instanceof CliError) {
		process.stderr.write(`neta: ${error.message}\n`);
		return error.code;
	}
	process.stderr.write(`neta: ${messageOf(error)}\n`);
	return 1;
}

interface Opened {
	workspace: Workspace;
	leader: Leader;
}

export async function attach(client: NodeClient, path: string): Promise<number> {
	let opened: Opened;
	try {
		opened = await client.request<Opened>("workspace.open", { path });
	} catch (error) {
		client.close();
		return report(error);
	}
	const sessionId = opened.leader.sessionId;
	const workspaceId = opened.workspace.id;
	const name = opened.workspace.name;
	let mode = opened.leader.mode === "leadPlus" ? "lead++" : "lead";
	const ttyIn = process.stdin.isTTY ?? false;
	const ttyOut = process.stdout.isTTY ?? false;

	// Tail-then-follow: the node's read comes first and the subscribe second,
	// so nothing is lost between history and the live stream. A live session
	// with no recorded history yet has no tail page; the attach still follows
	// it live (without that subscription there is no stream to follow).
	let history: Block[] = [];
	let subscribed = true;
	try {
		const tail = await client.request<ConversationTailResult>("conversation.tail", {
			sessionId,
			limit: HISTORY_LIMIT,
		});
		history = tail.blocks;
	} catch (error) {
		if (error instanceof CliError && error.code === 1 && /no such session/.test(error.message)) {
			subscribed = false;
			history = [];
		} else {
			client.close();
			return report(error);
		}
	}

	const out = (s: string): void => {
		process.stdout.write(s);
	};

	// History renders through the same renderer; a thought line in history is
	// static, so its rewrite carriage becomes a newline.
	for (const b of history) {
		const rendered = renderBlock(b, ttyOut);
		if (rendered === null) {
			continue;
		}
		out(rendered.endsWith("\r") ? `${rendered.slice(0, -1)}\n` : rendered);
	}

	const ownTurns = new Set<string>();
	let streaming = false;
	let thoughtActive = false;
	let cancelled = false;
	let code: number | null = null;
	let eof = false;
	const queue: string[] = [];

	// Single-waiter event: every state mutation calls changed(), and until()
	// re-checks its condition, so no wakeup is lost.
	let wakeups = 0;
	let notify: () => void = () => undefined;
	function changed(): void {
		wakeups += 1;
		notify();
	}
	async function until(cond: () => boolean): Promise<void> {
		while (!cond()) {
			const seen = wakeups;
			await new Promise<void>((done) => {
				notify = done;
			});
			if (seen === wakeups) {
			}
		}
	}

	const clearThought = (): void => {
		if (thoughtActive && ttyOut) {
			out("\r\x1b[K");
			thoughtActive = false;
		}
	};

	// A turn ends with one blank line.
	const endTurn = (): void => {
		if (!streaming) {
			return;
		}
		streaming = false;
		clearThought();
		out("\n");
		changed();
	};

	const offTurn = client.on("turn", (params: unknown) => {
		const n = params as Partial<TurnNotification>;
		if (n.sessionId !== sessionId) {
			return;
		}
		if (n.block !== undefined) {
			const b = n.block;
			// Our own prompt echo: the line is already on our screen.
			if (b.role === "user" && ownTurns.has(b.turnId)) {
				return;
			}
			const rendered = renderBlock(b, ttyOut);
			if (rendered === null) {
				return;
			}
			if (b.kind === "thought" && b.role !== "user") {
				out(rendered);
				thoughtActive = true;
			} else {
				clearThought();
				out(rendered);
			}
			return;
		}
		if (n.turn !== undefined) {
			// A turn carrying an end mark closes ours; a user turn only notes
			// who opened it (it carries no text to render).
			if (n.turn.endedAt !== undefined && streaming) {
				endTurn();
			}
			return;
		}
		// A bare ping: the turn ended (model, mode and interruption pings only
		// coincide with a prompt this chat triggered).
		if (streaming) {
			endTurn();
		}
	});

	const offState = client.on("state", (params: unknown) => {
		const n = params as Partial<StateNotification>;
		if (n.kind !== "leader" || n.record === undefined) {
			return;
		}
		const leader = n.record as Leader;
		if (leader.workspaceId !== workspaceId) {
			return;
		}
		mode = leader.mode === "leadPlus" ? "lead++" : "lead";
	});

	let buffer = "";
	const onData = (chunk: Buffer): void => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) {
				break;
			}
			queue.push(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			changed();
		}
	};
	const onEnd = (): void => {
		if (buffer.length > 0) {
			queue.push(buffer);
			buffer = "";
		}
		eof = true;
		changed();
	};
	process.stdin.on("data", onData);
	process.stdin.on("end", onEnd);

	// The first SIGINT during a streaming turn sends `conversation.cancel` and
	// stays alive; SIGINT with no turn streaming (including right after a
	// cancel) exits 0.
	const onSigint = (): void => {
		if (streaming && !cancelled) {
			cancelled = true;
			void client.request("conversation.cancel", { sessionId }).catch(() => undefined);
			out("^C cancelled\n");
			return;
		}
		code = 0;
		changed();
	};
	process.on("SIGINT", onSigint);

	const sendPrompt = async (text: string): Promise<void> => {
		streaming = true;
		cancelled = false;
		try {
			const res = await client.request<{ turnId: string }>("conversation.prompt", { sessionId, text });
			ownTurns.add(res.turnId);
		} catch (error) {
			streaming = false;
			process.stderr.write(`neta: ${messageOf(error)}\n`);
			return;
		}
		if (subscribed) {
			await until(() => !streaming || code !== null);
		} else {
			streaming = false;
		}
	};

	try {
		for (;;) {
			if (code !== null) {
				break;
			}
			if (queue.length === 0) {
				if (eof) {
					if (!streaming) {
						break;
					}
					await until(() => !streaming || code !== null);
					continue;
				}
				if (ttyIn) {
					out(`${name} ${mode}> `);
				}
				await until(() => queue.length > 0 || eof || code !== null);
				continue;
			}
			const line = queue.shift() as string;
			if (line.length === 0) {
				continue;
			}
			await sendPrompt(line);
		}
	} finally {
		process.stdin.off("data", onData);
		process.stdin.off("end", onEnd);
		process.removeListener("SIGINT", onSigint);
		offTurn();
		offState();
		client.close();
	}
	return code ?? 0;
}
