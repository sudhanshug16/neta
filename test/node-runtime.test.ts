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
//   `neta_mission` reaches the registry and the snapshot.
// - the `neta_mode` gate: the charter's `## Reserved for the user` section is
//   parsed from the real workspace root, so a leader cannot grant itself
//   Lead++ over a reservation, and both directions of the switch land on the
//   leader record.
// - skills resolve against the workspace root, not the directory the node
//   happened to be detached from.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Block, Leader, Turn, Workspace } from "../src/core/types.ts";
import { connectNode, type NodeClient } from "../src/node/client.ts";
import { type Node as NetaNode, startNode } from "../src/node/lifecycle.ts";
import type { ConversationTailResult, StateNotification, TurnNotification } from "../src/node/protocol.ts";

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

async function writeCwdResumeSettings(sessionStore: string): Promise<void> {
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			providers: {
				fake: {
					command: process.execPath,
					args: [FIXTURE, "--session-store", sessionStore, "--allow-resume-cwd-change"],
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
			providers: { fake: provider(), alternate: provider() },
			leader: { provider: "fake", model: "test-model" },
			forbiddenModels: [],
		}),
	);
}

async function writeRejectingAlternateSettings(sessionStore: string): Promise<void> {
	const provider = (extra: string[] = []) => ({
		command: process.execPath,
		args: [FIXTURE, "--session-store", sessionStore, ...extra],
		resume: true,
		defaultModel: "test-model",
	});
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			providers: { fake: provider(), alternate: provider(["--reject-resume"]) },
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

test("a fresh workspace remains selectable when its provider fails and recovers on reopen", async () => {
	await writeUnavailableProviderSettings();
	node = await startNode();
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
		expect(catalog.providers.find((one) => one.id === "alternate")?.available).toBe(true);
		await expect(
			client.request("conversation.setProvider", {
				sessionId: opened.leader.sessionId,
				provider: "fake",
			}),
		).rejects.toThrow();
		const stillFailed = await client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(stillFailed.leaders.find((one) => one.workspaceId === opened.workspace.id)).toEqual(opened.leader);
		const switched = await client.request<{ sessionId: string; provider: string }>("conversation.setProvider", {
			sessionId: opened.leader.sessionId,
			provider: "alternate",
		});
		expect(switched.provider).toBe("alternate");
		expect(switched.sessionId).not.toBe(opened.leader.sessionId);
		const recoveredSnapshot = await client.request<{ leaders: Leader[] }>("snapshot", {});
		const recovered = recoveredSnapshot.leaders.find((one) => one.workspaceId === opened.workspace.id);
		expect(recovered?.state).toBe("idle");
		expect(recovered?.sessionId).toBe(switched.sessionId);
		const models = await client.request<{ models: Array<{ id: string }> }>("models.list", {
			sessionId: switched.sessionId,
		});
		expect(models.models.length).toBeGreaterThan(0);
		const capabilities = await client.request<{ image: boolean; embeddedContext: boolean }>(
			"conversation.capabilities",
			{ sessionId: switched.sessionId },
		);
		expect(capabilities).toEqual({ image: true, embeddedContext: true });
		await client.request("conversation.tail", { sessionId: switched.sessionId, limit: 20 });
		await client.request("conversation.prompt", { sessionId: switched.sessionId, text: "recovered" });
		await waitFor("recovered provider reply", async () => {
			const tail = await client.request<ConversationTailResult>("conversation.tail", {
				sessionId: switched.sessionId,
				limit: 20,
			});
			return tail.blocks.some((block) => block.role === "agent" && block.text.includes("echo:recovered"))
				? true
				: undefined;
		});
	} finally {
		await client.close();
	}
}, 90000);

