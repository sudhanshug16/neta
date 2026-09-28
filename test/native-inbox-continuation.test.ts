import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { Block, PromptAttachment, Turn } from "../src/core/types.ts";
import { filterSessionIds } from "../src/node/handlers-me.ts";
import { type AdaptedRuntime, adaptRuntime } from "../src/node/lifecycle.ts";
import type { RuntimeSession, SessionEvent, StartOptions } from "../src/session/runtime.ts";
import { loadSettings } from "../src/session/settings.ts";
import { openStore, type Store } from "../src/store/index.ts";

class ControlledSession implements RuntimeSession {
	readonly sessionId: string;
	readonly bindingGeneration = "fixture-generation";
	readonly vendorSessionId = "fixture-native";
	readonly provider = "fake";
	readonly cwd: string;
	readonly access = "readOnly" as const;
	readonly unsandboxed = false;
	readonly model = "fixture-model";
	readonly configOptions = [];
	readonly promptCapabilities = { image: false, embeddedContext: false };
	readonly steeringSupported = true;
	openTurnId: string | undefined;
	readonly steered: string[] = [];
	readonly resumed: Array<readonly { id: string; text: string; attachments: PromptAttachment[] }[]> = [];
	failResume = false;
	private readonly admitted = new Set<string>();
	private readonly consumed = new Set<string>();
	private readonly queue: SessionEvent[] = [];
	private wake: (() => void) | undefined;
	private stopped = false;

	constructor(options: StartOptions) {
		this.sessionId = options.sessionId ?? ulid();
		this.cwd = options.cwd;
	}

	private emit(event: SessionEvent): void {
		this.queue.push(event);
		this.wake?.();
		this.wake = undefined;
	}

	private start(): string {
		if (this.openTurnId) throw new Error("turn already active");
		const id = ulid();
		this.openTurnId = id;
		const turn: Turn = {
			id,
			sessionId: this.sessionId,
			startedAt: new Date().toISOString(),
			role: "user",
			bindingGeneration: this.bindingGeneration,
		};
		this.emit({ type: "turn", turn });
		return id;
	}

	prompt(): string {
		return this.start();
	}

	promptInternal(messages: readonly { id: string; text: string; attachments: PromptAttachment[] }[]): string {
		if (this.failResume) throw new Error("fixture continuation failed");
		this.resumed.push([...messages]);
		for (const message of messages) this.admitted.add(message.id);
		return this.start();
	}

	async steer(id: string): Promise<"injected" | "promptRequired"> {
		if (!this.openTurnId) return "promptRequired";
		this.steered.push(id);
		this.admitted.add(id);
		return "injected";
	}

	async internalDeliveryState(id: string): Promise<"missing" | "admitted" | "consumed"> {
		return this.consumed.has(id) ? "consumed" : this.admitted.has(id) ? "admitted" : "missing";
	}

	finish(reply: string, included: string[] = []): void {
		const turnId = this.openTurnId;
		if (!turnId) throw new Error("no active turn");
		for (const id of included) {
			this.admitted.delete(id);
			this.consumed.add(id);
			this.emit({ type: "inboxConsumed", messageId: id, turnId });
		}
		const block: Block = {
			turnId,
			seq: 1,
			at: new Date().toISOString(),
			role: "agent",
			kind: "text",
			text: reply,
		};
		this.emit({ type: "block", block });
		this.openTurnId = undefined;
		this.emit({ type: "turnEnd", turnId, finalReply: reply, stopReason: "end_turn", cancelled: false });
	}

	interrupt(): void {
		const turnId = this.openTurnId;
		if (!turnId) throw new Error("no active turn");
		this.openTurnId = undefined;
		this.emit({ type: "turnEnd", turnId, stopReason: "cancelled", cancelled: true });
	}

	async *events(): AsyncIterableIterator<SessionEvent> {
		while (!this.stopped || this.queue.length) {
			if (!this.queue.length)
				await new Promise<void>((resolve) => {
					this.wake = resolve;
				});
			const next = this.queue.shift();
			if (next) yield next;
		}
	}

	async cancel(): Promise<void> {}
	listModels() {
		return [];
	}
	async setModel(): Promise<void> {}
	async setConfigOption(): Promise<void> {}
	async relaunch(): Promise<void> {}
	async close(): Promise<void> {
		this.stopped = true;
		this.wake?.();
	}
}

