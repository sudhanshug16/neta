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
import type { Block, Leader, Turn, Workspace } from "../src/core/types.ts";
import { connectNode, type NodeClient } from "../src/node/client.ts";
import { type Node as NetaNode, startNode } from "../src/node/lifecycle.ts";
import type { ConversationTailResult, StateNotification, TurnNotification } from "../src/node/protocol.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;

let dir = "";
let work = "";
let savedNetadir: string | undefined;
let node: NetaNode | undefined;

// A short `NETA_DIR`: `$NETA_DIR/node.sock` must stay under the 104-byte
// unix socket limit.
async function shortTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
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

beforeEach(async () => {
	savedNetadir = process.env.NETA_DIR;
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
	await rm(dir, { recursive: true, force: true });
	await rm(work, { recursive: true, force: true });
});

async function waitFor<T>(what: string, poll: () => T | undefined, timeoutMs = 20000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = poll();
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
		expect((await leaderNow())?.mode).toBe("leadPlus");

		// The way back is a real write, not a bare `approved: true`: Lead++
		// outlives a restart, so a leader that cannot return stays in build
		// access until a person flips it.
		expect((await mode({ mode: "lead" })).approved).toBe(true);
		const back = await leaderNow();
		expect(back?.mode).toBe("lead");
		expect(
			at.states.filter((s) => s.kind === "leader" && (s.record as Leader).mode === "lead").length,
		).toBeGreaterThan(0);
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

// The leader's access is its mode: 07 says a Lead++ grant reaches the
// provider process through a relaunch, and `workspace.open` is where that
// happens. The fake agent asks for edit permission and reports the answer,
// which is `reject` at readOnly and `allow` at readWrite.
test("a mode change relaunches the leader session at the new access", async () => {
	await writeSettings(join(dir, "fake-sessions.json"));
	node = await startNode();
	const at = await attach();
	try {
		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "EDIT" });
		await waitFor("the readOnly permission answer", () =>
			at.turns.find((n) => n.block?.text === "permission=reject"),
		);

		await at.client.request("leader.setMode", { workspaceId: at.leader.workspaceId, mode: "leadPlus" });
		const reopened = await at.client.request<{ leader: Leader }>("workspace.open", { path: work });
		expect(reopened.leader.mode).toBe("leadPlus");
		// Relaunched in place: the person keeps the conversation they are
		// looking at.
		expect(reopened.leader.sessionId).toBe(at.leader.sessionId);

		await at.client.request("conversation.prompt", { sessionId: at.leader.sessionId, text: "EDIT again" });
		await waitFor("the readWrite permission answer", () =>
			at.turns.find((n) => n.block?.text === "permission=allow"),
		);
	} finally {
		await at.client.close();
	}
}, 90000);