test("a prompt persists the user turn, the blocks and the closed turn", async () => {
	node = await startNode();
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
	node = await startNode();
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
	node = await startNode();
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
	node = await startNode();
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
	node = await startNode();
	const first = await attach();
	await first.client.request("conversation.prompt", { sessionId: first.leader.sessionId, text: "before" });
	await waitFor("the first reply", () => first.turns.find((n) => n.block?.text === "echo:before"));
	await first.client.close();
	await node.stop();

	node = await startNode();
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
	node = await startNode();
	const first = await attach();
	await first.client.request("conversation.prompt", { sessionId: first.leader.sessionId, text: "before" });
	await waitFor("the first reply", () => first.turns.find((n) => n.block?.text === "echo:before"));
	await first.client.close();
	await node.stop();

	node = await startNode();
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
	node = await startNode();
	const first = await attach();
	await first.client.request("conversation.prompt", {
		sessionId: first.leader.sessionId,
		text: "UNWANTED_RESET_CONTEXT",
	});
	await waitFor("old reset context turn", () =>
		first.turns.find((turn) => turn.block?.text?.includes("UNWANTED_RESET_CONTEXT")),
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
	await waitFor("old active turn closed by reset", () =>
		first.turns.find(
			(turn) => turn.turn?.id === held.turnId && turn.turn.endedAt !== undefined && turn.turn.cancelled,
		),
	);
	await first.client.request("conversation.tail", { sessionId: reset.sessionId, limit: 40 });
	await first.client.request("conversation.prompt", { sessionId: reset.sessionId, text: "HISTORY MCP" });
	const fresh = await waitFor("fresh reset history", () =>
		first.turns.find(
			(turn) => turn.sessionId === reset.sessionId && turn.block?.text?.includes("# Leader working agreement"),
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
	node = await startNode();
	const second = await attach();
	try {
		expect(second.leader.sessionId).toBe(reset.sessionId);
		await second.client.request("conversation.prompt", { sessionId: reset.sessionId, text: "AFTER_RESET_RESTART" });
		await waitFor("reset session after restart", () =>
			second.turns.find(
				(turn) => turn.sessionId === reset.sessionId && turn.block?.text?.includes("AFTER_RESET_RESTART"),
			),
		);
	} finally {
		await second.client.close();
	}
}, 90000);

test("a reset provider startup failure leaves the old owner and chat usable", async () => {
	await writeSettings(join(dir, "reset-failure-sessions.json"));
	node = await startNode();
	const at = await attach();
	try {
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
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
	node = await startNode();
	const at = await attach();
	try {
		const actor = await leaderActor(at);
		await at.client.request("tools.call", {
			...actor,
			name: "neta_mission",
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
			return snapshot.agents.length === 2 ? snapshot.agents : undefined;
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
				(turn) => turn.sessionId === reset.sessionId && turn.block?.text?.includes("# Lead working agreement"),
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
	node = await startNode();
	const first = await attach();
	const firstActor = await leaderActor(first);
	const created = await first.client.request<{ content: Array<{ text: string }> }>("tools.call", {
		...firstActor,
		name: "neta_mission",
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

	node = await startNode();
	const second = await attach();
	try {
		const actor = await leaderActor(second);
		const sent = await second.client.request<{ isError: boolean }>("tools.call", {
			...actor,
			name: "neta_send",
			arguments: { agentId: agent.id, text: "continue after restart" },
		});
		expect(sent.isError).toBe(false);
		const after = await second.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(after.agents.find((one) => one.id === agent.id)?.state).toBe("running");
		const history = await second.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: agent.sessionId,
			limit: 20,
		});
		expect(history.blocks.some((block) => block.text === "continue after restart")).toBe(true);
	} finally {
		await second.client.close();
	}
}, 90000);

test("a rejected interrupted-agent resume does not invent a replacement session", async () => {
	const sessionStore = join(dir, "rejecting-agent-sessions.json");
	await writeSettings(sessionStore);
	node = await startNode();
	const first = await attach();
	const firstActor = await leaderActor(first);
	await first.client.request("tools.call", {
		...firstActor,
		name: "neta_mission",
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

	node = await startNode();
	const second = await attach();
	try {
		const actor = await leaderActor(second);
		const sent = await second.client.request<{ isError: boolean; content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "neta_send",
			arguments: { agentId: agent.id, text: "must not fork" },
		});
		expect(sent.isError).toBe(true);
		expect(sent.content[0]?.text).toContain("cannot be resumed");
		const after = await second.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(after.agents.find((one) => one.id === agent.id)?.state).toBe("interrupted");
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

async function agentActor(at: Attached, agent: Agent): Promise<{ actorId: string; token: string }> {
	await at.client.request("conversation.tail", { sessionId: agent.sessionId, limit: 20 });
	await at.client.request("conversation.prompt", { sessionId: agent.sessionId, text: "MCP please" });
	const echo = await waitFor("the agent MCP config", () => {
		const block = at.turns.find((n) => n.sessionId === agent.sessionId && n.block?.text?.startsWith("mcp:"));
		return block?.block?.text?.slice("mcp:".length);
	});
	const servers = JSON.parse(echo) as Array<{ name: string; args: string[] }>;
	const neta = servers.find((server) => server.name === "neta");
	return {
		actorId: neta?.args[neta.args.indexOf("--actor") + 1] ?? "",
		token: neta?.args[neta.args.indexOf("--token") + 1] ?? "",
	};
}

test("two real writers serialize and completion starts exactly one queued successor", async () => {
	node = await startNode();
	const at = await attach();
	try {
		const leader = await leaderActor(at);
		await at.client.request("tools.call", {
			...leader,
			name: "neta_mission",
			arguments: {
				name: "Serialized writers",
				objective: "one writer at a time",
				access: "readWrite",
				lead: "self",
				agents: [
					{ task: "first writer", access: "readWrite" },
					{ task: "second writer", access: "readWrite" },
				],
			},
		});
		let snapshot = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		const first = snapshot.agents.find((agent) => agent.state === "starting");
		const second = snapshot.agents.find((agent) => agent.state === "queued");
		if (first === undefined || second === undefined) throw new Error("expected active and queued writers");
		await expect(
			at.client.request("conversation.tail", { sessionId: second.sessionId, limit: 20 }),
		).rejects.toThrow();
		const actor = await agentActor(at, first);
		await at.client.request("tools.call", { ...actor, name: "neta_done", arguments: { outcome: "first complete" } });
		await waitFor("queued writer promotion", () =>
			at.states.find(
				(state) =>
					state.kind === "agent" &&
					(state.record as Agent).id === second.id &&
					(state.record as Agent).state === "starting",
			),
		);
		snapshot = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(snapshot.agents.find((agent) => agent.id === first.id)?.state).toBe("completed");
		expect(snapshot.agents.find((agent) => agent.id === second.id)?.state).toBe("starting");
		const promoted = await waitFor("promoted writer brief", async () => {
			const tail = await at.client.request<ConversationTailResult>("conversation.tail", {
				sessionId: second.sessionId,
				limit: 20,
			});
			return tail.blocks.length > 0 ? tail : undefined;
		});
		expect(promoted.blocks.length).toBeGreaterThan(0);
	} finally {
		await at.client.close();
	}
}, 90000);

test("a failed promoted writer is closed before the next queued writer starts", async () => {
	node = await startNode();
	const at = await attach();
	try {
		const leader = await leaderActor(at);
		await at.client.request("tools.call", {
			...leader,
			name: "neta_mission",
			arguments: {
				name: "Promotion failure",
				objective: "skip a broken provider",
				access: "readWrite",
				lead: "self",
				agents: [
					{ task: "holder", access: "readWrite" },
					{ task: "broken", access: "readWrite", provider: "missing" },
					{ task: "successor", access: "readWrite" },
				],
			},
		});
		const before = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		const holder = before.agents.find((agent) => agent.task === "holder");
		if (holder === undefined) throw new Error("expected holder");
		const actor = await agentActor(at, holder);
		await at.client.request("tools.call", { ...actor, name: "neta_done", arguments: { outcome: "release" } });
		await waitFor("third writer promotion", () =>
			at.states.find(
				(state) =>
					state.kind === "agent" &&
					(state.record as Agent).task === "successor" &&
					(state.record as Agent).state === "starting",
			),
		);
		const after = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(after.agents.find((agent) => agent.task === "broken")?.state).toBe("failed");
		expect(after.agents.find((agent) => agent.task === "successor")?.state).toBe("starting");
	} finally {
		await at.client.close();
	}
}, 90000);

test("an initial writer launch failure releases its lease before the next writer starts", async () => {
	node = await startNode();
	const at = await attach();
	try {
		const leader = await leaderActor(at);
		await at.client.request("tools.call", {
			...leader,
			name: "neta_mission",
			arguments: {
				name: "Initial launch failure",
				objective: "clean up before continuing",
				access: "readWrite",
				lead: "self",
				agents: [
					{ task: "broken first", access: "readWrite", provider: "missing" },
					{ task: "healthy second", access: "readWrite" },
				],
			},
		});
		const snapshot = await at.client.request<{ missions: Array<{ agentIds: string[] }>; agents: Agent[] }>(
			"snapshot",
			{},
		);
		expect(snapshot.agents.find((agent) => agent.task === "broken first")?.state).toBe("failed");
		expect(snapshot.agents.find((agent) => agent.task === "healthy second")?.state).toBe("starting");
		expect(snapshot.missions[0]?.agentIds).toHaveLength(2);
	} finally {
		await at.client.close();
	}
}, 90000);

test("restart preserves writer FIFO and explicit continuation starts the queued head", async () => {
	await writeSettings(join(dir, "writer-restart-sessions.json"));
	node = await startNode();
	const firstNode = await attach();
	const leader = await leaderActor(firstNode);
	await firstNode.client.request("tools.call", {
		...leader,
		name: "neta_mission",
		arguments: {
			name: "Restart writers",
			objective: "preserve FIFO",
			access: "readWrite",
			lead: "self",
			agents: [
				{ task: "interrupted holder", access: "readWrite" },
				{ task: "queued head", access: "readWrite" },
			],
		},
	});
	const before = await firstNode.client.request<{ agents: Agent[] }>("snapshot", {});
	const head = before.agents.find((agent) => agent.task === "queued head");
	if (head === undefined) throw new Error("expected queued head");
	await firstNode.client.close();
	await node.stop();

	node = await startNode();
	const secondNode = await attach();
	try {
		const nextLeader = await leaderActor(secondNode);
		const sent = await secondNode.client.request<{ isError: boolean }>("tools.call", {
			...nextLeader,
			name: "neta_send",
			arguments: { agentId: head.id, text: "continue FIFO head" },
		});
		expect(sent.isError).toBe(false);
		await waitFor("queued head start after restart", () =>
			secondNode.states.find(
				(state) =>
					state.kind === "agent" &&
					(state.record as Agent).id === head.id &&
					(state.record as Agent).state === "starting",
			),
		);
		const after = await secondNode.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(after.agents.find((agent) => agent.id === head.id)?.state).toBe("starting");
		expect(after.agents.find((agent) => agent.task === "interrupted holder")?.state).toBe("interrupted");
	} finally {
		await secondNode.client.close();
	}
}, 90000);

test("an interrupted writer queued behind another resumes its exact history when promoted", async () => {
	await writeSettings(join(dir, "queued-resume-sessions.json"));
	node = await startNode();
	const firstNode = await attach();
	const leader = await leaderActor(firstNode);
	await firstNode.client.request("tools.call", {
		...leader,
		name: "neta_mission",
		arguments: {
			name: "Queued resume history",
			objective: "preserve the interrupted writer",
			access: "readWrite",
			lead: "self",
			agents: [
				{ task: "original holder", access: "readWrite" },
				{ task: "next holder", access: "readWrite" },
			],
		},
	});
	const before = await firstNode.client.request<{ agents: Agent[] }>("snapshot", {});
	const original = before.agents.find((agent) => agent.task === "original holder");
	const next = before.agents.find((agent) => agent.task === "next holder");
	if (original === undefined || next === undefined) throw new Error("expected writers");
	const waitForTerminalTurnContaining = async (
		label: string,
		attached: Awaited<ReturnType<typeof attach>>,
		sessionId: string,
		text: string,
	): Promise<ConversationTailResult> =>
		waitFor(label, async () => {
			const page = await attached.client.request<ConversationTailResult>("conversation.tail", {
				sessionId,
				limit: 100,
			});
			const block = page.blocks.find((one) => one.role === "user" && one.text.includes(text));
			if (block === undefined) return undefined;
			return page.turns.find((turn) => turn.id === block.turnId)?.endedAt !== undefined ? page : undefined;
		});
	// The Agent record is visible before its initial context prompt closes.
	// Addressing it as soon as the mission call returns races that first turn.
	await waitForTerminalTurnContaining(
		"original writer initial brief boundary",
		firstNode,
		original.sessionId,
		"original holder",
	);
	await firstNode.client.request("conversation.prompt", {
		sessionId: original.sessionId,
		text: "UNIQUE_PRE_RESTART_HISTORY",
	});
	await waitFor("original history", () =>
		firstNode.turns.find(
			(turn) => turn.sessionId === original.sessionId && turn.block?.text?.includes("UNIQUE_PRE_RESTART_HISTORY"),
		),
	);
	await firstNode.client.close();
	await node.stop();

	node = await startNode();
	const secondNode = await attach();
	try {
		const nextLeader = await leaderActor(secondNode);
		await secondNode.client.request("tools.call", {
			...nextLeader,
			name: "neta_send",
			arguments: { agentId: next.id, text: "take writer first" },
		});
		const queued = await secondNode.client.request<{ isError: boolean }>("tools.call", {
			...nextLeader,
			name: "neta_send",
			arguments: { agentId: original.id, text: "resume after next" },
		});
		expect(queued.isError).toBe(true);
		const beforePromotion = await secondNode.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: original.sessionId,
			limit: 100,
		});
		const priorTurnIds = new Set(beforePromotion.turns.map((turn) => turn.id));
		const nextActor = await agentActor(secondNode, next);
		await secondNode.client.request("tools.call", {
			...nextActor,
			name: "neta_done",
			arguments: { outcome: "release to interrupted writer" },
		});
		await waitFor("interrupted writer promotion", () =>
			secondNode.states.find(
				(state) =>
					state.kind === "agent" &&
					(state.record as Agent).id === original.id &&
					(state.record as Agent).state === "starting",
			),
		);
		// Promotion first resumes the provider and sends its context brief. The
		// `starting` state is deliberately published before that turn so the UI
		// can show the transition; it is not a promise that the prompt boundary
		// has closed. Wait for the persisted terminal turn before addressing the
		// same conversation directly, otherwise this test races the brief and
		// intermittently gets the truthful TURN_IN_PROGRESS response.
		await waitFor("promoted writer continuation boundary", async () => {
			const page = await secondNode.client.request<ConversationTailResult>("conversation.tail", {
				sessionId: original.sessionId,
				limit: 100,
			});
			const promoted = page.turns.find((turn) => !priorTurnIds.has(turn.id));
			return promoted?.endedAt === undefined ? undefined : page;
		});
		await secondNode.client.request("conversation.prompt", { sessionId: original.sessionId, text: "HISTORY" });
		await waitFor("resumed provider history", () =>
			secondNode.turns.find(
				(turn) => turn.sessionId === original.sessionId && turn.block?.text?.includes("UNIQUE_PRE_RESTART_HISTORY"),
			),
		);
	} finally {
		await secondNode.client.close();
	}
}, 90000);

test("concurrent agent additions preserve both ids and admit one real writer", async () => {
	node = await startNode();
	const at = await attach();
	try {
		const leader = await leaderActor(at);
		const made = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			...leader,
			name: "neta_mission",
			arguments: { name: "Concurrent additions", objective: "keep both", access: "readWrite", lead: "self" },
		});
		const mission = JSON.parse(made.content[0]?.text.split("\n")[0] ?? "{}") as { id: string };
		await Promise.all(
			["writer one", "writer two"].map((task) =>
				at.client.request("tools.call", {
					...leader,
					name: "neta_agent",
					arguments: { missionId: mission.id, task, access: "readWrite" },
				}),
			),
		);
		const snapshot = await at.client.request<{
			missions: Array<{ id: string; agentIds: string[] }>;
			agents: Agent[];
		}>("snapshot", {});
		const agents = snapshot.agents.filter((agent) => agent.missionId === mission.id);
		expect(agents).toHaveLength(2);
		expect(snapshot.missions.find((one) => one.id === mission.id)?.agentIds).toHaveLength(2);
		expect(agents.filter((agent) => agent.state === "starting")).toHaveLength(1);
		expect(agents.filter((agent) => agent.state === "queued")).toHaveLength(1);
	} finally {
		await at.client.close();
	}
}, 90000);

test("a completed writer is closed at its turn boundary before promotion", async () => {
	node = await startNode();
	const at = await attach();
	try {
		const leader = await leaderActor(at);
		await at.client.request("tools.call", {
			...leader,
			name: "neta_mission",
			arguments: {
				name: "Turn boundary",
				objective: "no overlap",
				access: "readWrite",
				lead: "self",
				agents: [
					{ task: "holding writer", access: "readWrite" },
					{ task: "waiting writer", access: "readWrite" },
				],
			},
		});
		const before = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		const holder = before.agents.find((agent) => agent.task === "holding writer");
		const waiting = before.agents.find((agent) => agent.task === "waiting writer");
		if (holder === undefined || waiting === undefined) throw new Error("expected writers");
		const actor = await agentActor(at, holder);
		await at.client.request("conversation.prompt", { sessionId: holder.sessionId, text: "HOLD_FOREVER" });
		await waitFor("held turn", () =>
			at.turns.find((turn) => turn.sessionId === holder.sessionId && turn.turn?.endedAt === undefined),
		);
		await at.client.request("tools.call", { ...actor, name: "neta_done", arguments: { outcome: "done after turn" } });
		await expect(
			at.client.request("conversation.tail", { sessionId: waiting.sessionId, limit: 20 }),
		).rejects.toThrow();
		await at.client.request("conversation.cancel", { sessionId: holder.sessionId });
		await waitFor("promotion after cancellation boundary", () =>
			at.states.find(
				(state) =>
					state.kind === "agent" &&
					(state.record as Agent).id === waiting.id &&
					(state.record as Agent).state === "starting",
			),
		);
		const promoted = await at.client.request<ConversationTailResult>("conversation.tail", {
			sessionId: waiting.sessionId,
			limit: 20,
		});
		expect(promoted.blocks.length).toBeGreaterThan(0);
	} finally {
		await at.client.close();
	}
}, 90000);

test("the tools answer on the socket and neta_mission creates a mission", async () => {
	node = await startNode();
	const at = await attach();
	try {
		// The actor token is minted at session launch and handed to the
		// session's MCP proxy; the fake agent echoes the config it was given.
		const { actorId, token } = await leaderActor(at);
		expect(actorId).toBe(at.leader.sessionId);
		expect(token).toMatch(/^[0-9a-f]{64}$/);

		const listed = await at.client.request<{ tools: Array<{ name: string }> }>("tools.list", { actorId, token });
		expect(listed.tools.map((tool) => tool.name)).toContain("neta_mission");

		// A bad token reaches no handler.
		await expect(at.client.request("tools.list", { actorId, token: "0".repeat(64) })).rejects.toThrow();

		const called = await at.client.request<{ content: Array<{ text: string }>; isError: boolean }>("tools.call", {
			actorId,
			token,
			name: "neta_mission",
			arguments: { name: "Fix the widget", objective: "Make it work", access: "readOnly", lead: "self" },
		});
		expect(called.isError).toBe(false);
		const created = JSON.parse(called.content[0]?.text.split("\n")[0] ?? "{}") as { number: number; id: string };
		expect(created.number).toBe(1);

		// It is on the spine's side of the wire too: in the snapshot, and
		// announced as one `state` notification.
		const snapshot = await at.client.request<{ missions: Array<{ id: string; name: string }> }>("snapshot", {});
		expect(snapshot.missions.map((m) => m.name)).toContain("Fix the widget");
		expect(at.states.some((s) => s.kind === "mission" && (s.record as { id: string }).id === created.id)).toBe(true);
	} finally {
		await at.client.close();
	}
}, 90000);

test("the fake ACP creates a mission through the injected MCP stdio proxy", async () => {
	const control = await shortTempDir("neta-mcp-e2e-");
	process.env.NETA_BIN = MCP_RUNNER;
	await writeMissionE2ESettings(control);
	node = await startNode();
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
				return JSON.parse(raw) as { stage?: string; missionId?: string; error?: string };
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
		const blocked = await waitFor("the MCP-created blocked agent", async () => {
			const raw = await Bun.file(join(control, "state.json")).text();
			const current = JSON.parse(raw) as { stage?: string; missionId?: string; agentId?: string; error?: string };
			if (current.error !== undefined) throw new Error(current.error);
			if (current.stage !== "blocked" || current.agentId === undefined) return undefined;
			const snapshot = await at.client.request<{ agents: Array<{ id: string; state: string }> }>("snapshot", {});
			return current.agentId === lead?.id &&
				snapshot.agents.find((agent) => agent.id === current.agentId)?.state === "blocked"
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
			return snapshot.agents.find((agent) => agent.id === blocked.agentId)?.state === "completed" ? true : undefined;
		});
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "MCP_E2E_READY" });
		await waitFor("the MCP-ready mission", async () => {
			const snapshot = await at.client.request<{ missions: Array<{ id: string; state: string }> }>("snapshot", {});
			return snapshot.missions.find((mission) => mission.id === blocked.missionId)?.state === "readyToClose"
				? true
				: undefined;
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

test("the charter's reservations gate neta_mode", async () => {
	await writeFile(join(work, "CHARTER.md"), "# Charter\n\n## Reserved for the user\n\n- database migrations\n");
	node = await startNode();
	const at = await attach();
	try {
		const { actorId, token } = await leaderActor(at);
		const created = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			actorId,
			token,
			name: "neta_mission",
			arguments: { name: "Move the schema", objective: "Ship the new tables", access: "readWrite", lead: "self" },
		});
		const mission = JSON.parse(created.content[0]?.text.split("\n")[0] ?? "{}") as { id: string };

		const record = {
			objective: "Rewrite the migration",
			whyLeadInsufficient: "the agents cannot see the schema",
			missionId: mission.id,
			mutationKind: "database migrations",
			estimatedFiles: 3,
			validation: "bun test",
			estimatedMinutes: 20,
			externalEffects: "none",
		};
		const asked = await at.client.request<{ content: Array<{ text: string }>; isError: boolean }>("tools.call", {
			actorId,
			token,
			name: "neta_mode",
			arguments: { mode: "leadPlus", record },
		});
		const answer = JSON.parse(asked.content[0]?.text.split("\n")[0] ?? "{}") as {
			approved: boolean;
			reason?: string;
		};
		expect(answer.approved).toBe(false);
		expect(answer.reason).toBe("reservedByCharter");

		// And the leader is still lead: a denial writes nothing.
		const snapshot = await at.client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(snapshot.leaders.find((one) => one.sessionId === actorId)?.mode).toBe("lead");
	} finally {
		await at.client.close();
	}
}, 90000);

test("neta_mode moves the leader to leadPlus and back", async () => {
	await writeSettings(join(dir, "mode-sessions.json"));
	node = await startNode();
	const at = await attach();
	try {
		const { actorId, token } = await leaderActor(at);
		const created = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			actorId,
			token,
			name: "neta_mission",
			arguments: { name: "Rework the loader", objective: "Make it fast", access: "readWrite", lead: "self" },
		});
		const mission = JSON.parse(created.content[0]?.text.split("\n")[0] ?? "{}") as { id: string };
		const record = {
			objective: "Rewrite the loader",
			whyLeadInsufficient: "the agents cannot see the schema",
			missionId: mission.id,
			mutationKind: "source edits",
			estimatedFiles: 3,
			validation: "bun test",
			estimatedMinutes: 20,
			externalEffects: "none",
		};
		const mode = async (args: Record<string, unknown>): Promise<{ approved: boolean }> => {
			const answered = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
				actorId,
				token,
				name: "neta_mode",
				arguments: args,
			});
			return JSON.parse(answered.content[0]?.text.split("\n")[0] ?? "{}") as { approved: boolean };
		};
		const leaderNow = async (): Promise<Leader | undefined> => {
			const snapshot = await at.client.request<{ leaders: Leader[] }>("snapshot", {});
			return snapshot.leaders.find((one) => one.workspaceId === at.leader.workspaceId);
		};

		expect((await mode({ mode: "leadPlus", record })).approved).toBe(true);
		await waitFor("Lead++ to apply after the tool turn", () =>
			at.states.some((state) => state.kind === "leader" && (state.record as Leader).mode === "leadPlus")
				? true
				: undefined,
		);

		// The way back is a real write, not a bare `approved: true`: Lead++
		// outlives a restart, so a leader that cannot return stays in build
		// access until a person flips it.
		await at.client.request("leader.setMode", { workspaceId: at.leader.workspaceId, mode: "lead" });
		const back = await leaderNow();
		expect(back?.mode).toBe("lead");
		expect(
			at.states.filter((s) => s.kind === "leader" && (s.record as Leader).mode === "lead").length,
		).toBeGreaterThan(0);
	} finally {
		await at.client.close();
	}
}, 90000);

test("Lead++ waits for a normal turn boundary before relaunching writable", async () => {
	const barrier = join(dir, "mode-barrier");
	const ready = join(dir, "mode-ready");
	await writeBarrierSettings(join(dir, "mode-barrier-sessions.json"), barrier, ready);
	node = await startNode();
	const at = await attach();
	try {
		const actor = await leaderActor(at);
		const created = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "neta_mission",
			arguments: { name: "Deferred mode", objective: "switch safely", access: "readWrite", lead: "self" },
		});
		const mission = JSON.parse(created.content[0]?.text.split("\n")[0] ?? "{}") as { id: string };
		await at.client.request("conversation.prompt", {
			sessionId: at.leader.sessionId,
			text: "WAIT_FOR_BARRIER",
		});
		await waitFor("provider barrier", async () => ((await Bun.file(ready).exists()) ? true : undefined));
		const answer = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "neta_mode",
			arguments: {
				mode: "leadPlus",
				record: {
					objective: "perform the bounded edit",
					whyLeadInsufficient: "the leader must make the final edit",
					missionId: mission.id,
					mutationKind: "source edits",
					estimatedFiles: 1,
					validation: "bun test",
					estimatedMinutes: 5,
					externalEffects: "none",
				},
			},
		});
		expect(JSON.parse(answer.content[0]?.text.split("\n")[0] ?? "{}").approved).toBe(true);
		let snapshot = await at.client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(snapshot.leaders[0]?.mode).toBe("lead");
		await writeFile(barrier, "go\n");
		await waitFor("deferred Lead++", () =>
			at.states.some((state) => state.kind === "leader" && (state.record as Leader).mode === "leadPlus")
				? true
				: undefined,
		);
		snapshot = await at.client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(snapshot.leaders[0]?.mode).toBe("leadPlus");
	} finally {
		await at.client.close();
	}
}, 90000);

