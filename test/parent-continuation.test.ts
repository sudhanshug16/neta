import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessage } from "../src/core/types.ts";
import type { AdaptedRuntime } from "../src/node/lifecycle.ts";
import type { TurnNotification } from "../src/node/protocol.ts";
import { loadSettings } from "../src/session/settings.ts";
import { openStore, type Store } from "../src/store/index.ts";
import { TurnInProgressError } from "./fixtures/legacy-acp/session.ts";
import { adaptLegacyAcp as adaptRuntime } from "./fixtures/legacy-acp-runtime.ts";

let dir: string;
let previousDirectory: string | undefined;
let store: Store;
let acp: AdaptedRuntime | undefined;

beforeEach(async () => {
	previousDirectory = process.env.NETA_DIR;
	dir = await mkdtemp(join(tmpdir(), "neta-continuation-"));
	process.env.NETA_DIR = dir;
	store = await openStore();
});
afterEach(async () => {
	await writeFile(join(dir, "release"), "release");
	await acp?.closeAll();
	await store.close();
	if (previousDirectory === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = previousDirectory;
	await rm(dir, { recursive: true, force: true });
	acp = undefined;
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Fixture transition did not occur within three seconds");
}

async function prompts(): Promise<string[]> {
	const text = await readFile(join(dir, "prompts"), "utf8").catch(() => "");
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string);
}

async function parent(
	options: {
		durableTurn?: (notification: TurnNotification) => Promise<void>;
		guard?: (message: InboxMessage) => Promise<boolean>;
	} = {},
): Promise<{ runtime: AdaptedRuntime; sessionId: string }> {
	const settings = loadSettings({ netaDir: dir }).settings;
	settings.providers.fake = {
		command: process.execPath,
		args: [
			new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname,
			"--prompt-capture",
			join(dir, "prompts"),
			"--barrier-file",
			join(dir, "release"),
			"--barrier-ready-file",
			join(dir, "ready"),
		],
		resume: true,
		defaultModel: "test-model",
	};
	acp = adaptRuntime(
		settings,
		store.conversations,
		undefined,
		undefined,
		undefined,
		store.inbox,
		undefined,
		options.durableTurn,
		undefined,
		options.guard,
	);
	const selected = await acp.createSession({
		workspaceId: "fixture",
		cwd: dir,
		provider: "fake",
		model: "test-model",
		access: "readOnly",
		netaTools: false,
	});
	return { runtime: acp, sessionId: selected.sessionId };
}

test("three child reports use one parent continuation and keep separate receipts", async () => {
	const { runtime, sessionId } = await parent();
	const reports = await Promise.all(
		[1, 2, 3].map((id) =>
			runtime.send(sessionId, `child-result-${id}`, [], { readerDirected: false, sourceId: `child/${id}/turn` }),
		),
	);
	expect(reports.every((message) => message.status === "queued")).toBe(true);
	await waitFor(
		async () => (await store.inbox.list(sessionId)).filter((message) => message.status === "delivered").length === 3,
	);
	// Local inbox admission precedes the provider process receiving its RPC.
	await waitFor(async () => (await prompts()).length >= 1);
	const captured = await prompts();
	expect(captured).toHaveLength(1);
	for (const id of [1, 2, 3]) expect(captured[0]).toContain(`child-result-${id}`);
	const delivered = await store.inbox.list(sessionId);
	expect(new Set(delivered.map((message) => message.turnId)).size).toBe(1);
	expect(delivered.every((message) => message.readerDirected === false && message.sourceId)).toBe(true);
});

test("child results queue behind a busy parent without steering or interrupting it", async () => {
	const { runtime, sessionId } = await parent();
	const original = await runtime.prompt(sessionId, "WAIT_FOR_BARRIER original work");
	await waitFor(async () => (await prompts()).length === 1);
	await runtime.send(sessionId, "child-result", [], { readerDirected: false, sourceId: "child/turn" });
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(runtime.isTurnActive?.(sessionId)).toBe(true);
	expect(await prompts()).toHaveLength(1);
	expect((await store.inbox.list(sessionId))[0]?.status).toBe("queued");
	await writeFile(join(dir, "release"), "release");
	await waitFor(async () => (await store.inbox.list(sessionId))[0]?.status === "delivered");
	await waitFor(async () => (await prompts()).length >= 2);
	expect(await prompts()).toHaveLength(2);
	const first = await store.conversations.turnRange(sessionId, original);
	expect(first?.turn.cancelled).not.toBe(true);
});

test("archived child guard suppresses a queued result before provider admission", async () => {
	let archived = false;
	const { runtime, sessionId } = await parent({ guard: async () => !archived });
	const message = await runtime.send(sessionId, "archived child result", [], {
		readerDirected: false,
		sourceId: "archived/turn",
	});
	archived = true;
	await waitFor(
		async () => (await store.inbox.list(sessionId)).find((item) => item.id === message.id)?.status === "discarded",
	);
	expect(await prompts()).toHaveLength(0);
});

test("durable completion is recorded before ended journal and notification publication", async () => {
	let release!: () => void;
	let entered!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const observed = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let persisted: TurnNotification | undefined;
	const { runtime, sessionId } = await parent({
		durableTurn: async (notification) => {
			persisted = notification;
			entered();
			await barrier;
		},
	});
	const ended: TurnNotification[] = [];
	runtime.onTurn((notification) => {
		if (notification.turn?.endedAt) ended.push(notification);
	});
	try {
		const turnId = await runtime.prompt(sessionId, "finish this fixture turn");
		await observed;
		expect(persisted?.turn?.id).toBe(turnId);
		expect(persisted?.bindingGeneration).toBeDefined();
		expect((await store.conversations.turnRange(sessionId, turnId))?.turn.endedAt).toBeUndefined();
		expect(ended).toHaveLength(0);
		release();
		await waitFor(async () => ended.length === 1);
		expect((await store.conversations.turnRange(sessionId, turnId))?.turn.endedAt).toBeDefined();
	} finally {
		release();
	}
});

test("chat reset transfers queued child results, discards user drafts, and retains uncertain evidence", async () => {
	const { runtime, sessionId } = await parent();
	await runtime.prompt(sessionId, "WAIT_FOR_BARRIER original work");
	await waitFor(async () => (await prompts()).length === 1);
	const report = await store.inbox.enqueue(sessionId, "queued-child-result", [], {
		readerDirected: false,
		sourceId: "child/queued",
	});
	const user = await store.inbox.enqueue(sessionId, "user-draft-must-not-survive", [], { readerDirected: true });
	const uncertain = await store.inbox.enqueue(sessionId, "uncertain-result-must-not-replay", [], {
		readerDirected: false,
		sourceId: "child/uncertain",
	});
	await store.inbox.markUncertain(sessionId, uncertain.id);
	const fresh = await runtime.resetSession(sessionId, "standing role only", async (selected) => {
		// The result is durable in the candidate before its owner is rebound.
		const prepared = await store.inbox.list(selected.sessionId);
		expect(prepared).toHaveLength(1);
		expect(prepared[0]?.sourceId).toBe(report.sourceId);
		expect(prepared[0]?.readerDirected).toBe(false);
		expect(await prompts()).toHaveLength(1);
	});
	await waitFor(async () => (await store.inbox.list(fresh.sessionId))[0]?.status === "delivered");
	const old = await store.inbox.list(sessionId);
	expect(old.find((item) => item.id === user.id)?.status).toBe("discarded");
	expect(old.find((item) => item.id === uncertain.id)?.status).toBe("uncertain");
	await waitFor(async () => (await prompts()).length >= 2);
	const captured = await prompts();
	expect(captured).toHaveLength(2);
	expect(captured[1]).toContain("queued-child-result");
	expect(captured[1]).not.toContain("user-draft-must-not-survive");
	expect(captured[1]).not.toContain("uncertain-result-must-not-replay");
});

for (const scope of ["session", "runtime"] as const) {
	test(`${scope} close waits for durable completion before releasing its binding`, async () => {
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const recording = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const { runtime, sessionId } = await parent({
			durableTurn: async () => {
				entered();
				await gate;
			},
		});
		const turnId = await runtime.prompt(sessionId, "finish before shutdown");
		await recording;
		let closed = false;
		const closing = (scope === "session" ? runtime.close(sessionId) : runtime.closeAll()).then(() => {
			closed = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(closed).toBe(false);
			expect(await runtime.listModels({ sessionId })).not.toBeEmpty();
		} finally {
			release();
		}
		await closing;
		expect(closed).toBe(true);
		expect((await store.conversations.turnRange(sessionId, turnId))?.turn.endedAt).toBeDefined();
		await expect(runtime.listModels({ sessionId })).rejects.toThrow("no such session");
	});
}

test("follow-up retries persist once and drain after the busy turn without cancelling it", async () => {
	const { runtime, sessionId } = await parent();
	const original = await runtime.prompt(sessionId, "WAIT_FOR_BARRIER original work");
	await waitFor(async () => (await prompts()).length === 1);
	const receipts = await Promise.all(
		[1, 2, 3].map(() =>
			runtime.send(sessionId, "follow-up instructions", [], { readerDirected: false, sourceId: "followup:stable" }),
		),
	);
	expect(new Set(receipts.map((item) => item.id)).size).toBe(1);
	expect(await store.inbox.list(sessionId)).toHaveLength(1);
	await writeFile(join(dir, "release"), "release");
	await waitFor(async () => (await store.inbox.list(sessionId))[0]?.status === "delivered");
	await waitFor(async () => (await prompts()).length === 2);
	expect((await prompts())[1]).toBe("follow-up instructions");
	expect((await store.conversations.turnRange(sessionId, original))?.turn.cancelled).not.toBe(true);
});

test("a turn-admission race requeues the message instead of marking it uncertain", async () => {
	const { runtime, sessionId } = await parent();
	const prompt = runtime.prompt.bind(runtime);
	let raced = false;
	runtime.prompt = async (...args) => {
		if (!raced) {
			raced = true;
			throw new TurnInProgressError("other-turn");
		}
		return prompt(...args);
	};
	await runtime.send(sessionId, "race follow-up", [], { readerDirected: false, sourceId: "followup:race" });
	await waitFor(async () => (await store.inbox.list(sessionId))[0]?.status === "delivered");
	expect(await store.inbox.list(sessionId)).toHaveLength(1);
	await waitFor(async () => (await prompts()).length === 1);
});

test("unknown provider admission failure retains uncertain delivery without replaying", async () => {
	const { runtime, sessionId } = await parent();
	let attempts = 0;
	runtime.prompt = async () => {
		attempts++;
		throw new Error("provider transport failed after possible acceptance");
	};
	await runtime.send(sessionId, "uncertain follow-up", [], { readerDirected: false, sourceId: "followup:uncertain" });
	await waitFor(async () => (await store.inbox.list(sessionId))[0]?.status === "uncertain");
	await runtime.send(sessionId, "uncertain follow-up", [], { readerDirected: false, sourceId: "followup:uncertain" });
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(attempts).toBe(1);
	expect((await store.inbox.list(sessionId))[0]?.text).toBe("uncertain follow-up");
});

test("queued worker receives its initial brief before saved follow-ups", async () => {
	const { runtime } = await parent();
	await store.inbox.enqueue("queued-worker", "additional instructions", [], {
		readerDirected: false,
		sourceId: "followup:queued",
	});
	await runtime.createSession({
		sessionId: "queued-worker",
		workspaceId: "w",
		cwd: dir,
		provider: "fake",
		model: "",
		access: "readOnly",
		netaTools: false,
		deferInbox: true,
	});
	await runtime.prompt("queued-worker", "WAIT_FOR_BARRIER original brief");
	await waitFor(async () => (await prompts()).length === 1);
	expect((await prompts())[0]).toContain("original brief");
	await writeFile(join(dir, "release"), "release");
	await waitFor(async () => (await prompts()).length === 2);
	expect((await prompts())[1]).toBe("additional instructions");
});
