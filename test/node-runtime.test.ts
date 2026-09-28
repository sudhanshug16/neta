// The runtime path the desktop and the terminal both depend on, driven
// against a real Node on a temp `NETA_DIR` with the fake ACP agent as the
// only provider. Everything here is a fix-pass regression:
//
// - G4-5: the pump persists the person's own message, the streamed blocks and
//   the closed turn, and `conversation.tail` gives them back.
// - the two chat findings: a tailing peer sees a `user` block and a `turn`
//   notification carrying `endedAt`, not a bare ping.
// - G4-6: a leader outlives the Node — after a restart the session is resumed
//   or re-created at `workspace.open`, and prompting works again.
// - G4-4: `tools.list` and `tools.call` answer on the socket, so
//   `dispatch_mission` reaches the registry and the snapshot.
// - the `neta_mode` gate: the charter's `## Reserved for the user` section is
//   parsed from the real workspace root, so a leader cannot grant itself
//   Lead++ over a reservation, and both directions of the switch land on the
//   leader record.
// - skills resolve against the workspace root, not the directory the node
//   happened to be detached from.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { Agent, Block, Leader, Mission, Turn, Workspace } from "../src/core/types.ts";
import { connectNode, type NodeClient } from "../src/node/client.ts";
import { type Node as NetaNode, startNode } from "../src/node/lifecycle.ts";
import type { ConversationTailResult, StateNotification, TurnNotification } from "../src/node/protocol.ts";
import { appendLine } from "../src/store/files.ts";
import { paths } from "../src/store/paths.ts";
import { startLegacySession } from "./fixtures/legacy-acp-runtime.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;
const MCP_RUNNER = new URL("./fixtures/mcp-proxy-runner.mjs", import.meta.url).pathname;

let dir = "";
let work = "";
let savedNetadir: string | undefined;
let savedNetaBin: string | undefined;
let node: NetaNode | undefined;

// A short `NETA_DIR`: `$NETA_DIR/node.sock` must stay under the 104-byte
// unix socket limit.
async function shortTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

async function git(...args: string[]): Promise<void> {
	const process = Bun.spawn(["git", ...args], { cwd: work, stdout: "ignore", stderr: "pipe" });
	if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
}

async function makeGitWorkspace(): Promise<void> {
	await git("init", "-b", "main");
	await git("config", "user.email", "neta@example.test");
	await git("config", "user.name", "Neta Test");
	await writeFile(join(work, "README.md"), "fixture\n");
	await git("add", "README.md");
	await git("commit", "-m", "fixture");
	await git("remote", "add", "origin", "https://example.test/neta/closeout.git");
}

async function writeSettings(sessionStore?: string): Promise<void> {
	const args = sessionStore === undefined ? [FIXTURE] : [FIXTURE, "--session-store", sessionStore];
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			meCurator: { enabled: false },
			providers: { fake: { command: process.execPath, args, resume: true, defaultModel: "test-model" } },
			leader: { provider: "fake", model: "test-model" },
			forbiddenModels: [],
		}),
	);
}

async function writeUnavailableProviderSettings(): Promise<void> {
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			meCurator: { enabled: false },
			providers: {
				fake: { command: join(dir, "missing-adapter"), args: [], resume: true, defaultModel: "test-model" },
				alternate: { command: process.execPath, args: [FIXTURE], resume: true, defaultModel: "test-model" },
			},
			leader: { provider: "fake", model: "test-model" },
			forbiddenModels: [],
		}),
	);
}

async function writeRejectingResumeSettings(sessionStore: string): Promise<void> {
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			meCurator: { enabled: false },
			providers: {
				fake: {
					command: process.execPath,
					args: [FIXTURE, "--session-store", sessionStore, "--reject-resume"],
					resume: true,
					defaultModel: "test-model",
				},
			},
			leader: { provider: "fake", model: "test-model" },
			forbiddenModels: [],
		}),
	);
}

async function writeMissionE2ESettings(control: string): Promise<void> {
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			meCurator: { enabled: false },
			providers: {
				fake: {
					command: process.execPath,
					args: [FIXTURE, "--mission-e2e-control", control],
					resume: true,
					defaultModel: "test-model",
				},
			},
			leader: { provider: "fake", model: "test-model" },
			forbiddenModels: [],
		}),
	);
}

async function writeBarrierSettings(sessionStore: string, barrierFile: string, readyFile: string): Promise<void> {
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			meCurator: { enabled: false },
			providers: {
				fake: {
					command: process.execPath,
					args: [
						FIXTURE,
						"--session-store",
						sessionStore,
						"--barrier-file",
						barrierFile,
						"--barrier-ready-file",
						readyFile,
					],
					resume: true,
					defaultModel: "test-model",
				},
			},
			leader: { provider: "fake", model: "test-model" },
			forbiddenModels: [],
		}),
	);
}

async function writeTwoProviderSettings(sessionStore: string): Promise<void> {
	const provider = (extra: string[] = []) => ({
		command: process.execPath,
		args: [FIXTURE, "--session-store", sessionStore, ...extra],
		resume: true,
		defaultModel: "test-model",
	});
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			meCurator: { enabled: false },
			providers: { fake: provider(), alternate: provider() },
			leader: { provider: "fake", model: "test-model" },
			forbiddenModels: [],
		}),
	);
}

beforeEach(async () => {
	savedNetadir = process.env.NETA_DIR;
	savedNetaBin = process.env.NETA_BIN;
	dir = await shortTempDir("neta-rt-");
	work = await shortTempDir("neta-rt-w-");
	process.env.NETA_DIR = dir;
	await writeSettings();
});

afterEach(async () => {
	await node?.stop().catch(() => undefined);
	node = undefined;
	if (savedNetadir === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = savedNetadir;
	}
	if (savedNetaBin === undefined) delete process.env.NETA_BIN;
	else process.env.NETA_BIN = savedNetaBin;
	await rm(dir, { recursive: true, force: true });
	await rm(work, { recursive: true, force: true });
});

async function waitFor<T>(
	what: string,
	poll: () => T | undefined | Promise<T | undefined>,
	timeoutMs = 20000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await poll();
		if (found !== undefined) {
			return found;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((done) => setTimeout(done, 25));
	}
}

interface Attached {
	client: NodeClient;
	leader: Leader;
	turns: TurnNotification[];
	states: StateNotification[];
}

// Open the workspace, subscribe the way a client must (`conversation.tail`
// first: `hub.toTail` only reaches peers that have tailed) and collect
// everything the node sends.
async function attach(): Promise<Attached> {
	const client = await connectNode({ client: "desktop" });
	const turns: TurnNotification[] = [];
	const states: StateNotification[] = [];
	client.on("turn", (params) => {
		turns.push(params as TurnNotification);
	});
	client.on("state", (params) => {
		states.push(params as StateNotification);
	});
	const opened = await client.request<{ workspace: Workspace; leader: Leader }>("workspace.open", { path: work });
	await client.request("conversation.tail", { sessionId: opened.leader.sessionId, limit: 20 });
	return { client, leader: opened.leader, turns, states };
}