test("cancelling a turn invalidates its pending Lead++ grant and frees the writer", async () => {
	await writeSettings(join(dir, "mode-cancel-sessions.json"));
	node = await startNode();
	const at = await attach();
	try {
		const actor = await leaderActor(at);
		const created = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "neta_mission",
			arguments: { name: "Cancelled mode", objective: "remain read only", access: "readWrite", lead: "self" },
		});
		const mission = JSON.parse(created.content[0]?.text.split("\n")[0] ?? "{}") as { id: string };
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "HOLD_FOREVER" });
		await waitFor("held leader turn", () =>
			at.turns.find((turn) => turn.sessionId === at.leader.sessionId && turn.turn?.endedAt === undefined),
		);
		await at.client.request("tools.call", {
			...actor,
			name: "neta_mode",
			arguments: {
				mode: "leadPlus",
				record: {
					objective: "perform the bounded edit",
					whyLeadInsufficient: "the leader must make the final edit",
					missionId: mission.id,
					mutationKind: "source edits",
					estimatedFiles: 1,
					validation: "bun test",
					estimatedMinutes: 5,
					externalEffects: "none",
				},
			},
		});
		await at.client.request("conversation.cancel", { sessionId: at.leader.sessionId });
		await waitFor("cancelled leader turn", () =>
			at.turns.find(
				(turn) => turn.sessionId === at.leader.sessionId && turn.turn?.endedAt !== undefined && turn.turn.cancelled,
			),
		);
		await at.client.request("tools.call", {
			...actor,
			name: "neta_agent",
			arguments: { missionId: mission.id, task: "writer after cancellation", access: "readWrite" },
		});
		await waitFor("writer after cancelled mode", async () => {
			const snapshot = await at.client.request<{ leaders: Leader[]; agents: Agent[] }>("snapshot", {});
			return snapshot.leaders[0]?.mode === "lead" &&
				snapshot.agents.find((agent) => agent.task === "writer after cancellation")?.state === "starting"
				? true
				: undefined;
		});
	} finally {
		await at.client.close();
	}
}, 90000);

