import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Turn, Workspace } from "../src/core/types.ts";
import { inspectArtifact, publishArtifact } from "../src/me/artifacts.ts";
import { captureMeLeaderTurn } from "../src/me/capture.ts";
import { createMeCurator, parseDecision } from "../src/me/curator.ts";
import { canDeliverNetaNotice, commitNoticeForTurn, deliverPendingNotices } from "../src/me/notice-delivery.ts";
import { type MeSource, openMeStore } from "../src/me/store.ts";
import { createWorkspaceLeaderToolBridge } from "../src/node/handlers-me.ts";
import { adaptStore } from "../src/node/lifecycle.ts";
import type { NodeContext } from "../src/node/server.ts";
import { openConversationInboxStore } from "../src/store/conversation-inbox.ts";
import { openStore } from "../src/store/index.ts";
import { paths } from "../src/store/paths.ts";
import { toolsFor } from "../src/tools/schemas.ts";

const dirs: string[] = [];
const original = process.env.NETA_DIR;
afterEach(async () => {
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "neta-filter-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const store = openMeStore();
	await store.cutoverAt();
	return { store, dir };
}
function source(n = 1): MeSource {
	return {
		id: "",
		workspaceId: "w",
		machineId: "m",
		workspaceName: "Workspace",
		sessionId: "leader",
		actorKind: "leader",
		kind: "message",
		at: new Date().toISOString(),
		turnId: `turn-${n}`,
		text: "Which option should we use?",
	};
}
const workspace: Workspace = {
	id: "w",
	name: "Workspace",
	kind: "folder",
	roots: [{ machineId: "m", path: "/tmp" }],
	createdAt: new Date(0).toISOString(),
};

test("exact role catalogs and removed tools reject before any action", async () => {
	const { store } = await fixture();
	const identity = await store.workspaceLeaderIdentity("w");
	const bridge = createWorkspaceLeaderToolBridge({
		actorId: identity.sessionId,
		workspaceId: "w",
		context: () => {
			throw new Error("must not access runtime");
		},
	});
	expect(bridge.tools.map((t) => t.name).sort()).toEqual(["artifacts", "mission", "missions", "send_message"]);
	expect(
		toolsFor("leader")
			.map((t) => t.name)
			.sort(),
	).toEqual([
		"artifacts",
		"change_model",
		"close",
		"dispatch_mission",
		"list_models",
		"mission_state",
		"send_message",
		"setup_diagnostic",
		"spawn_agent",
	]);
	expect(
		toolsFor("lead")
			.map((t) => t.name)
			.sort(),
	).toEqual(["artifacts", "change_model", "list_models", "mission_state", "send_message", "spawn_agent"]);
	expect(
		toolsFor("agent")
			.map((t) => t.name)
			.sort(),
	).toEqual(["artifacts", "change_model"]);
	for (const name of [
		"superleader_missions",
		"superleader_mission",
		"superleader_feed",
		"superleader_detail",
		"superleader_attention",
		"superleader_evidence",
		"superleader_user_turns",
		"superleader_route",
		"superleader_ask",
		"superleader_questions",
		"neta_mission",
		"neta_agent",
		"neta_send",
		"neta_scope",
		"neta_ready",
		"neta_close",
		"neta_mode",
		"neta_pin",
		"neta_status",
		"neta_models",
		"neta_setup_diagnostic",
		"neta_artifacts",
		"neta_model",
		"neta_history",
		"neta_ask",
		"neta_superleader_answer",
		"neta_progress",
		"neta_done",
	])
		await expect(bridge.call(name, {})).rejects.toThrow("Unknown workspace leader tool");
	await expect(bridge.call("send_message", { text: "go", agentId: "worker" })).rejects.toThrow();
});

test("filter rechecks both conversations before accepting a decision", async () => {
	const { store } = await fixture();
	await store.capture(source(20));
	let reads = 0;
	let calls = 0;
	const filter = createMeCurator({
		store,
		context: async () => {
			const version = ++reads;
			return {
				data: { coordinator: version === 1 ? "Worker says complete" : "Coordinator says blocker remains" },
				verify: async () => version > 1,
				commit: async () => {
					calls++;
				},
			};
		},
		classify: async ({ context }) => ({
			action: "send",
			reason: "Current coordinator assessment",
			text: (context as { coordinator: string }).coordinator,
		}),
	});
	await filter.drain();
	expect(reads).toBe(2);
	expect(calls).toBe(1);
	expect(await store.listPresentations("w")).toEqual([]);
	const pending = await store.pendingNotices("w");
	expect(pending[0]?.text).toBe("Coordinator says blocker remains");
});

test("filter sees only the authoritative final reply, including questions; failures stay labeled", async () => {
	const { store } = await fixture();
	const turn: Turn = {
		id: "t",
		sessionId: "leader",
		role: "user",
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		finalReply: "Which option?",
	};
	await captureMeLeaderTurn({
		store,
		workspace,
		sessionId: "leader",
		turn,
		blocks: [
			{ turnId: "t", seq: 1, at: turn.startedAt, role: "agent", kind: "text", text: "Interim commentary" },
			{ turnId: "t", seq: 2, at: turn.startedAt, role: "agent", kind: "thought", text: "Private reasoning" },
		],
	});
	expect((await store.pendingSources())[0]?.text).toBe("Which option?");
	await captureMeLeaderTurn({
		store,
		workspace,
		sessionId: "leader",
		turn: { ...turn, id: "failed", failed: true },
		blocks: [],
	});
	await captureMeLeaderTurn({
		store,
		workspace,
		sessionId: "leader",
		turn: { ...turn, id: "cancelled", cancelled: true },
		blocks: [],
	});
	expect((await store.pendingSources()).map((s) => s.text)).toEqual([
		"Which option?",
		"Coordinator turn failed.\nWhich option?",
		"Coordinator turn interrupted.\nWhich option?",
	]);
});

test("filter has full judgment to suppress direct answers, questions and failures", async () => {
	const { store } = await fixture();
	await store.capture(source());
	await store.capture({ ...source(2), kind: "failure", text: "Failed" });
	const curator = createMeCurator({
		store,
		classify: async (input) => {
			expect(input.relatedSources).toHaveLength(1);
			return { action: "suppress", reason: "User already has this information" };
		},
	});
	await curator.drain();
	expect((await store.diagnostics()).map((n) => n.state)).toEqual(["suppressed", "suppressed"]);
	expect(await store.pendingNotices()).toHaveLength(0);
});

test("a failed report keeps its own decision when a later status reply arrives", async () => {
	const { store } = await fixture();
	const report = await store.capture({ ...source(1), text: "Corrected Jev report" });
	let failOnce = true;
	const curator = createMeCurator({
		store,
		classify: async ({ source: item, relatedSources }) => {
			expect(relatedSources).toHaveLength(0);
			if (failOnce) {
				failOnce = false;
				throw new Error("invalid filter JSON");
			}
			return { action: "send", reason: "Useful reply", text: item.text };
		},
	});
	await curator.drain(20, 1);
	const status = await store.capture({ ...source(2), text: "PR work resumed" });
	await curator.drain(20, 1);
	expect(await store.getNotice(report.id)).toMatchObject({
		state: "delivery pending",
		text: "Corrected Jev report",
		sourceIds: [report.id],
	});
	expect(await store.getNotice(status.id)).toMatchObject({
		state: "delivery pending",
		text: "PR work resumed",
		sourceIds: [status.id],
	});
});

test("deferrals survive restart and classifier failures stop after three attempts", async () => {
	const { store } = await fixture();
	const saved = await store.capture(source());
	await createMeCurator({
		store,
		classify: async () => ({
			action: "defer",
			reason: "Wait for review",
			until: new Date(Date.now() + 60000).toISOString(),
		}),
	}).drain();
	expect(await openMeStore().pendingSources()).toHaveLength(0);
	expect((await store.diagnostics())[0]?.state).toBe("deferred");
	expect(await store.nextDeferredAt()).toBeGreaterThan(Date.now());
	await store.capture(source(2));
	let calls = 0;
	const curator = createMeCurator({
		store,
		classify: async () => {
			calls++;
			throw new Error("provider failed");
		},
	});
	for (let n = 0; n < 5; n++) await curator.drain();
	expect(calls).toBe(3);
	const records = await store.diagnostics();
	expect(records.find((n) => n.id !== saved.id)).toMatchObject({
		state: "failed",
		attempts: 3,
		error: "provider failed",
	});
	expect(() => parseDecision({ action: "defer", reason: "bad", until: "yesterday" })).toThrow();
});

test("durable filter delivery is retried by identity without duplicate execution, and uncertainty is visible", async () => {
	const { store } = await fixture();
	const saved = await store.capture(source());
	const neta = await store.bindWorkspaceLeaderRuntime({
		workspaceId: "w",
		machineId: "m",
		provider: "fake",
		model: "fake",
	});
	await store.decide([saved.id], { action: "send", reason: "Answer is useful", text: "The review is complete." });
	const inbox = openConversationInboxStore();
	let sends = 0;
	const runtime = {
		listInbox: inbox.list,
		send: async (
			sessionId: string,
			text: string,
			_attachments: [],
			context: { readerDirected: boolean; sourceId?: string },
		) => {
			sends++;
			return inbox.enqueue(sessionId, text, [], context);
		},
	};
	const input = { store, runtime: runtime as never, openNeta: async () => neta };
	await deliverPendingNotices(input);
	await deliverPendingNotices({ ...input, store: openMeStore() });
	expect(sends).toBe(1);
	const [entry] = await inbox.list(neta.sessionId);
	if (!entry) throw new Error("missing inbox");
	expect(await canDeliverNetaNotice(entry, store, "m")).toBe(true);
	await inbox.markDelivering(neta.sessionId, entry.id);
	await inbox.markUncertain(neta.sessionId, entry.id);
	await deliverPendingNotices(input);
	expect(sends).toBe(1);
	expect((await store.diagnostics())[0]).toMatchObject({ state: "delivery pending", uncertain: true });
	await inbox.markDelivered(neta.sessionId, entry.id, "native-turn");
	await deliverPendingNotices(input);
	expect((await store.diagnostics())[0]?.state).toBe("delivered");
	await commitNoticeForTurn({
		store,
		runtime,
		sessionId: neta.sessionId,
		blocks: [],
		turn: {
			id: "native-turn",
			sessionId: neta.sessionId,
			role: "user",
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			finalReply: "Here is the review.",
		},
	});
	expect((await store.listPresentations("w"))[0]?.presentation).toBe("Here is the review.");
	expect(await store.pendingSources()).toHaveLength(0);
});

test("cutover preserves old records and ignores their notification backlog", async () => {
	const { store, dir } = await fixture();
	const old = join(dir, "old-attention.json");
	const bytes = JSON.stringify({ inquiries: [{ answer: "old" }], missions: [{ id: "m" }], transcripts: ["saved"] });
	await writeFile(old, bytes);
	expect((await store.capture({ ...source(), at: new Date(0).toISOString() })).id).toBe("");
	expect(await store.pendingSources()).toHaveLength(0);
	expect(await readFile(old, "utf8")).toBe(bytes);
	await store.capture(source(2));
	const identity = await store.workspaceLeaderIdentity("w");
	await store.resetWorkspaceLeaderSession("w", identity.sessionId, "new-session");
	expect(await store.pendingNotices()).toHaveLength(0);
	expect(await store.pendingSources()).toHaveLength(0);
});

test("a reset during classification cannot requeue an old reply", async () => {
	const { store } = await fixture();
	const captured = await store.capture(source());
	const neta = await store.workspaceLeaderIdentity("w");
	let decide: ((value: unknown) => void) | undefined;
	let started: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const classification = createMeCurator({
		store,
		classify: () =>
			new Promise((resolve) => {
				decide = resolve;
				started?.();
			}),
	}).drain();
	await ready;
	await store.resetWorkspaceLeaderSession("w", neta.sessionId, "replacement");
	decide?.({ action: "send", reason: "Late answer", text: "This was for the old chat" });
	await classification;
	expect((await store.getNotice(captured.id))?.state).toBe("suppressed");
	expect(await store.pendingNotices()).toHaveLength(0);
	await store.recordClassifierFailure(captured.id, "Late failure");
	expect(await store.pendingSources()).toHaveLength(0);
});

test("a fresh filter chat receives initial context after either chat reset", async () => {
	const { store } = await fixture();
	const leader = await store.workspaceLeaderIdentity("w");
	const filter = await store.filterIdentity("w");
	await store.advanceContextCursors("w", { [leader.sessionId]: "leader-last", coordinator: "coordinator-last" });
	await store.resetFilterSession("w", filter.sessionId, "fresh-filter");
	expect(await store.contextCursors("w")).toEqual({});
	await store.advanceContextCursors("w", { coordinator: "later" });
	await store.resetWorkspaceLeaderSession("w", leader.sessionId, "fresh-leader");
	expect(await store.contextCursors("w")).toEqual({});
});

test("send_message adds original user wording and deduplicates retries within a native turn", async () => {
	const { store } = await fixture();
	const identity = await store.workspaceLeaderIdentity("w");
	const inbox = openConversationInboxStore();
	const request = "Investigate the error. Do not change production. Ask me before editing.";
	const user = await inbox.enqueue(identity.sessionId, request, [], { readerDirected: true });
	await inbox.markDelivering(identity.sessionId, user.id);
	await inbox.markDelivered(identity.sessionId, user.id, "user-turn");
	const leader = { sessionId: "coordinator", workspaceId: "w" };
	const context = {
		store: { getLeader: () => leader, listLeaders: () => [leader], listAgents: () => [] },
		runtime: {
			nativeAttachment: () => ({}),
			runtimeDiagnostics: async () => ({ turnId: "user-turn" }),
			listInbox: inbox.list,
			send: async (
				sessionId: string,
				text: string,
				_attachments: [],
				origin: { readerDirected: boolean; sourceId: string },
			) => inbox.enqueue(sessionId, text, [], origin),
		},
		hub: { broadcast: () => {} },
	} as unknown as NodeContext;
	const bridge = createWorkspaceLeaderToolBridge({
		actorId: identity.sessionId,
		workspaceId: "w",
		context: () => context,
	});
	await bridge.call("send_message", { text: "Please investigate" });
	await bridge.call("send_message", { text: "Please investigate" });
	const messages = await inbox.list(leader.sessionId);
	expect(messages).toHaveLength(1);
	expect(messages[0]?.text).toContain(request);
	expect(messages[0]?.text).toContain("Message from the workspace leader:");
	expect(messages[0]?.status).toBe("queued");
});

test("cutover normalizes saved records once and preserves worktree, artifact access and transcript bytes", async () => {
	const { store, dir } = await fixture();
	const real = await openStore();
	try {
		const machine = await real.machine.load();
		await real.workspaces.save({ ...workspace, roots: [{ machineId: machine.id, path: dir }] });
		await real.leaders.save({
			workspaceId: "w",
			machineId: machine.id,
			name: "Leader",
			sessionId: "leader",
			provider: "fake",
			model: "fake",
			state: "idle",
		});
		const agent: Agent = {
			id: "lead",
			missionId: "mission",
			workspaceId: "w",
			name: "Lead",
			task: "Saved task",
			access: "readWrite",
			provider: "fake",
			model: "fake",
			skills: [],
			sessionId: "saved-session",
			canSpawn: true,
			state: "idle",
			startedAt: new Date(0).toISOString(),
		};
		const worktree = join(dir, "saved-worktree");
		await mkdir(worktree);
		await writeFile(join(worktree, "work.txt"), "Uncommitted work");
		await writeFile(
			join(dir, "agents.json"),
			JSON.stringify({
				lead: { ...agent, state: "blocked", pendingQuestion: "old question", outcome: "old report" },
			}),
		);
		await mkdir(paths().missionsDir("w"), { recursive: true });
		const mission = {
			id: "mission",
			number: 1,
			workspaceId: "w",
			machineId: machine.id,
			name: "Saved work",
			objective: "Keep it",
			lead: { kind: "agent", agentId: "lead" },
			agentIds: ["lead"],
			access: "readWrite",
			state: "blocked",
			attention: "old question",
			changes: [{ description: "old scope" }],
			createdAt: new Date(0).toISOString(),
			worktree: { provider: "worktrunk", path: worktree, branch: "saved", base: "main" },
		};
		await writeFile(
			paths().registryLog("w"),
			`${JSON.stringify({ op: "create", at: mission.createdAt, mission })}\n`,
		);
		await real.conversations.appendTurn({
			id: "saved-turn",
			sessionId: agent.sessionId,
			role: "user",
			startedAt: mission.createdAt,
			endedAt: mission.createdAt,
			finalReply: "Old answer",
		});
		const transcript = await readFile(paths().conversation(agent.sessionId), "utf8");
		const actor = { workspaceId: "w", machineId: machine.id, actorId: "leader", kind: "leader" as const };
		const artifact = await publishArtifact({
			actor,
			assignedRoot: worktree,
			title: "Saved artifact",
			mimeType: "text/plain",
			text: "Retained content",
		});
		const adapted = await adaptStore(real);
		expect(adapted.getMission("mission")).toMatchObject({
			state: "open",
			worktree: mission.worktree,
			objective: "Keep it",
		});
		expect(adapted.getMission("mission")?.attention).toBeUndefined();
		expect(adapted.getAgent("lead")).toMatchObject({
			state: "idle",
			sessionId: "saved-session",
			access: "readWrite",
		});
		expect(await readFile(paths().conversation(agent.sessionId), "utf8")).toBe(transcript);
		expect(await readFile(join(worktree, "work.txt"), "utf8")).toBe("Uncommitted work");
		expect((await inspectArtifact(actor, artifact.id, { offset: 0, limit: 100 })).text).toBe("Retained content");
		expect((await inspectArtifact({ ...actor, kind: "neta", actorId: "neta" }, artifact.id)).artifact.id).toBe(
			artifact.id,
		);
		expect((await store.capture({ ...source(), at: mission.createdAt })).id).toBe("");
		expect(await store.pendingSources()).toHaveLength(0);
		const journal = await readFile(paths().registryLog("w"), "utf8");
		await adaptStore(real);
		expect(await readFile(paths().registryLog("w"), "utf8")).toBe(journal);
	} finally {
		await real.close();
	}
});