test("a fresh workspace remains selectable when its retired provider cannot launch", async () => {
	await writeUnavailableProviderSettings();
	node = await startNode({ sessionFactory: startLegacySession });
	const client = await connectNode({ client: "desktop" });
	try {
		const opened = await client.request<{ workspace: Workspace; leader: Leader }>("workspace.open", { path: work });
		expect(opened.leader.state).toBe("failed");
		const failedSnapshot = await client.request<{ workspaces: Workspace[]; leaders: Leader[] }>("snapshot", {});
		expect(failedSnapshot.workspaces.some((one) => one.id === opened.workspace.id)).toBe(true);
		expect(failedSnapshot.leaders.find((one) => one.workspaceId === opened.workspace.id)?.state).toBe("failed");

		const catalog = await client.request<{ providers: Array<{ id: string; available: boolean }> }>("providers.list", {
			sessionId: opened.leader.sessionId,
		});
		expect(catalog.providers.map((one) => one.id)).toEqual(["opencode"]);
		await expect(
			client.request("conversation.setProvider", {
				sessionId: opened.leader.sessionId,
				provider: "fake",
			}),
		).rejects.toThrow();
		const stillFailed = await client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(stillFailed.leaders.find((one) => one.workspaceId === opened.workspace.id)).toEqual(opened.leader);
		await expect(
			client.request("conversation.setProvider", {
				sessionId: opened.leader.sessionId,
				provider: "alternate",
			}),
		).rejects.toThrow("unavailable");
		const unchanged = await client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(unchanged.leaders.find((one) => one.workspaceId === opened.workspace.id)).toEqual(opened.leader);
	} finally {
		await client.close();
	}
}, 90000);

test.each(["finish", "cancel"] as const)(
	"coordinator activity is broadcast before output and clears on %s",
	async (ending) => {
		const barrier = join(dir, "activity-barrier");
		const ready = join(dir, "activity-ready");
		await writeBarrierSettings(join(dir, "activity-sessions.json"), barrier, ready);
		node = await startNode({ sessionFactory: startLegacySession });
		const at = await attach();
		try {
			await at.client.request("conversation.prompt", {
				sessionId: at.leader.sessionId,
				text: "WAIT_FOR_BARRIER THINK",
			});
			await waitFor("leader started", () => at.turns.find((item) => item.turn && !item.turn.endedAt));
			const snapshot = await at.client.request<{ leaders: Leader[] }>("snapshot");
			expect(snapshot.leaders[0]?.state).toBe("running");
			expect(at.states.some((item) => item.kind === "leader" && (item.record as Leader).state === "running")).toBe(
				true,
			);
			expect(at.turns.some((item) => item.block?.role === "agent")).toBe(false);
			// Another client opening this workspace must not reset the activity.
			const reopened = await at.client.request<{ leader: Leader }>("workspace.open", { path: work });
			expect(reopened.leader.state).toBe("running");
			if (ending === "cancel") await at.client.request("conversation.cancel", { sessionId: at.leader.sessionId });
			else await writeFile(barrier, "finish\n");
			const ended = await waitFor("leader ended", () => at.turns.find((item) => item.turn?.endedAt));
			expect(ended.turn?.cancelled === true).toBe(ending === "cancel");
			expect((await at.client.request<{ leaders: Leader[] }>("snapshot")).leaders[0]?.state).toBe("idle");
			expect(
				at.states.filter((item) => item.kind === "leader").map((item) => (item.record as Leader).state),
			).toEqual(["idle", "running", "idle"]);
		} finally {
			await at.client.close();
		}
	},
	30000,
);

test("coordinator displays a provider failure and returns to running on retry", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		// The fixture rejects the request when no barrier path is configured.
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "WAIT_FOR_BARRIER" });
		await waitFor("failed turn", () => at.turns.find((item) => item.turn?.failed));
		expect((await at.client.request<{ leaders: Leader[] }>("snapshot")).leaders[0]?.state).toBe("failed");
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "try again" });
		await waitFor("successful retry", () => at.turns.find((item) => item.turn?.endedAt && !item.turn.failed));
		expect(at.states.filter((item) => item.kind === "leader").map((item) => (item.record as Leader).state)).toEqual([
			"idle",
			"running",
			"failed",
			"running",
			"idle",
		]);
	} finally {
		await at.client.close();
	}
}, 30000);

test("a prompt persists the user turn, the blocks and the closed turn", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		await at.client.request<{ turnId: string }>("conversation.prompt", {
			sessionId: at.leader.sessionId,
			text: "STREAM please",
		});
		const closed = await waitFor("the closed turn notification", () =>
			at.turns.find((n) => n.turn?.endedAt !== undefined),
		);
		expect(closed.turn?.cancelled).toBeUndefined();

		// The person's own message is on the wire, as a user block.
		const userBlock = at.turns.find((n) => n.block?.role === "user")?.block;
		expect(userBlock?.text).toBe("STREAM please");

		// The reply streams under one seq, growing.
		const replies = at.turns.filter((n) => n.block?.role === "agent").map((n) => n.block as Block);
		expect(replies.length).toBeGreaterThan(1);
		expect(new Set(replies.map((b) => b.seq)).size).toBe(1);
		expect(replies[replies.length - 1]?.text).toBe("First paragraph continues.\n\nSecond paragraph.");

		// And all of it is on disk: tail is what a reconnecting client reads.
		const tail = await at.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: at.leader.sessionId,
			limit: 20,
		});
		expect(tail.blocks.map((b) => b.seq)).toEqual([1, 2]);
		expect(tail.blocks[0]?.role).toBe("user");
		expect(tail.blocks[0]?.text).toBe("STREAM please");
		expect(tail.blocks[1]?.role).toBe("agent");
		expect(tail.blocks[1]?.text).toBe("First paragraph continues.\n\nSecond paragraph.");
		const persisted = tail.turns.find((t: Turn) => t.id === closed.turn?.id);
		expect(persisted?.endedAt).toBeDefined();
	} finally {
		await at.client.close();
	}
}, 60000);

test("a cancelled turn is closed as cancelled", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "HOLD_FOREVER" });
		await waitFor("the turn to open", () => at.turns.find((n) => n.turn !== undefined));
		await at.client.request("conversation.cancel", { sessionId: at.leader.sessionId });
		const closed = await waitFor("the cancelled turn", () => at.turns.find((n) => n.turn?.endedAt !== undefined));
		expect(closed.turn?.cancelled).toBe(true);
	} finally {
		await at.client.close();
	}
}, 60000);

test("a durable prompt relaunches once after the provider exits before dispatch", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		const exited = await at.client.request<{ turnId: string }>("conversation.prompt", {
			sessionId: at.leader.sessionId,
			text: "EXIT_MID_TURN",
		});
		await waitFor("provider exit turn", () =>
			at.turns.find((change) => change.turn?.id === exited.turnId && change.turn.endedAt !== undefined),
		);
		const sent = await at.client.request<{ messageId: string; status: string; turnId?: string }>(
			"conversation.prompt",
			{
				sessionId: at.leader.sessionId,
				text: "FULL_SEQUENCE RECOVERY",
			},
		);
		expect(sent.status).toBe("delivered");
		await waitFor("recovered provider reply", () =>
			at.turns.find((change) => change.block?.text?.includes("FULL_SEQUENCE RECOVERY")),
		);
		const tail = await at.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: at.leader.sessionId,
			limit: 100,
		});
		expect(
			tail.blocks.filter((block) => block.role === "user" && block.text === "FULL_SEQUENCE RECOVERY"),
		).toHaveLength(1);
		const inbox = await at.client.request<{ messages: Array<{ id: string; status: string }> }>("conversation.inbox", {
			sessionId: at.leader.sessionId,
		});
		expect(inbox.messages.find((message) => message.id === sent.messageId)?.status).toBe("delivered");
	} finally {
		await at.client.close();
	}
}, 60000);