test("closing a self-led Lead++ mission downgrades it before promoting another mission", async () => {
	await writeSettings(join(dir, "mode-close-sessions.json"));
	node = await startNode();
	const at = await attach();
	try {
		const actor = await leaderActor(at);
		const first = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "neta_mission",
			arguments: { name: "Leader writer", objective: "close safely", access: "readWrite", lead: "self" },
		});
		const mission = JSON.parse(first.content[0]?.text.split("\n")[0] ?? "{}") as { id: string };
		await at.client.request("leader.setMode", { workspaceId: at.leader.workspaceId, mode: "leadPlus" });
		at.turns.length = 0;
		const writableActor = await leaderActor(at);
		await at.client.request("tools.call", {
			...writableActor,
			name: "neta_mission",
			arguments: {
				name: "Waiting mission",
				objective: "start after close",
				access: "readWrite",
				lead: "self",
				agents: [{ task: "successor writer", access: "readWrite" }],
			},
		});
		let snapshot = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(snapshot.agents.find((agent) => agent.task === "successor writer")?.state).toBe("queued");
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "HOLD_FOREVER" });
		await waitFor("active Lead++ close turn", () =>
			at.turns.find((turn) => turn.sessionId === at.leader.sessionId && turn.turn?.endedAt === undefined),
		);
		const closed = await at.client.request<{ isError: boolean }>("tools.call", {
			...writableActor,
			name: "neta_close",
			arguments: { missionId: mission.id, disposition: "abandoned", reason: "test complete" },
		});
		expect(closed.isError).toBe(true);
		snapshot = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(snapshot.agents.find((agent) => agent.task === "successor writer")?.state).toBe("queued");
		await at.client.request("conversation.cancel", { sessionId: at.leader.sessionId });
		await waitFor("successor after Lead++ close", () =>
			at.states.find(
				(state) =>
					state.kind === "agent" &&
					(state.record as Agent).task === "successor writer" &&
					(state.record as Agent).state === "starting",
			),
		);
		snapshot = await at.client.request<{ agents: Agent[] }>("snapshot", {});
		expect(snapshot.agents.find((agent) => agent.task === "successor writer")?.state).toBe("starting");
		const reopened = await at.client.request<{ leader: Leader }>("workspace.open", { path: work });
		expect(reopened.leader.mode).toBe("lead");
	} finally {
		await at.client.close();
	}
}, 90000);

