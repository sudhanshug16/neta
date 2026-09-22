import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Mission } from "../src/core/types.ts";
import { createFollowupSender } from "../src/node/followup.ts";
import { openConversationInboxStore } from "../src/store/conversation-inbox.ts";

const original = process.env.NETA_DIR;
let dir: string;
afterEach(async () => {
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
	if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture(state: Agent["state"]) {
	dir = await mkdtemp(join(tmpdir(), "neta-followup-"));
	process.env.NETA_DIR = dir;
	const inbox = openConversationInboxStore();
	let agent: Agent = {
		id: "a",
		workspaceId: "w",
		missionId: "m",
		sessionId: "s",
		name: "Worker",
		task: "task",
		access: "readWrite",
		provider: "fake",
		model: "fake",
		skills: [],
		canSpawn: false,
		state,
		startedAt: new Date(0).toISOString(),
	};
	let mission: Mission = {
		id: "m",
		workspaceId: "w",
		machineId: "local",
		number: 1,
		name: "Test",
		objective: "Test",
		changes: [],
		lead: { kind: "agent", agentId: "a" },
		agentIds: ["a"],
		access: "readWrite",
		state: "readyToClose",
		createdAt: new Date(0).toISOString(),
	};
	let resumes = 0;
	let failures = 0;
	let fail = false;
	const send = createFollowupSender({
		inbox,
		getAgent: () => agent,
		getMission: () => mission,
		putAgent: async (value) => {
			agent = value;
		},
		saveMission: async (value) => {
			mission = value;
		},
		resume: async () => {
			resumes++;
			expect(await inbox.list("s")).toHaveLength(1);
			if (fail) throw new Error("writer busy");
			return agent;
		},
		admit: async (id, text, sourceId) => {
			const item = await inbox.enqueue(id, text, [], { readerDirected: false, sourceId });
			if (agent.state === "running") return item;
			agent = { ...agent, state: "running" };
			return inbox.markDelivered(id, item.id, "turn");
		},
		receipt: () => {},
		failed: () => {
			failures++;
		},
	});
	return {
		inbox,
		send: (text = "follow-up", id = "followup:one") => send(agent, text, id),
		agent: () => agent,
		mission: () => mission,
		resumes: () => resumes,
		failures: () => failures,
		fail: (value: boolean) => {
			fail = value;
		},
	};
}

test("busy recipient queues simultaneous sends and retries without re-opening the session", async () => {
	const f = await fixture("running");
	const receipts = await Promise.all([f.send(), f.send(), f.send("second", "followup:two")]);
	expect(receipts[0].id).toBe(receipts[1].id);
	expect(await f.inbox.list("s")).toHaveLength(2);
	expect(f.resumes()).toBe(0);
});
test("queued writer saves a follow-up without bypassing its lease", async () => {
	const f = await fixture("queued");
	expect((await f.send()).status).toBe("queued");
	expect(f.resumes()).toBe(0);
	expect(f.agent().state).toBe("queued");
});
test.each(["completed", "blocked"] as const)(
	"%s recipient resumes once; duplicate delivery does not clear the active turn",
	async (state) => {
		const f = await fixture(state);
		const receipts = await Promise.all([f.send(), f.send()]);
		expect(receipts[0].id).toBe(receipts[1].id);
		expect(f.resumes()).toBe(1);
		expect(f.agent().state).toBe("running");
		expect(f.mission().state).toBe("running");
	},
);
test("failed admission preserves the restart-visible message and retry identity", async () => {
	const f = await fixture("interrupted");
	f.fail(true);
	const first = await f.send();
	expect(first.status).toBe("queued");
	expect(f.failures()).toBe(1);
	expect((await openConversationInboxStore().list("s"))[0].id).toBe(first.id);
	f.fail(false);
	expect((await f.send()).id).toBe(first.id);
	expect((await f.inbox.list("s"))[0].status).toBe("delivered");
});