test("rich ACP progress and attachment metadata survive tail without payload bytes", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		expect(
			await at.client.request<{ image: boolean; embeddedContext: boolean }>("conversation.capabilities", {
				sessionId: at.leader.sessionId,
			}),
		).toEqual({
			image: true,
			embeddedContext: true,
		});
		await at.client.request("conversation.prompt", {
			sessionId: at.leader.sessionId,
			text: "FULL_SEQUENCE",
			attachments: [
				{
					id: "shot-1",
					kind: "image",
					name: "shot.png",
					mimeType: "image/png",
					dataBase64: "c2VjcmV0LWJ5dGVz",
				},
			],
		});
		await waitFor("rich turn close", () => at.turns.find((change) => change.turn?.endedAt !== undefined));
		const tail = await at.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: at.leader.sessionId,
			limit: 50,
		});
		expect(tail.blocks.some((block) => block.kind === "plan")).toBe(true);
		expect(tail.blocks.some((block) => block.kind === "tool" && block.data?.status === "completed")).toBe(true);
		expect(tail.blocks.some((block) => block.kind === "diff")).toBe(true);
		expect(tail.blocks.some((block) => block.kind === "usage" && block.data?.inputTokens === 8)).toBe(true);
		const attachment = tail.blocks.find((block) => block.data?.attachmentId === "shot-1");
		expect(attachment?.data).toMatchObject({ name: "shot.png", mimeType: "image/png", size: 12 });
		expect(JSON.stringify(tail)).not.toContain("c2VjcmV0LWJ5dGVz");
		expect(tail.turns.at(-1)?.endedAt).toBeDefined();
	} finally {
		await at.client.close();
	}
}, 60000);

test("the leader can be prompted again after the node restarts", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const first = await attach();
	await first.client.request("conversation.prompt", { sessionId: first.leader.sessionId, text: "before" });
	await waitFor("the first reply", () => first.turns.find((n) => n.block?.text === "echo:before"));
	await first.client.close();
	await node.stop();

	node = await startNode({ sessionFactory: startLegacySession });
	const second = await attach();
	try {
		// The session is live again — resumed, or re-created under a new id
		// that the leader record now carries.
		expect(second.leader.sessionId).toBeString();
		await second.client.request("conversation.prompt", { sessionId: second.leader.sessionId, text: "after" });
		const reply = await waitFor("the reply after the restart", () =>
			second.turns.find((n) => n.block?.text === "echo:after"),
		);
		expect(reply.block?.role).toBe("agent");
		if (second.leader.sessionId !== first.leader.sessionId) {
			// A re-created session is announced, so open clients follow it.
			expect(
				second.states.some(
					(s) => s.kind === "leader" && (s.record as Leader).sessionId === second.leader.sessionId,
				),
			).toBe(true);
		}
	} finally {
		await second.client.close();
	}
}, 90000);

test("a provider that remembers its session resumes into the same conversation", async () => {
	await writeSettings(join(dir, "fake-sessions.json"));
	node = await startNode({ sessionFactory: startLegacySession });
	const first = await attach();
	await first.client.request("conversation.prompt", { sessionId: first.leader.sessionId, text: "before" });
	await waitFor("the first reply", () => first.turns.find((n) => n.block?.text === "echo:before"));
	await first.client.close();
	await node.stop();

	node = await startNode({ sessionFactory: startLegacySession });
	const second = await attach();
	try {
		expect(second.leader.sessionId).toBe(first.leader.sessionId);
		await second.client.request("conversation.prompt", { sessionId: second.leader.sessionId, text: "after" });
		await waitFor("the reply after the restart", () => second.turns.find((n) => n.block?.text === "echo:after"));
		const tail = await second.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: second.leader.sessionId,
			limit: 20,
		});
		// One file, one run of seqs: the resumed session continues the
		// numbering rather than colliding with what is already on disk.
		expect(tail.blocks.map((b) => b.text)).toEqual(["before", "echo:before", "after", "echo:after"]);
		expect(tail.blocks.map((b) => b.seq)).toEqual([1, 2, 3, 4]);
	} finally {
		await second.client.close();
	}
}, 90000);

test("reset chat starts a fresh leader conversation and resumes that identity after restart", async () => {
	const storeFile = join(dir, "reset-sessions.json");
	await writeSettings(storeFile);
	node = await startNode({ sessionFactory: startLegacySession });
	const first = await attach();
	const oldNeta = await first.client.request<{ sessionId: string }>("workspace-leader.open", {
		workspaceId: first.leader.workspaceId,
	});
	await first.client.request("conversation.tail", { sessionId: oldNeta.sessionId });
	await first.client.request("conversation.prompt", {
		sessionId: oldNeta.sessionId,
		text: "OLD_NETA_RESET_CONTEXT",
	});
	await waitFor("old Neta context turn", () =>
		first.turns.find(
			(turn) => turn.sessionId === oldNeta.sessionId && turn.block?.text?.includes("OLD_NETA_RESET_CONTEXT"),
		),
	);
	await first.client.request("conversation.prompt", {
		sessionId: first.leader.sessionId,
		text: "UNWANTED_RESET_CONTEXT",
	});
	const oldContext = await waitFor("old reset context turn", () =>
		first.turns.find((turn) => turn.block?.text?.includes("UNWANTED_RESET_CONTEXT")),
	);
	await waitFor("old reset context turn closed", () =>
		first.turns.find(
			(turn) =>
				turn.turn !== undefined && turn.turn.id === oldContext.block?.turnId && turn.turn.endedAt !== undefined,
		),
	);
	const held = await first.client.request<{ turnId: string }>("conversation.prompt", {
		sessionId: first.leader.sessionId,
		text: "HOLD_FOREVER",
	});
	await waitFor("active turn before reset", () =>
		first.turns.find((turn) => turn.turn?.id === held.turnId && turn.turn.endedAt === undefined),
	);
	const reset = await first.client.request<{ sessionId: string; provider: string; model: string }>(
		"conversation.reset",
		{ sessionId: first.leader.sessionId },
	);
	expect(reset.sessionId).not.toBe(first.leader.sessionId);
	expect(reset.provider).toBe(first.leader.provider);
	expect(reset.model).toBe(first.leader.model);
	const freshNeta = await first.client.request<{ sessionId: string }>("workspace-leader.open", {
		workspaceId: first.leader.workspaceId,
	});
	expect(freshNeta.sessionId).not.toBe(oldNeta.sessionId);
	const freshNetaTail = await first.client.request<ConversationTailResult>("conversation.tail", {
		sessionId: freshNeta.sessionId,
	});
	expect(freshNetaTail.blocks).toEqual([]);
	await waitFor("old active turn closed by reset", () =>
		first.turns.find(
			(turn) => turn.turn?.id === held.turnId && turn.turn.endedAt !== undefined && turn.turn.cancelled,
		),
	);
	await first.client.request("conversation.tail", { sessionId: reset.sessionId, limit: 40 });
	await first.client.request("conversation.prompt", { sessionId: reset.sessionId, text: "HISTORY MCP" });
	const fresh = await waitFor("fresh reset history", () =>
		first.turns.find(
			(turn) => turn.sessionId === reset.sessionId && turn.block?.text?.includes("# Coordinator working agreement"),
		),
	);
	expect(fresh.block?.text).not.toContain("UNWANTED_RESET_CONTEXT");
	const oldTail = await first.client.request<{ blocks: Array<{ text: string }> }>("conversation.tail", {
		sessionId: first.leader.sessionId,
		limit: 40,
	});
	expect(oldTail.blocks.some((block) => block.text.includes("UNWANTED_RESET_CONTEXT"))).toBe(true);
	await first.client.close();
	await node.stop();
	node = await startNode({ sessionFactory: startLegacySession });
	const second = await attach();
	try {
		expect(second.leader.sessionId).toBe(reset.sessionId);
		await second.client.request("conversation.prompt", { sessionId: reset.sessionId, text: "AFTER_RESET_RESTART" });
		await waitFor("reset session after restart", () =>
			second.turns.find(
				(turn) => turn.sessionId === reset.sessionId && turn.block?.text?.includes("AFTER_RESET_RESTART"),
			),
		);
		const coldReset = await second.client.request<{ sessionId: string }>("conversation.reset", {
			sessionId: reset.sessionId,
		});
		expect(coldReset.sessionId).not.toBe(reset.sessionId);
		const reopenedNeta = await second.client.request<{ sessionId: string }>("workspace-leader.open", {
			workspaceId: second.leader.workspaceId,
		});
		expect(reopenedNeta.sessionId).not.toBe(freshNeta.sessionId);
	} finally {
		await second.client.close();
	}
}, 90000);