let dir: string;
let previous: string | undefined;
let store: Store;
let runtime: AdaptedRuntime;
let native: ControlledSession;
const forwarded: Turn[] = [];
let onForward: (() => Promise<void>) | undefined;

beforeEach(async () => {
	previous = process.env.NETA_DIR;
	dir = await mkdtemp(join(tmpdir(), "neta-native-inbox-"));
	process.env.NETA_DIR = dir;
	store = await openStore();
	forwarded.length = 0;
	onForward = undefined;
	const settings = loadSettings({ netaDir: dir }).settings;
	settings.providers.fake = { command: "fixture", args: [], resume: true, defaultModel: "fixture-model" };
	runtime = adaptRuntime(
		settings,
		store.conversations,
		undefined,
		async (_sessionId, turn) => {
			forwarded.push(turn);
			await onForward?.();
		},
		undefined,
		store.inbox,
		undefined,
		undefined,
		undefined,
		undefined,
		async (options) => {
			native = new ControlledSession(options);
			return native;
		},
	);
	await runtime.createSession({
		workspaceId: "fixture",
		cwd: dir,
		provider: "fake",
		model: "fixture-model",
		access: "readOnly",
		netaTools: false,
	});
});

afterEach(async () => {
	filterSessionIds.delete(native.sessionId);
	await runtime.closeAll();
	await store.close();
	if (previous === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = previous;
	await rm(dir, { recursive: true, force: true });
});

test("Filter context and Coordinator decision get separate native turns", async () => {
	const sessionId = native.sessionId;
	filterSessionIds.add(sessionId);
	const context = await runtime.send(sessionId, "Workspace leader conversation update", [], {
		readerDirected: false,
		sourceId: "filter-context:leader:turn",
	});
	const decision = await runtime.send(sessionId, "Coordinator completed reply", [], {
		readerDirected: false,
		sourceId: "filter-decision:notice:1",
	});
	await until(() => native.resumed.length === 1);
	expect(native.resumed[0]?.map((message) => message.id)).toEqual([context.id]);
	native.finish("", [context.id]);
	await until(() => native.resumed.length === 2);
	expect(native.resumed[1]?.map((message) => message.id)).toEqual([decision.id]);
	native.finish("", [decision.id]);
});

test("a Filter decision waits for an active context turn instead of steering into it", async () => {
	const sessionId = native.sessionId;
	filterSessionIds.add(sessionId);
	const context = await runtime.send(sessionId, "Workspace leader conversation update", [], {
		readerDirected: false,
		sourceId: "filter-context:leader:turn",
	});
	await until(() => native.resumed.length === 1);
	const decision = await runtime.send(sessionId, "Coordinator completed reply", [], {
		readerDirected: false,
		sourceId: "filter-decision:notice:1",
	});
	await Bun.sleep(50);
	expect(native.steered).not.toContain(decision.id);
	expect(native.resumed).toHaveLength(1);
	native.finish("", [context.id]);
	await until(() => native.resumed.length === 2);
	expect(native.resumed[1]?.map((message) => message.id)).toEqual([decision.id]);
	native.finish("", [decision.id]);
});

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error("fixture transition did not occur");
}

test("a report received during the last step supersedes a stale final reply", async () => {
	const sessionId = native.sessionId;
	const first = await runtime.prompt(sessionId, "Review is still pending");
	const kai = await runtime.send(sessionId, "Kai: review complete", [], {
		readerDirected: false,
		sourceId: "kai/final",
	});
	await until(() => native.steered.includes(kai.id));
	native.finish("Kai is still reviewing");
	await until(() => native.resumed.length === 1);
	expect(forwarded).toHaveLength(0);
	expect((await store.conversations.turnRange(sessionId, first))?.turn.superseded).toBe(true);
	expect(native.resumed[0]?.map((message) => message.id)).toEqual([kai.id]);
	native.finish("Kai finished and found no issues", [kai.id]);
	await until(() => forwarded.length === 1);
	expect(forwarded[0]?.finalReply).toBe("Kai finished and found no issues");
	expect((await store.inbox.list(sessionId))[0]?.consumedAt).toBeDefined();
});