test("a refused Lead++ close returns and persists its real closeout outcome", async () => {
	await makeGitWorkspace();
	const sessionStore = join(dir, "mode-refused-close-sessions.json");
	await writeCwdResumeSettings(sessionStore);
	node = await startNode();
	const at = await attach();
	try {
		let actor = await leaderActor(at);
		const created = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "neta_mission",
			arguments: { name: "Refused close", objective: "remain open", access: "readWrite", lead: "self" },
		});
		const mission = JSON.parse(created.content[0]?.text.split("\n")[0] ?? "{}") as { id: string };
		await at.client.request("leader.setMode", { workspaceId: at.leader.workspaceId, mode: "leadPlus" });
		at.turns.length = 0;
		actor = await leaderActor(at);
		const refused = await at.client.request<{ isError: boolean; content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "neta_close",
			arguments: { missionId: mission.id, disposition: "merged", reason: "done", evidence: "deadbeef" },
		});
		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toContain("not merged");
		let snapshot = await at.client.request<{ missions: Array<{ id: string; state: string; attention?: string }> }>(
			"snapshot",
			{},
		);
		expect(snapshot.missions.find((one) => one.id === mission.id)?.state).not.toBe("closed");
		expect(snapshot.missions.find((one) => one.id === mission.id)?.attention).toContain("not merged");

		await at.client.request("leader.setMode", { workspaceId: at.leader.workspaceId, mode: "leadPlus" });
		at.turns.length = 0;
		actor = await leaderActor(at);
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "HOLD_FOREVER" });
		await waitFor("active refused close turn", () =>
			at.turns.find((turn) => turn.sessionId === at.leader.sessionId && turn.turn?.endedAt === undefined),
		);
		await at.client.request("tools.call", {
			...actor,
			name: "neta_close",
			arguments: { missionId: mission.id, disposition: "merged", reason: "done", evidence: "cafebabe" },
		});
		await at.client.request("conversation.cancel", { sessionId: at.leader.sessionId });
		await waitFor("deferred refused close attention", async () => {
			snapshot = await at.client.request("snapshot", {});
			return snapshot.missions.find((one) => one.id === mission.id)?.attention?.includes("cafebabe")
				? true
				: undefined;
		});
		expect(snapshot.missions.find((one) => one.id === mission.id)?.state).not.toBe("closed");
	} finally {
		await at.client.close();
	}
}, 90000);