test("a reset provider startup failure leaves the old owner and chat usable", async () => {
	await writeSettings(join(dir, "reset-failure-sessions.json"));
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
				meCurator: { enabled: false },
				providers: { fake: { command: "/no/such/reset-provider", args: [] } },
				leader: { provider: "fake", model: "test-model" },
				forbiddenModels: [],
			}),
		);
		await expect(at.client.request("conversation.reset", { sessionId: at.leader.sessionId })).rejects.toThrow(
			/could not reset provider session/,
		);
		const snapshot = await at.client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(snapshot.leaders[0]?.sessionId).toBe(at.leader.sessionId);
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "OLD_CHAT_STILL_USABLE" });
		await waitFor("old chat after failed reset", () =>
			at.turns.find((turn) => turn.block?.text?.includes("OLD_CHAT_STILL_USABLE")),
		);
	} finally {
		await at.client.close();
	}
}, 90000);

test("reset chat rebinds mission leads and agents without changing their authority", async () => {
	await writeSettings(join(dir, "reset-agent-sessions.json"));
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		const actor = await leaderActor(at);
		await at.client.request("tools.call", {
			...actor,
			name: "dispatch_mission",
			arguments: {
				name: "Reset roles",
				objective: "Retain role instructions",
				access: "readWrite",
				lead: { task: "Coordinate reset" },
				agents: [{ task: "Implement reset", access: "readWrite" }],
			},
		});
		const before = await waitFor("reset agents", async () => {
			const snapshot = await at.client.request<{ agents: Agent[] }>("snapshot", {});
			return snapshot.agents.length === 2 && snapshot.agents.every((a) => a.state === "idle")
				? snapshot.agents
				: undefined;
		});
		for (const owner of before) {
			await waitFor("initial role brief", async () => {
				const tail = await at.client.request<ConversationTailResult>("conversation.tail", {
					sessionId: owner.sessionId,
					limit: 40,
				});
				return tail.turns.some((turn) => turn.endedAt !== undefined) ? true : undefined;
			});
		}
		const lead = before.find((agent) => agent.canSpawn);
		const ordinary = before.find((agent) => !agent.canSpawn);
		if (lead === undefined || ordinary === undefined) throw new Error("expected lead and ordinary agent");
		const reset = await at.client.request<{ sessionId: string }>("conversation.reset", { sessionId: lead.sessionId });
		expect(reset.sessionId).not.toBe(lead.sessionId);
		const after = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		const rebound = after.agents.find((agent) => agent.id === lead.id);
		expect(rebound).toMatchObject({
			id: lead.id,
			sessionId: reset.sessionId,
			provider: lead.provider,
			model: lead.model,
			access: lead.access,
			canSpawn: true,
		});
		expect(after.agents.find((agent) => agent.id === ordinary.id)?.sessionId).toBe(ordinary.sessionId);
		await at.client.request("conversation.tail", { sessionId: reset.sessionId, limit: 40 });
		await at.client.request("conversation.prompt", { sessionId: reset.sessionId, text: "HISTORY MCP" });
		const brief = await waitFor("reset lead brief", () =>
			at.turns.find(
				(turn) =>
					turn.sessionId === reset.sessionId && turn.block?.text?.includes("# Mission lead working agreement"),
			),
		);
		expect(brief.block?.text).toContain("# Mission: Reset roles");
		expect(brief.block?.text).toContain("Coordinate reset");
	} finally {
		await at.client.close();
	}
}, 90000);

test("an interrupted agent resumes its exact conversation when the leader continues it", async () => {
	await writeSettings(join(dir, "fake-agent-sessions.json"));
	node = await startNode({ sessionFactory: startLegacySession });
	const first = await attach();
	const firstActor = await leaderActor(first);
	const created = await first.client.request<{ content: Array<{ text: string }> }>("tools.call", {
		...firstActor,
		name: "dispatch_mission",
		arguments: {
			name: "Resume worker",
			objective: "Keep the same history",
			access: "readOnly",
			lead: { task: "remember this task" },
		},
	});
	expect(created.content[0]?.text).toContain('"number":1');
	const before = await first.client.request<{ agents: Agent[] }>("snapshot", {});
	const agent = before.agents[0];
	if (agent === undefined) throw new Error("expected agent");
	await first.client.close();
	await node.stop();

	node = await startNode({ sessionFactory: startLegacySession });
	const second = await attach();
	try {
		const actor = await leaderActor(second);
		const sent = await second.client.request<{ isError: boolean }>("tools.call", {
			...actor,
			name: "send_message",
			arguments: { agentId: agent.id, text: "continue after restart" },
		});
		expect(sent.isError).toBe(false);
		const after = await second.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(after.agents.find((one) => one.id === agent.id)?.sessionId).toBe(agent.sessionId);
		expect(["running", "idle"]).toContain(after.agents.find((one) => one.id === agent.id)?.state ?? "missing");
		// Send acknowledges durable inbox insertion; transcript projection follows.
		const history = await waitFor("resumed prompt in transcript", async () => {
			const tail = await second.client.request<ConversationTailResult>("conversation.tail", {
				sessionId: agent.sessionId,
				limit: 20,
			});
			return tail.blocks.some((block) => block.text.includes("continue after restart")) ? tail : undefined;
		});
		expect(history.blocks.some((block) => block.text.includes("continue after restart"))).toBe(true);
	} finally {
		await second.client.close();
	}
}, 90000);