test("a completed internal prompt reaches the filter when its native receipt is missed", async () => {
	const sessionId = native.sessionId;
	const incoming = await runtime.send(sessionId, "Workspace leader request", [], {
		readerDirected: false,
		sourceId: "leader/request",
	});
	await until(() => native.resumed.length === 1);
	native.finish("Coordinator reply");
	await until(() => forwarded.length === 1);
	expect(forwarded[0]?.finalReply).toBe("Coordinator reply");
	expect(forwarded[0]?.superseded).toBe(false);
	expect((await store.inbox.list(sessionId)).find((message) => message.id === incoming.id)?.consumedAt).toBeDefined();
	expect((await store.inbox.list(sessionId)).find((message) => message.id === incoming.id)?.status).toBe("delivered");
	await Bun.sleep(50);
	expect(native.resumed).toHaveLength(1);
});

test("two reports enter the active turn in order and need no extra continuation", async () => {
	const sessionId = native.sessionId;
	await runtime.prompt(sessionId, "Check both workers");
	const first = await runtime.send(sessionId, "Kai: review complete", [], {
		readerDirected: false,
		sourceId: "kai/final",
	});
	const second = await runtime.send(sessionId, "Mia: tests pass", [], {
		readerDirected: false,
		sourceId: "mia/final",
	});
	await until(() => native.steered.length === 2);
	expect(native.steered).toEqual([first.id, second.id]);
	native.finish("Both reports are in", [first.id, second.id]);
	await until(() => forwarded.length === 1);
	expect(native.resumed).toHaveLength(0);
	expect((await store.inbox.list(sessionId)).every((message) => Boolean(message.consumedAt))).toBe(true);
});

test("a report arriving during final handoff becomes a subsequent update", async () => {
	let releaseHandoff: () => void = () => undefined;
	let enteredHandoff: () => void = () => undefined;
	const handoff = new Promise<void>((resolve) => {
		releaseHandoff = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		enteredHandoff = resolve;
	});
	onForward = async () => {
		enteredHandoff();
		await handoff;
	};
	const sessionId = native.sessionId;
	await runtime.prompt(sessionId, "Current work");
	native.finish("Current result");
	await entered;
	const sending = runtime.send(sessionId, "Kai: later update", [], {
		readerDirected: false,
		sourceId: "kai/later",
	});
	await Bun.sleep(20);
	expect(await store.inbox.list(sessionId)).toHaveLength(0);
	releaseHandoff();
	const later = await sending;
	expect(forwarded.map((turn) => turn.finalReply)).toEqual(["Current result"]);
	await until(() => native.resumed.length === 1);
	expect(native.resumed[0]?.map((message) => message.id)).toEqual([later.id]);
	native.finish("Updated result", [later.id]);
	await until(() => forwarded.length === 2);
	expect(forwarded.map((turn) => turn.finalReply)).toEqual(["Current result", "Updated result"]);
});

test("an explicit interruption pauses unread reports until a new message arrives", async () => {
	const sessionId = native.sessionId;
	await runtime.prompt(sessionId, "Current work");
	const unread = await runtime.send(sessionId, "Kai: review complete", [], {
		readerDirected: false,
		sourceId: "kai/final",
	});
	await until(() => native.steered.includes(unread.id));
	native.interrupt();
	await until(() => forwarded.length === 1);
	expect(forwarded[0]?.cancelled).toBe(true);
	await Bun.sleep(150);
	expect(native.resumed).toHaveLength(0);
	const followup = await runtime.send(sessionId, "Please continue with Kai's report", [], {
		readerDirected: false,
		sourceId: "parent/followup",
	});
	await until(() => native.resumed.length === 1);
	expect(native.resumed[0]?.map((message) => message.id)).toEqual([unread.id, followup.id]);
	native.finish("Kai's review is complete", [unread.id, followup.id]);
	await until(() => forwarded.length === 2);
});

test("failed continuation leaves an uncertain receipt without forwarding a stale reply", async () => {
	const sessionId = native.sessionId;
	await runtime.prompt(sessionId, "Current work");
	const unread = await runtime.send(sessionId, "Kai: review complete", [], {
		readerDirected: false,
		sourceId: "kai/final",
	});
	await until(() => native.steered.includes(unread.id));
	native.failResume = true;
	native.finish("Kai is still reviewing");
	await until(async () => (await store.inbox.list(sessionId))[0]?.status === "uncertain");
	expect(forwarded).toHaveLength(0);
	expect(native.resumed).toHaveLength(0);
});