test("a skill in the workspace root is found, whatever the node's cwd is", async () => {
	await mkdir(join(work, ".neta", "skills"), { recursive: true });
	await writeFile(join(work, ".neta", "skills", "repo-only.md"), "# Repo only\n\nUse the repo's own tools.\n");
	node = await startNode();
	const at = await attach();
	try {
		const { actorId, token } = await leaderActor(at);
		const called = await at.client.request<{ content: Array<{ text: string }>; isError: boolean }>("tools.call", {
			actorId,
			token,
			name: "neta_mission",
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
			name: "neta_mission",
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

// Lead and Lead++ still change Neta's mutation authority, but both leadership
// modes keep the provider unrestricted. The ACP unit test proves the access
// value changes across the relaunch; this runtime test proves the durable mode
// transition keeps the same conversation and never re-sandboxes its leader.
test("a mode change keeps the leader provider unrestricted", async () => {
	await writeSettings(join(dir, "fake-sessions.json"));
	node = await startNode();
	const at = await attach();
	try {
		const actor = await leaderActor(at);
		await at.client.request("tools.call", {
			...actor,
			name: "neta_mission",
			arguments: { name: "Writable mode", objective: "Test access", access: "readWrite", lead: "self" },
		});
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "EDIT" });
		await waitFor("the Lead permission answer", () => at.turns.find((n) => n.block?.text === "permission=allow"));
		const allowsBefore = at.turns.filter((notification) => notification.block?.text === "permission=allow").length;

		await at.client.request("leader.setMode", { workspaceId: at.leader.workspaceId, mode: "leadPlus" });
		const reopened = await at.client.request<{ leader: Leader }>("workspace.open", { path: work });
		expect(reopened.leader.mode).toBe("leadPlus");
		// Relaunched in place: the person keeps the conversation they are
		// looking at.
		expect(reopened.leader.sessionId).toBe(at.leader.sessionId);

		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "EDIT again" });
		await waitFor("the Lead++ permission answer", () => {
			const allows = at.turns.filter((notification) => notification.block?.text === "permission=allow");
			return allows.length > allowsBefore ? allows.at(-1) : undefined;
		});
	} finally {
		await at.client.close();
	}
}, 90000);

test("workspace open reacquires a durable Lead++ mission before reviving writable", async () => {
	await writeSettings(join(dir, "mode-restart-sessions.json"));
	node = await startNode();
	const first = await attach();
	const actor = await leaderActor(first);
	await first.client.request("tools.call", {
		...actor,
		name: "neta_mission",
		arguments: { name: "Restarted Lead++", objective: "recover safely", access: "readWrite", lead: "self" },
	});
	await first.client.request("leader.setMode", { workspaceId: first.leader.workspaceId, mode: "leadPlus" });
	const sessionId = first.leader.sessionId;
	await first.client.close();
	await node.stop();

	node = await startNode();
	const second = await attach();
	try {
		expect(second.leader.mode).toBe("leadPlus");
		expect(second.leader.sessionId).toBe(sessionId);
		await second.client.request("conversation.prompt", { sessionId, text: "EDIT after restart" });
		await waitFor("restored Lead++ access", () =>
			second.turns.find((turn) => turn.sessionId === sessionId && turn.block?.text === "permission=allow"),
		);
	} finally {
		await second.client.close();
	}
}, 90000);

test("provider switching keeps the Neta session, owner, tools, and a one-shot visible handoff", async () => {
	const sessionStore = join(dir, "provider-switch-sessions.json");
	await writeTwoProviderSettings(sessionStore);
	node = await startNode();
	const at = await attach();
	try {
		const actor = await leaderActor(at);
		const created = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			...actor,
			name: "neta_mission",
			arguments: { name: "Provider handoff", objective: "keep the context", access: "readOnly", lead: "self" },
		});
		const mission = JSON.parse(created.content[0]?.text.split("\n")[0] ?? "{}") as { id: string };
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "USER_CONTEXT_MARKER" });
		await waitFor("context marker", () =>
			at.turns.find(
				(turn) => turn.sessionId === at.leader.sessionId && turn.block?.text?.includes("USER_CONTEXT_MARKER"),
			),
		);
		const providers = await at.client.request<{
			providers: Array<{ id: string; label: string; defaultModel: string; available: boolean }>;
		}>("providers.list", {});
		expect(providers.providers.map((provider) => provider.id)).toContain("fake");
		expect(providers.providers.map((provider) => provider.id)).toContain("alternate");
		expect(providers.providers.every((provider) => provider.available)).toBe(true);
		const unopenedModels = await at.client.request<{ models: Array<{ id: string; name: string; provider: string }> }>(
			"models.list",
			{ provider: "alternate" },
		);
		expect(unopenedModels.models).toEqual([{ id: "test-model", name: "test-model", provider: "alternate" }]);
		const prepared = await at.client.request<{ markdown: string }>("conversation.prepareHandoff", {
			sessionId: at.leader.sessionId,
		});
		expect(prepared.markdown).toContain(mission.id);
		expect(prepared.markdown).toContain("USER_CONTEXT_MARKER");
		const switched = await at.client.request<{
			sessionId: string;
			provider: string;
			model: string;
			contextReset: boolean;
		}>("conversation.setProvider", { sessionId: at.leader.sessionId, provider: "alternate" });
		expect(switched).toEqual({
			sessionId: at.leader.sessionId,
			provider: "alternate",
			model: "test-model",
			contextReset: true,
		});
		at.turns.length = 0;
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "FIRST_AFTER_SWITCH" });
		await waitFor("first switched turn", () =>
			at.turns.find((turn) => turn.sessionId === at.leader.sessionId && turn.turn?.endedAt !== undefined),
		);
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "HISTORY" });
		const history = await waitFor(
			"switched provider history",
			() =>
				at.turns.find(
					(turn) =>
						turn.sessionId === at.leader.sessionId && turn.block?.text?.includes("# Neta provider handoff"),
				)?.block?.text,
		);
		expect(history.match(/# Neta provider handoff/g)).toHaveLength(1);
		const ownerSnapshot = await at.client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(ownerSnapshot.leaders[0]?.provider).toBe("alternate");
		at.turns.length = 0;
		const switchedActor = await leaderActor(at);
		expect(switchedActor.actorId).toBe(at.leader.sessionId);
		const historyCall = await at.client.request<{ content: Array<{ text: string }> }>("tools.call", {
			...switchedActor,
			name: "neta_history",
			arguments: { limit: 50 },
		});
		const historyPage = JSON.parse(historyCall.content[0]?.text.split("\n")[0] ?? "{}") as {
			messages: Array<{ role: string; text: string }>;
		};
		expect(historyPage.messages.some((message) => message.text.includes("USER_CONTEXT_MARKER"))).toBe(true);
		expect(historyPage.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(
			true,
		);

		await at.client.request("conversation.setModel", { sessionId: at.leader.sessionId, model: "legacy-other" });
		let snapshot = await at.client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(snapshot.leaders[0]?.model).toBe("legacy-other");
		await expect(
			at.client.request("conversation.setProvider", { sessionId: at.leader.sessionId, provider: "missing" }),
		).rejects.toThrow();
		at.turns.length = 0;
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "ROLLBACK_OK" });
		await waitFor("old provider after failed switch", () =>
			at.turns.find((turn) => turn.sessionId === at.leader.sessionId && turn.block?.text?.includes("ROLLBACK_OK")),
		);
		await waitFor("rollback turn end", () =>
			at.turns.find((turn) => turn.sessionId === at.leader.sessionId && turn.turn?.endedAt !== undefined),
		);
		snapshot = await at.client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(snapshot.leaders[0]?.provider).toBe("alternate");

		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "HOLD_FOREVER" });
		await waitFor("active provider switch turn", () =>
			at.turns.find((turn) => turn.sessionId === at.leader.sessionId && turn.turn?.endedAt === undefined),
		);
		await expect(
			at.client.request("conversation.setProvider", { sessionId: at.leader.sessionId, provider: "fake" }),
		).rejects.toThrow();
		await at.client.request("conversation.cancel", { sessionId: at.leader.sessionId });
	} finally {
		await at.client.close();
	}
}, 90000);