test("a rejected idle-agent resume does not invent a replacement session", async () => {
	const sessionStore = join(dir, "rejecting-agent-sessions.json");
	await writeSettings(sessionStore);
	node = await startNode({ sessionFactory: startLegacySession });
	const first = await attach();
	const firstActor = await leaderActor(first);
	await first.client.request("tools.call", {
		...firstActor,
		name: "dispatch_mission",
		arguments: {
			name: "Refuse replacement",
			objective: "Keep identity",
			access: "readOnly",
			lead: { task: "remember identity" },
		},
	});
	const before = await first.client.request<{ agents: Agent[] }>("snapshot", {});
	const agent = before.agents[0];
	if (agent === undefined) throw new Error("expected agent");
	await first.client.close();
	await node.stop();
	await writeRejectingResumeSettings(sessionStore);

	node = await startNode({ sessionFactory: startLegacySession });
	const second = await attach();
	try {
		const actor = await leaderActor(second);
		const sent = await second.client.request<{ isError: boolean; content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "send_message",
			arguments: { agentId: agent.id, text: "must not fork" },
		});
		expect(sent.isError).toBe(false);
		expect(sent.content[0]?.text).toContain('"status":"queued"');
		const inbox = await second.client.request<{ messages: Array<{ text: string; status: string }> }>(
			"conversation.inbox",
			{ sessionId: agent.sessionId },
		);
		expect(
			inbox.messages.some((message) => message.text.includes("must not fork") && message.status === "queued"),
		).toBe(true);
		const after = await second.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(after.agents.find((one) => one.id === agent.id)?.state).toBe("idle");
		expect(after.agents.find((one) => one.id === agent.id)?.sessionId).toBe(agent.sessionId);
	} finally {
		await second.client.close();
	}
}, 90000);

// The leader's actor id and token, as its own MCP proxy would hold them: the
// fake agent echoes back the config it was launched with.
async function leaderActor(at: Attached): Promise<{ actorId: string; token: string }> {
	await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "MCP please" });
	const echo = await waitFor("the echoed MCP config", () => {
		const text = at.turns.find((n) => n.block?.text?.startsWith("mcp:"))?.block?.text;
		return text === undefined ? undefined : text.slice("mcp:".length);
	});
	const servers = JSON.parse(echo) as Array<{ name: string; args: string[] }>;
	const neta = servers.find((server) => server.name === "neta");
	return {
		actorId: neta?.args[neta.args.indexOf("--actor") + 1] ?? "",
		token: neta?.args[neta.args.indexOf("--token") + 1] ?? "",
	};
}

test("an initial writer launch failure releases its lease before the next writer starts", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		const leader = await leaderActor(at);
		await at.client.request("tools.call", {
			...leader,
			name: "dispatch_mission",
			arguments: {
				name: "Initial launch failure",
				objective: "clean up before continuing",
				access: "readWrite",
				lead: { task: "Coordinate launch recovery", effort: 2 },
				agents: [
					{ task: "broken first", access: "readWrite", provider: "missing" },
					{ task: "healthy second", access: "readWrite" },
				],
			},
		});
		const snapshot = await waitFor("healthy writer admission after failed launch", async () => {
			const snapshot = await at.client.request<{ missions: Array<{ agentIds: string[] }>; agents: Agent[] }>(
				"snapshot",
				{},
			);
			return snapshot.agents.some((a) => a.task === "healthy second" && a.state === "idle") ? snapshot : undefined;
		});
		expect(snapshot.agents.find((agent) => agent.task === "broken first")?.state).toBe("failed");
		expect(["starting", "running", "idle", "interrupted"]).toContain(
			snapshot.agents.find((agent) => agent.task === "healthy second")?.state ?? "missing",
		);
		expect(snapshot.missions[0]?.agentIds).toHaveLength(3);
	} finally {
		await at.client.close();
	}
}, 90000);

test("restart preserves writer FIFO and the queued head's exact session", async () => {
	await writeSettings(join(dir, "writer-restart-sessions.json"));
	node = await startNode({ sessionFactory: startLegacySession });
	const firstNode = await attach();
	const leader = await leaderActor(firstNode);
	await firstNode.client.request("tools.call", {
		...leader,
		name: "dispatch_mission",
		arguments: {
			name: "Restart writers",
			objective: "preserve FIFO",
			access: "readWrite",
			lead: { task: "Coordinate writer recovery", effort: 2 },
			agents: [
				{ task: "interrupted holder", access: "readWrite" },
				{ task: "queued head", access: "readWrite" },
			],
		},
	});
	const before = await firstNode.client.request<{ agents: Agent[] }>("snapshot", {});
	const head = before.agents.find((agent) => agent.task === "queued head");
	if (head === undefined) throw new Error("expected queued head");
	expect(head.state).toBe("queued");
	await firstNode.client.close();
	await node.stop();

	node = await startNode({ sessionFactory: startLegacySession });
	const secondNode = await attach();
	try {
		const nextLeader = await leaderActor(secondNode);
		const sent = await secondNode.client.request<{ isError: boolean }>("tools.call", {
			...nextLeader,
			name: "send_message",
			arguments: { agentId: head.id, text: "continue FIFO head" },
		});
		expect(sent.isError).toBe(false);
		const after = await secondNode.client.request<{ agents: Agent[] }>("snapshot", {});
		const resumedHead = after.agents.find((agent) => agent.id === head.id);
		expect(resumedHead?.sessionId).toBe(head.sessionId);
		expect(resumedHead, JSON.stringify(resumedHead)).toMatchObject({ sessionId: head.sessionId });
		expect(resumedHead?.runtimeError).toBeUndefined();
		expect(["starting", "running", "idle"]).toContain(resumedHead?.state ?? "missing");
		const headHistory = await secondNode.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: head.sessionId,
			limit: 40,
		});
		expect(headHistory.blocks.some((block) => block.text.includes("queued head"))).toBe(true);
		expect(after.agents.find((agent) => agent.task === "interrupted holder")?.runtimeError).toBeUndefined();
		expect(["idle", "interrupted"]).toContain(
			after.agents.find((agent) => agent.task === "interrupted holder")?.state ?? "missing",
		);
	} finally {
		await secondNode.client.close();
	}
}, 90000);

test("concurrent agent additions preserve both ids and admit one real writer", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		const leader = await leaderActor(at);
		const made = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			...leader,
			name: "dispatch_mission",
			arguments: {
				name: "Concurrent additions",
				objective: "keep both",
				access: "readWrite",
				lead: { task: "Coordinate additions", effort: 2 },
			},
		});
		const mission = JSON.parse(made.content[0]?.text.split("\n")[0] ?? "{}") as { id: string };
		await Promise.all(
			["writer one", "writer two"].map((task) =>
				at.client.request("tools.call", {
					...leader,
					name: "spawn_agent",
					arguments: { missionId: mission.id, task, access: "readWrite" },
				}),
			),
		);
		const snapshot = await at.client.request<{
			missions: Array<{ id: string; agentIds: string[] }>;
			agents: Agent[];
		}>("snapshot", {});
		const agents = snapshot.agents.filter((agent) => agent.missionId === mission.id);
		expect(agents.filter((agent) => !agent.canSpawn)).toHaveLength(2);
		expect(snapshot.missions.find((one) => one.id === mission.id)?.agentIds).toHaveLength(3);
		expect(agents.filter((agent) => ["starting", "running"].includes(agent.state)).length).toBeLessThanOrEqual(1);
		await waitFor("both queued writers to finish", async () => {
			const state = await at.client.request<{ agents: Agent[] }>("snapshot", {});
			const children = state.agents.filter((a) => a.missionId === mission.id && !a.canSpawn);
			return children.length === 2 && children.every((a) => a.state === "idle" && !a.runtimeError)
				? true
				: undefined;
		});
	} finally {
		await at.client.close();
	}
}, 90000);

test("the real Node mount reserves a separate lead before persisting and launching a mission", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		// The actor token is minted at session launch and handed to the
		// session's MCP proxy; the fake agent echoes the config it was given.
		const { actorId, token } = await leaderActor(at);
		expect(actorId).toBe(at.leader.sessionId);
		expect(token).toMatch(/^[0-9a-f]{64}$/);

		const listed = await at.client.request<{ tools: Array<{ name: string }> }>("tools.list", { actorId, token });
		expect(listed.tools.map((tool) => tool.name)).toContain("dispatch_mission");

		// A bad token reaches no handler.
		await expect(at.client.request("tools.list", { actorId, token: "0".repeat(64) })).rejects.toThrow();

		const called = await at.client.request<{ content: Array<{ text: string }>; isError: boolean }>("tools.call", {
			actorId,
			token,
			name: "dispatch_mission",
			arguments: {
				name: "Fix the widget",
				objective: "Make it work",
				access: "readOnly",
				lead: { task: "Lead the widget fix", model: at.leader.model },
			},
		});
		expect(called.isError).toBe(false);
		const created = JSON.parse(called.content[0]?.text.split("\n")[0] ?? "{}") as { number: number; id: string };
		expect(created.number).toBe(1);

		// It is on the spine's side of the wire too: in the snapshot, and
		// announced as one `state` notification.
		const snapshot = await at.client.request<{
			missions: Array<{ id: string; name: string; lead: { kind: string; agentId?: string }; agentIds: string[] }>;
			agents: Array<{ id: string; sessionId: string }>;
		}>("snapshot", {});
		expect(snapshot.missions.map((m) => m.name)).toContain("Fix the widget");
		const mission = snapshot.missions.find((m) => m.id === created.id);
		expect(mission?.lead.kind).toBe("agent");
		const lead = snapshot.agents.find((agent) => agent.id === mission?.lead.agentId);
		expect(lead?.sessionId).not.toBe(at.leader.sessionId);
		expect(mission?.agentIds).toContain(lead?.id);
		expect(at.states.some((s) => s.kind === "mission" && (s.record as { id: string }).id === created.id)).toBe(true);
	} finally {
		await at.client.close();
	}
}, 90000);

test("a saved self-led mission remains readable and closeable without resuming self-lead work", async () => {
	node = await startNode({ sessionFactory: startLegacySession });
	const first = await attach();
	const leader = first.leader;
	const mission = {
		id: ulid(),
		number: 1,
		workspaceId: leader.workspaceId,
		machineId: leader.machineId,
		name: "Historical direct work",
		objective: "Review old work",
		lead: { kind: "leader" as const },
		agentIds: [],
		access: "readOnly" as const,
		state: "open",
		createdAt: new Date().toISOString(),
	};
	await first.client.close();
	await node.stop();
	await appendLine(paths().registryLog(leader.workspaceId), { op: "create", at: mission.createdAt, mission });
	node = await startNode({ sessionFactory: startLegacySession });
	const second = await attach();
	try {
		const before = await second.client.request<{ missions: Array<{ id: string; lead: { kind: string } }> }>(
			"snapshot",
			{},
		);
		expect(before.missions.find((one) => one.id === mission.id)?.lead.kind).toBe("leader");
		const actor = await leaderActor(second);
		const refused = await second.client.request<{ isError: boolean; content: Array<{ text: string }> }>(
			"tools.call",
			{
				...actor,
				name: "spawn_agent",
				arguments: { missionId: mission.number, task: "resume old work", access: "readOnly" },
			},
		);
		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toContain("legacy self-led mission cannot resume");
		const closed = await second.client.request<{ isError: boolean }>("tools.call", {
			...actor,
			name: "close",
			arguments: { missionId: mission.number, disposition: "completed", reason: "Historical review finished" },
		});
		expect(closed.isError).toBe(false);
		const after = await second.client.request<{
			missions: Array<{ id: string; state: string; lead: { kind: string } }>;
		}>("snapshot", {});
		expect(after.missions.find((one) => one.id === mission.id)).toMatchObject({
			state: "closed",
			lead: { kind: "leader" },
		});
	} finally {
		await second.client.close();
	}
}, 90000);

test("the fake ACP creates a mission through the injected MCP stdio proxy", async () => {
	const control = await shortTempDir("neta-mcp-e2e-");
	process.env.NETA_BIN = MCP_RUNNER;
	await writeMissionE2ESettings(control);
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "MCP_E2E_CREATE" });
		const state = await waitFor(
			"MCP mission fixture result",
			async () => {
				const raw = await Bun.file(join(control, "state.json"))
					.text()
					.catch(() => "");
				if (raw === "") return undefined;
				const current = JSON.parse(raw) as { stage?: string; missionId?: string; error?: string };
				if (current.error !== undefined) return current;
				return current.missionId === undefined ? undefined : current;
			},
			15_000,
		);
		expect(state.error).toBeUndefined();
		expect(state.missionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		const created = await at.client.request<{ agents: Array<{ id: string; missionId: string; sessionId: string }> }>(
			"snapshot",
			{},
		);
		const lead = created.agents.find((agent) => agent.missionId === state.missionId);
		expect(lead).toBeDefined();
		await at.client.request("conversation.tail", { sessionId: lead?.sessionId, limit: 20 });
		const blocked = await waitFor("the question in an ordinary final reply", async () => {
			const raw = await Bun.file(join(control, "state.json")).text();
			const current = JSON.parse(raw) as { stage?: string; missionId?: string; agentId?: string; error?: string };
			if (current.error !== undefined) throw new Error(current.error);
			if (current.stage !== "blocked" || current.agentId === undefined) return undefined;
			const snapshot = await at.client.request<{ agents: Array<{ id: string; state: string }> }>("snapshot", {});
			return current.agentId === lead?.id &&
				snapshot.agents.find((agent) => agent.id === current.agentId)?.state === "idle"
				? current
				: undefined;
		});
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "MCP_E2E_RUN" });
		await waitFor("the MCP-resumed running agent", async () => {
			const current = JSON.parse(await Bun.file(join(control, "state.json")).text()) as {
				stage?: string;
				agentId?: string;
				error?: string;
			};
			if (current.error !== undefined) throw new Error(current.error);
			const snapshot = await at.client.request<{ agents: Array<{ id: string; state: string }> }>("snapshot", {});
			return current.stage === "running" &&
				snapshot.agents.find((agent) => agent.id === current.agentId)?.state === "running"
				? true
				: undefined;
		});
		await writeFile(join(control, "complete.release"), "release\n");
		await waitFor("the MCP-completed agent", async () => {
			const snapshot = await at.client.request<{ agents: Array<{ id: string; state: string }> }>("snapshot", {});
			return snapshot.agents.find((agent) => agent.id === blocked.agentId)?.state === "idle" ? true : undefined;
		});
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "MCP_E2E_CLOSE" });
		await waitFor("the MCP-closed mission", async () => {
			const snapshot = await at.client.request<{ missions: Array<{ id: string; state: string }> }>("snapshot", {});
			return snapshot.missions.find((mission) => mission.id === blocked.missionId)?.state === "closed"
				? true
				: undefined;
		});
	} finally {
		await at.client.close();
		if (process.env.KEEP_MCP_E2E !== "1") await rm(control, { recursive: true, force: true });
	}
}, 30000);