test("a provider handoff survives restart until the next accepted prompt", async () => {
	const sessionStore = join(dir, "provider-handoff-restart.json");
	await writeTwoProviderSettings(sessionStore);
	node = await startNode();
	const first = await attach();
	await first.client.request("conversation.setProvider", {
		sessionId: first.leader.sessionId,
		provider: "alternate",
		handoff: "# Edited handoff\n\nHANDOFF_RESTART_MARKER",
	});
	const sessionId = first.leader.sessionId;
	await first.client.close();
	await node.stop();

	node = await startNode();
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

test("a provider that cannot assume writable access restores the original live provider", async () => {
	const sessionStore = join(dir, "provider-switch-rollback.json");
	await writeRejectingAlternateSettings(sessionStore);
	node = await startNode();
	const at = await attach();
	try {
		const actor = await leaderActor(at);
		await at.client.request("tools.call", {
			...actor,
			name: "neta_mission",
			arguments: {
				name: "Writable provider rollback",
				objective: "preserve the original provider",
				access: "readWrite",
				lead: "self",
			},
		});
		await at.client.request("leader.setMode", {
			workspaceId: at.leader.workspaceId,
			mode: "leadPlus",
		});
		await expect(
			at.client.request("conversation.setProvider", {
				sessionId: at.leader.sessionId,
				provider: "alternate",
				handoff: "ROLLBACK_HANDOFF_MUST_NOT_APPLY",
			}),
		).rejects.toThrow(/restored fake/);
		const snapshot = await at.client.request<{ leaders: Leader[] }>("snapshot", {});
		expect(snapshot.leaders[0]?.provider).toBe("fake");
		at.turns.length = 0;
		await at.client.request("conversation.prompt", {
			sessionId: at.leader.sessionId,
			text: "ORIGINAL_PROVIDER_USABLE",
		});
		await waitFor("restored provider turn", () =>
			at.turns.find((turn) => turn.sessionId === at.leader.sessionId && turn.turn?.endedAt !== undefined),
		);
	} finally {
		await at.client.close();
	}
}, 90000);