test("a skill in the workspace root is found, whatever the node's cwd is", async () => {
	await mkdir(join(work, ".neta", "skills"), { recursive: true });
	await writeFile(join(work, ".neta", "skills", "repo-only.md"), "# Repo only\n\nUse the repo's own tools.\n");
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		const { actorId, token } = await leaderActor(at);
		const called = await at.client.request<{ content: Array<{ text: string }>; isError: boolean }>("tools.call", {
			actorId,
			token,
			name: "dispatch_mission",
			arguments: {
				name: "Read the loader",
				objective: "Say how it works",
				access: "readOnly",
				lead: { task: "read it", skills: ["repo-only"] },
			},
		});
		expect(called.isError).toBe(false);

		// A name that is in no skills directory is still refused, with the
		// tool's own code rather than a silently skill-less agent.
		const missing = await at.client.request<{ content: Array<{ text: string }>; isError: boolean }>("tools.call", {
			actorId,
			token,
			name: "dispatch_mission",
			arguments: {
				name: "Read it again",
				objective: "Say how it works",
				access: "readOnly",
				lead: { task: "read it", skills: ["nowhere"] },
			},
		});
		expect(missing.isError).toBe(true);
		expect(missing.content[0]?.text).toContain("missingSkill");
	} finally {
		await at.client.close();
	}
}, 90000);

test("a provider handoff survives restart until the next accepted prompt", async () => {
	const sessionStore = join(dir, "provider-handoff-restart.json");
	await writeTwoProviderSettings(sessionStore);
	node = await startNode({ sessionFactory: startLegacySession });
	const first = await attach();
	await first.client.request("conversation.setProvider", {
		sessionId: first.leader.sessionId,
		provider: "alternate",
		handoff: "# Edited handoff\n\nHANDOFF_RESTART_MARKER",
	});
	const sessionId = first.leader.sessionId;
	await first.client.close();
	await node.stop();

	node = await startNode({ sessionFactory: startLegacySession });
	const second = await attach();
	try {
		await second.client.request("conversation.prompt", { sessionId, text: "AFTER_RESTART" });
		await waitFor("accepted handoff prompt", () =>
			second.turns.find((turn) => turn.sessionId === sessionId && turn.turn?.endedAt !== undefined),
		);
		await second.client.request("conversation.prompt", { sessionId, text: "HISTORY" });
		const history = await waitFor(
			"restarted handoff history",
			() =>
				second.turns.find(
					(turn) => turn.sessionId === sessionId && turn.block?.text?.includes("HANDOFF_RESTART_MARKER"),
				)?.block?.text,
		);
		expect(history.match(/HANDOFF_RESTART_MARKER/g)).toHaveLength(1);
	} finally {
		await second.client.close();
	}
}, 90000);

test("workspace reset archives missions and starts blank leader and Neta chats", async () => {
	await writeSettings(join(dir, "reset-workspace-sessions.json"));
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		const oldNeta = await at.client.request<{ sessionId: string }>("workspace-leader.open", {
			workspaceId: at.leader.workspaceId,
		});
		await at.client.request("conversation.tail", { sessionId: oldNeta.sessionId });
		await at.client.request("conversation.prompt", {
			sessionId: oldNeta.sessionId,
			text: "OLD_NETA_CHAT",
		});
		await waitFor("old Neta chat turn", () =>
			at.turns.find((turn) => turn.sessionId === oldNeta.sessionId && turn.block?.text?.includes("OLD_NETA_CHAT")),
		);
		const creation = await at.client.request<{ isError?: boolean }>("tools.call", {
			...(await leaderActor(at)),
			name: "dispatch_mission",
			arguments: {
				name: "Archive reset",
				objective: "reset all",
				access: "readWrite",
				lead: { task: "Coordinate reset", effort: 2 },
				agents: [
					{ task: "first worker", access: "readWrite" },
					{ task: "queued worker", access: "readWrite" },
				],
			},
		});
		if (creation.isError) throw new Error(JSON.stringify(creation));
		const beforeReset = await at.client.request<{ agents: Agent[] }>("snapshot");
		if (beforeReset.agents.length !== 3) throw new Error(JSON.stringify({ creation, beforeReset }));
		expect(beforeReset.agents.filter((agent) => !agent.canSpawn)).toHaveLength(2);
		await expect(at.client.request("workspace.reset", { workspaceId: at.leader.workspaceId })).rejects.toThrow(
			"confirmation",
		);
		await at.client.request("workspace.reset", { workspaceId: at.leader.workspaceId, confirm: true });
		const snapshot = await at.client.request<{ leaders: Leader[]; agents: Agent[]; missions: { state: string }[] }>(
			"snapshot",
		);
		expect(snapshot.missions.every((mission) => mission.state === "closed")).toBe(true);
		expect(snapshot.agents).toHaveLength(0);
		const archived = await at.client.request<{ agents: Agent[] }>("missions.get", {
			missionId: beforeReset.agents[0]?.missionId,
		});
		expect(archived.agents).toHaveLength(3);
		expect(archived.agents.every((agent) => agent.state === "archived")).toBe(true);
		expect(snapshot.leaders).toHaveLength(1);
		const leader = snapshot.leaders[0];
		expect(leader?.sessionId).not.toBe(at.leader.sessionId);
		const tail = await at.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: leader?.sessionId,
		});
		expect(tail.blocks).toEqual([]);
		const freshNeta = await at.client.request<{ sessionId: string }>("workspace-leader.open", {
			workspaceId: at.leader.workspaceId,
		});
		expect(freshNeta.sessionId).not.toBe(oldNeta.sessionId);
		const solTail = await at.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: freshNeta.sessionId,
		});
		expect(solTail.blocks).toEqual([]);
	} finally {
		await at.client.close();
	}
}, 90000);

test("workspace reset on a git workspace reclaims clean idle worktrees and keeps active ones open", async () => {
	await makeGitWorkspace();
	await writeBarrierSettings(
		join(dir, "reset-git-workspace-sessions.json"),
		join(dir, "reset-barrier"),
		join(dir, "reset-barrier-ready"),
	);
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		const actor = await leaderActor(at);
		const busy = await at.client.request<{ isError?: boolean; content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "dispatch_mission",
			arguments: {
				name: "Busy reset",
				objective: "stay active across reset",
				access: "readWrite",
				lead: { task: "Coordinate busy reset", effort: 2 },
				agents: [
					// The first writer blocks on the barrier while holding the
					// lease, so the second writer stays queued behind it.
					{ task: "WAIT_FOR_BARRIER hold the writer lease", access: "readWrite" },
					{ task: "queued writer", access: "readWrite" },
				],
			},
		});
		if (busy.isError) throw new Error(JSON.stringify(busy));
		const busyId = (JSON.parse(busy.content[0]?.text.split("\n")[0] ?? "{}") as { id: string }).id;
		const idle = await at.client.request<{ isError?: boolean; content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "dispatch_mission",
			arguments: {
				name: "Idle reset",
				objective: "inspect only",
				access: "readOnly",
				lead: { task: "Coordinate idle reset", effort: 1 },
			},
		});
		if (idle.isError) throw new Error(JSON.stringify(idle));
		const idleId = (JSON.parse(idle.content[0]?.text.split("\n")[0] ?? "{}") as { id: string }).id;
		const leads = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		const busyLead = leads.agents.find((agent) => agent.missionId === busyId && agent.canSpawn);
		if (!busyLead) throw new Error("missing busy lead");
		await at.client.request("conversation.tail", { sessionId: busyLead.sessionId, limit: 20 });
		await at.client.request("conversation.prompt", { sessionId: busyLead.sessionId, text: "HOLD_FOREVER" });
		await waitFor("busy lead turn", () =>
			at.turns.find((turn) => turn.sessionId === busyLead.sessionId && turn.turn?.endedAt === undefined),
		);
		// The first writer blocks on the barrier while holding the lease, so
		// the second writer stays queued behind it; neither may be promoted
		// (started) by reset's own lease releases.
		await waitFor("queued writer waiting", async () => {
			const current = await at.client.request<{ agents: Agent[] }>("snapshot", {});
			const workers = current.agents.filter((agent) => agent.missionId === busyId && !agent.canSpawn);
			return workers.some((agent) => agent.state === "running") && workers.some((agent) => agent.state === "queued")
				? true
				: undefined;
		});
		await waitFor("idle lead settled", async () => {
			const current = await at.client.request<{ agents: Agent[] }>("snapshot", {});
			const lead = current.agents.find((agent) => agent.missionId === idleId && agent.canSpawn);
			return lead !== undefined && ["idle", "completed"].includes(lead.state) ? true : undefined;
		});
		const beforeA = await at.client.request<{ mission: Mission }>("missions.get", { missionId: busyId });
		const beforeB = await at.client.request<{ mission: Mission }>("missions.get", { missionId: idleId });
		const pathA = beforeA.mission.worktree?.path;
		const pathB = beforeB.mission.worktree?.path;
		const branchB = beforeB.mission.worktree?.branch;
		if (!pathA || !pathB || !branchB) throw new Error(JSON.stringify({ beforeA, beforeB }));
		await expect(stat(pathA)).resolves.toBeDefined();
		await expect(stat(pathB)).resolves.toBeDefined();

		await at.client.request("workspace.reset", { workspaceId: at.leader.workspaceId, confirm: true });

		// The busy mission stays open with its directory intact and a reason.
		const afterA = await at.client.request<{ mission: Mission; agents: Agent[] }>("missions.get", {
			missionId: busyId,
		});
		expect(afterA.mission.state).not.toBe("closed");
		expect(afterA.mission.worktree?.path).toBe(pathA);
		expect(afterA.mission.attention).toContain("agents were active");
		await expect(stat(pathA)).resolves.toBeDefined();
		expect(afterA.agents.every((agent) => agent.state === "archived")).toBe(true);
		expect(afterA.agents.some((agent) => !agent.canSpawn)).toBe(true);
		// The clean idle mission closed through the pipeline: its directory
		// is reclaimed while its committed branch is retained.
		const afterB = await at.client.request<{ mission: Mission }>("missions.get", { missionId: idleId });
		expect(afterB.mission.state).toBe("closed");
		expect(afterB.mission.worktree).toBeUndefined();
		await expect(stat(pathB)).rejects.toThrow();
		const branchCheck = Bun.spawn(["git", "rev-parse", "--verify", branchB], { cwd: work, stdout: "ignore" });
		expect(await branchCheck.exited).toBe(0);
		// No queued work was promoted across the reset.
		const snapshot = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(snapshot.agents.filter((agent) => ["queued", "starting", "running"].includes(agent.state))).toHaveLength(
			0,
		);
	} finally {
		await at.client.close();
	}
}, 90000);

test("runtime wakes coordinator when mission leader ends without a completion tool", async () => {
	await writeSettings(join(dir, "automatic-report-sessions.json"));
	node = await startNode({ sessionFactory: startLegacySession });
	const at = await attach();
	try {
		const creation = await at.client.request<{ isError?: boolean }>("tools.call", {
			...(await leaderActor(at)),
			name: "dispatch_mission",
			arguments: {
				name: "Automatic report",
				objective: "inspect only",
				access: "readOnly",
				lead: { task: "CONFIG_UPDATE", effort: 2 },
			},
		});
		expect(creation.isError).not.toBe(true);
		let messages: Array<{ text: string; status: string }> = [];
		for (let attempt = 0; attempt < 200; attempt++) {
			const inbox = await at.client.request<{ messages: typeof messages }>("conversation.inbox", {
				sessionId: at.leader.sessionId,
			});
			messages = inbox.messages;
			if (
				messages?.some(
					(message) => message.text.includes("Neta automatic report") && message.status === "delivered",
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(
			messages?.some((message) => message.text.includes("Neta automatic report") && message.status === "delivered"),
		).toBe(true);
		const snapshot = await at.client.request<{ agents: Agent[] }>("snapshot");
		const missionLead = snapshot.agents.find((agent) => agent.canSpawn);
		if (!missionLead) throw new Error("mission lead is missing");
		expect(missionLead.model).toBe("fixture-fast");
		expect(messages.some((message) => message.text.includes(`Actual model: ${missionLead.model}`))).toBe(true);
		const workerCreation = await at.client.request<{ isError?: boolean }>("tools.call", {
			...(await leaderActor(at)),
			name: "spawn_agent",
			arguments: { missionId: missionLead.missionId, task: "hello worker", access: "readOnly" },
		});
		expect(workerCreation.isError).not.toBe(true);
		let parentMessages: typeof messages = [];
		for (let attempt = 0; attempt < 200; attempt++) {
			const inbox = await at.client.request<{ messages: typeof messages }>("conversation.inbox", {
				sessionId: missionLead.sessionId,
			});
			parentMessages = inbox.messages;
			if (
				parentMessages.some(
					(message) => message.text.includes("Neta automatic report") && message.status === "delivered",
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(
			parentMessages.some((message) => message.text.includes("(worker)") && message.status === "delivered"),
		).toBe(true);
	} finally {
		await at.client.close();
	}
}, 15000);
