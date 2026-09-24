import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Leader, Mission, Workspace } from "../src/core/types.ts";
import { type MeDecision, type MeSource, meSourceId, openMeStore } from "../src/me/store.ts";
import { createSuperleaderToolBridge, meHandlers } from "../src/node/handlers-me.ts";
import type { NodeContext } from "../src/node/server.ts";
import { coordinationHandlers } from "../src/tools/handlers/coordination.ts";

const original = process.env.NETA_DIR;
const dirs: string[] = [];
afterEach(async () => {
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("neta_present only declares evidence for a delivered notice in its native turn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "neta-presentation-handler-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const store = openMeStore();
	const neta = await store.solIdentity("workspace-A");
	const source = await store.capture({
		id: "",
		workspaceId: "workspace-A",
		workspaceName: "Workspace A",
		sessionId: "leader-A",
		actorKind: "leader",
		kind: "failure",
		at: new Date(0).toISOString(),
		text: "Setup failed",
		eventId: "workspace-A:1",
		explicit: true,
		destinationSessionIds: ["leader-A"],
	});
	await store.decide(source.id, {
		action: "surface",
		concernKey: "setup",
		headline: "Setup failed",
		summary: "Mission was not created",
		evidenceSourceIds: [source.id],
		needsReply: false,
		resolved: false,
		destinationSessionIds: ["leader-A"],
	});
	const notice = (await store.pendingNotices())[0];
	if (!notice) throw new Error("missing notice");
	await store.claimNotice(notice.id);
	const ctx = {
		runtime: {
			listInbox: async () => [
				{
					id: "inbox-1",
					sessionId: neta.sessionId,
					createdAt: new Date(0).toISOString(),
					text: "attention",
					attachments: [],
					status: "delivered",
					turnId: "native-1",
					sourceId: `neta-notice:${notice.id}`,
				},
			],
			runtimeDiagnostics: async () => ({ turnId: "native-1" }),
		},
	} as unknown as NodeContext;
	const bridge = createSuperleaderToolBridge({
		actorId: neta.sessionId,
		workspaceId: "workspace-A",
		context: () => ctx,
	});
	await bridge.call("neta_present", { noticeId: notice.id, sourceIds: [source.id] });
	expect(await store.getNotice(notice.id)).toMatchObject({
		status: "delivered",
		nativeTurnId: "native-1",
		declaredSourceIds: [source.id],
	});
	expect((await store.getNotice(notice.id))?.presentedAt).toBeUndefined();
	await expect(bridge.call("neta_present", { noticeId: notice.id, sourceIds: ["foreign"] })).rejects.toThrow();
});

test("Me reply requires an explicit ambiguity choice and forwards verbatim to a current workspace session once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "neta-me-handler-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const sourceDraft = {
		id: "",
		workspaceId: "workspace-A",
		workspaceName: "Payments",
		sessionId: "agent-session-A",
		actorKind: "agent" as const,
		kind: "failure" as const,
		at: "2026-09-23T10:00:00.000Z",
		text: "Deployment blocked",
		eventId: "workspace-A:7",
		explicit: true,
		destinationSessionIds: ["agent-session-A", "leader-A"],
	};
	const source: MeSource = { ...sourceDraft, id: meSourceId(sourceDraft) };
	const saved = await openMeStore().capture(source);
	const decision: MeDecision = {
		action: "surface",
		concernKey: "deployment",
		headline: "Deployment blocked",
		summary: "Select a deployment window",
		evidenceSourceIds: [saved.id],
		needsReply: true,
		resolved: false,
		destinationSessionIds: saved.destinationSessionIds,
	};
	const card = await openMeStore().decide(saved.id, decision);
	if (!card) throw new Error("card was not created");
	const delivered: Array<{ sessionId: string; text: string; sourceId?: string }> = [];
	const ctx = {
		store: {
			listLeaders: () => [{ workspaceId: "workspace-A", sessionId: "leader-A" }],
			listAgents: () => [{ workspaceId: "workspace-A", sessionId: "agent-session-A" }],
		},
		runtime: {
			send: async (sessionId: string, text: string, _attachments: never[], provenance: { sourceId?: string }) => {
				delivered.push({ sessionId, text, sourceId: provenance.sourceId });
				return {
					id: "inbox-1",
					sessionId,
					createdAt: "2026-09-23T10:01:00.000Z",
					text,
					attachments: [],
					status: "queued" as const,
				};
			},
		},
		hub: { broadcast() {} },
	} as unknown as NodeContext;
	const reply = meHandlers["me.reply"];
	await expect(
		reply(ctx, { cardId: card.id, text: " Yes\n", idempotencyKey: "reply-1" }, {} as never),
	).rejects.toThrow("choose one");
	const result = await reply(
		ctx,
		{ cardId: card.id, text: " Yes\n", idempotencyKey: "reply-1", destinationSessionId: "agent-session-A" },
		{} as never,
	);
	expect(result).toMatchObject({ status: "accepted", destinationSessionId: "agent-session-A", receipt: "inbox-1" });
	expect(delivered).toEqual([{ sessionId: "agent-session-A", text: " Yes\n", sourceId: expect.any(String) }]);
	const retried = await reply(
		ctx,
		{ cardId: card.id, text: " Yes\n", idempotencyKey: "reply-1", destinationSessionId: "agent-session-A" },
		{} as never,
	);
	expect(retried).toMatchObject({ status: "accepted", receipt: "inbox-1" });
	expect(delivered).toHaveLength(1);
});

test("Me reply rejects stale or cross-workspace destinations", async () => {
	const dir = mkdtempSync(join(tmpdir(), "neta-me-handler-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const draft = {
		id: "",
		workspaceId: "workspace-A",
		workspaceName: "Payments",
		sessionId: "leader-A",
		actorKind: "leader" as const,
		kind: "message" as const,
		at: "2026-09-23T10:00:00.000Z",
		text: "Choose a deployment window",
		turnId: "turn-1",
		explicit: true,
		destinationSessionIds: ["leader-A"],
	};
	const source = { ...draft, id: meSourceId(draft) };
	const saved = await openMeStore().capture(source);
	const card = await openMeStore().decide(saved.id, {
		action: "surface",
		concernKey: "deploy",
		headline: "Deployment",
		summary: "Choose a window",
		evidenceSourceIds: [saved.id],
		needsReply: true,
		resolved: false,
		destinationSessionIds: ["leader-A"],
	});
	if (!card) throw new Error("card was not created");
	const ctx = {
		store: { listLeaders: () => [], listAgents: () => [] },
		runtime: {
			send: async () => {
				throw new Error("must not send");
			},
		},
		hub: { broadcast() {} },
	} as unknown as NodeContext;
	await expect(
		meHandlers["me.reply"](ctx, { cardId: card.id, text: "Yes", idempotencyKey: "reply-stale" }, {} as never),
	).rejects.toThrow("no longer owned");
});

test("Sol opens a distinct persisted native session with GPT-6 Sol medium and verifies runtime selection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "neta-sol-handler-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const workspace: Workspace = {
		id: "workspace-sol",
		kind: "folder",
		name: "Sol",
		roots: [{ machineId: "machine-sol", path: dir }],
		createdAt: new Date(0).toISOString(),
	};
	const leader: Leader = {
		workspaceId: workspace.id,
		machineId: "machine-sol",
		name: "Leader",
		sessionId: "leader-session",
		provider: "opencode",
		model: "openai/gpt-6-luna-fast",
		mode: "lead",
		modeSince: new Date(0).toISOString(),
		modeActiveMs: 0,
		state: "idle",
	};
	const calls: unknown[] = [];
	let firstLaunch = true;
	let selectedModel = "openai/gpt-6-luna-fast";
	let selectedVariant = "default";
	const runtime = {
		createSession: async (options: unknown) => {
			calls.push(options);
			if (firstLaunch) {
				firstLaunch = false;
				throw new Error("fixture first launch failure");
			}
			return {
				sessionId: (options as { sessionId: string }).sessionId,
				provider: "opencode",
				model: "openai/gpt-6-sol",
			};
		},
		ensureSession: async (options: unknown) => {
			calls.push(options);
			return {
				sessionId: (options as { sessionId: string }).sessionId,
				provider: "opencode",
				model: "openai/gpt-6-sol",
			};
		},
		setModel: async (_id: string, model: string) => {
			calls.push(["model", model]);
			selectedModel = model;
			selectedVariant = "default";
		},
		setNativeVariant: async (_id: string, variant: string) => {
			calls.push(["variant", variant]);
			selectedVariant = variant;
		},
		runtimeDiagnostics: async () => ({ model: selectedModel, variant: selectedVariant }),
	};
	const ctx = {
		store: {
			machine: () => ({ id: "machine-sol" }),
			getWorkspace: (id: string) => (id === workspace.id ? workspace : undefined),
			getLeader: (id: string) => (id === leader.workspaceId ? leader : undefined),
		},
		runtime,
		hub: { broadcast() {} },
	} as unknown as NodeContext;
	await expect(meHandlers["sol.open"](ctx, { workspaceId: workspace.id }, {} as never)).rejects.toThrow(
		"fixture first launch failure",
	);
	const pendingIdentity = await openMeStore().solIdentity();
	expect(pendingIdentity.workspaceId).toBe(workspace.id);
	expect(pendingIdentity.runtimeInitialized).toBe(false);
	const [opened, concurrent] = (await Promise.all([
		meHandlers["sol.open"](ctx, { workspaceId: workspace.id }, {} as never),
		meHandlers["sol.open"](ctx, { workspaceId: workspace.id }, {} as never),
	])) as [{ sessionId: string; model: string; variant: string }, { sessionId: string }];
	expect(opened).toMatchObject({ model: "openai/gpt-6-sol", variant: "medium" });
	expect(opened.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	expect(opened.sessionId).not.toBe("sol");
	expect(concurrent.sessionId).toBe(opened.sessionId);
	expect(calls[0]).toMatchObject({
		sessionId: opened.sessionId,
		provider: "opencode",
		model: "openai/gpt-6-sol",
		netaTools: true,
	});
	expect(calls).toContainEqual(["variant", "medium"]);
	expect(calls.filter((call) => typeof call === "object" && call !== null && "netaTools" in call)).toHaveLength(2);
	const modelSwitches = calls.filter((call) => Array.isArray(call) && (call[0] === "model" || call[0] === "variant"));
	const restored = (await meHandlers["sol.open"](ctx, { workspaceId: workspace.id }, {} as never)) as {
		sessionId: string;
	};
	expect(restored.sessionId).toBe(opened.sessionId);
	expect(calls.filter((call) => Array.isArray(call) && (call[0] === "model" || call[0] === "variant"))).toEqual(
		modelSwitches,
	);
	expect(
		calls.some(
			(call) => typeof call === "object" && call !== null && "allowFresh" in call && call.allowFresh === false,
		),
	).toBe(true);
	expect(calls.filter((call) => typeof call === "object" && call !== null && "allowFresh" in call)).toHaveLength(1);
});

test("Superleader reads only its workspace and pages mission details", async () => {
	const workspaces: Workspace[] = ["Neta", "NoScrubs"].map((name, index) => ({
		id: `workspace-${index}`,
		kind: "folder",
		name,
		roots: [],
		createdAt: new Date(index * 1000).toISOString(),
	}));
	const noScrubs = workspaces[1];
	if (!noScrubs) throw new Error("NoScrubs fixture is missing");
	const missions: Mission[] = [0, 1].map((number) => ({
		id: `mission-${number}`,
		number: number + 1,
		workspaceId: noScrubs.id,
		machineId: "machine",
		name: `Mission ${number + 1}`,
		objective: `Inspect project ${number + 1}`,
		changes: [],
		lead: { kind: "agent", agentId: "jev" },
		agentIds: ["jev"],
		access: "readOnly",
		state: "running",
		createdAt: new Date(number * 1000).toISOString(),
	}));
	const latestMission = missions[1];
	if (!latestMission) throw new Error("latest mission fixture is missing");
	const agent: Agent = {
		id: "jev",
		missionId: latestMission.id,
		workspaceId: noScrubs.id,
		name: "Jev",
		task: "Review performance",
		access: "readOnly",
		provider: "opencode",
		model: "fixture",
		skills: [],
		sessionId: "jev-session",
		canSpawn: true,
		state: "completed",
		startedAt: new Date(0).toISOString(),
		outcome: "Review complete",
	};
	const ctx = {
		store: {
			listWorkspaces: () => workspaces,
			getWorkspace: (id: string) => workspaces.find((workspace) => workspace.id === id),
			getLeader: () => undefined,
			listMissions: (id?: string) => missions.filter((mission) => id === undefined || mission.workspaceId === id),
			listAgents: (id: string) => (id === agent.missionId ? [agent] : []),
		},
	} as unknown as NodeContext;
	const bridge = createSuperleaderToolBridge({ actorId: "sol", workspaceId: noScrubs.id, context: () => ctx });
	expect(bridge.tools.some((tool) => tool.name === "superleader_workspaces")).toBe(false);
	const page = await bridge.call("superleader_missions", { limit: 1 });
	expect(page.structuredContent).toMatchObject({
		workspace: { name: "NoScrubs" },
		missions: [{ name: "Mission 2", state: "readyToClose", agents: [{ name: "Jev", outcome: "Review complete" }] }],
		hasMore: true,
		nextCursor: latestMission.id,
	});
	const next = await bridge.call("superleader_missions", {
		cursor: latestMission.id,
		limit: 1,
	});
	expect(next.structuredContent).toMatchObject({ missions: [{ name: "Mission 1" }], hasMore: false });
	const jev = await bridge.call("superleader_missions", { agentName: "jev" });
	expect(jev.structuredContent).toMatchObject({
		missions: [{ name: "Mission 2", agents: [{ name: "Jev", outcome: "Review complete" }] }],
		hasMore: false,
	});
	const other = createSuperleaderToolBridge({
		actorId: "sol-other",
		workspaceId: workspaces[0]?.id ?? "",
		context: () => ctx,
	});
	expect((await other.call("superleader_missions", {})).structuredContent?.missions).toEqual([]);
});

test("Superleader reads user turn IDs on demand without exposing turns from before chat reset", async () => {
	const dir = mkdtempSync(join(tmpdir(), "neta-sol-user-turns-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const store = openMeStore();
	const identity = await store.solIdentity("workspace-A");
	await store.appendSolTurn({
		workspaceId: "workspace-A",
		idempotencyKey: "before-reset",
		author: "user",
		text: "Old instruction",
		at: "2026-09-23T00:00:00.000Z",
	});
	await store.resetSolSession("workspace-A", identity.sessionId, "fresh-sol-session");
	const current = await store.appendSolTurn({
		workspaceId: "workspace-A",
		idempotencyKey: "after-reset",
		author: "user",
		text: "Check current status",
		at: new Date(Date.now() + 1_000).toISOString(),
	});
	const bridge = createSuperleaderToolBridge({
		actorId: "fresh-sol-session",
		workspaceId: "workspace-A",
		context: () => ({}) as NodeContext,
	});
	expect((await bridge.call("superleader_user_turns", {})).structuredContent?.turns).toEqual([
		{ id: current.id, at: current.at, text: "Check current status" },
	]);
});

test("workspace Superleader questions retain a receipt and correlate only the matching leader turn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "neta-sol-inquiry-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const store = openMeStore();
	await store.solIdentity("workspace-A");
	const leader = { workspaceId: "workspace-A", sessionId: "leader-A" } as Leader;
	const delivered: Array<{ id: string; sourceId: string; turnId: string; status: "delivered" }> = [];
	const ctx = {
		store: { getLeader: (id: string) => (id === "workspace-A" ? leader : undefined) },
		runtime: {
			send: async (_sessionId: string, _text: string, _attachments: never[], provenance: { sourceId: string }) => {
				const message = {
					id: "inbox-A",
					sourceId: provenance.sourceId,
					turnId: "leader-turn-A",
					status: "delivered" as const,
				};
				delivered.push(message);
				return message;
			},
			listInbox: async () => delivered,
		},
	} as unknown as NodeContext;
	const bridge = createSuperleaderToolBridge({ actorId: "sol-A", workspaceId: "workspace-A", context: () => ctx });
	const asked = await bridge.call("superleader_ask", { question: "What blocks mission 2?" });
	expect(asked.structuredContent).toMatchObject({ status: "delivered", question: "What blocks mission 2?" });
	const before = await bridge.call("superleader_questions", {});
	expect(before.structuredContent?.inquiries).toMatchObject([{ status: "delivered" }]);
	const captureAnswer = async (turnId: string, text: string) => {
		const draft = {
			id: "",
			workspaceId: "workspace-A",
			workspaceName: "A",
			sessionId: "leader-A",
			actorKind: "leader" as const,
			kind: "message" as const,
			at: new Date().toISOString(),
			text,
			turnId,
			explicit: false,
			destinationSessionIds: ["leader-A"],
		};
		return store.capture({ ...draft, id: meSourceId(draft) });
	};
	await captureAnswer("unrelated", "Another answer");
	expect((await bridge.call("superleader_questions", {})).structuredContent?.inquiries).toMatchObject([
		{ status: "delivered" },
	]);
	await captureAnswer("leader-turn-A", "The test suite is failing");
	const after = await bridge.call("superleader_questions", {});
	expect(after.structuredContent?.inquiries).toMatchObject([
		{ status: "replied", leaderReply: "The test suite is failing" },
	]);
	const inquiryId = asked.structuredContent?.id;
	if (typeof inquiryId !== "string") throw new Error("missing inquiry id");
	const actor = { kind: "leader" as const, workspaceId: "workspace-A", sessionId: "leader-A" };
	const answerContext = { actor, deps: { store: ctx.store } } as never;
	expect(
		await coordinationHandlers.neta_superleader_answer(answerContext, {
			inquiryId,
			answer: "The test suite is failing and needs a fixture update",
		}),
	).toMatchObject({ ok: true, data: { status: "answered" } });
	expect((await bridge.call("superleader_questions", {})).structuredContent?.inquiries).toMatchObject([
		{ status: "answered", answer: "The test suite is failing and needs a fixture update" },
	]);
	expect(
		await coordinationHandlers.neta_superleader_answer(
			{ actor: { ...actor, workspaceId: "workspace-B" }, deps: { store: ctx.store } } as never,
			{ inquiryId, answer: "forged" },
		),
	).toMatchObject({ ok: false });
	const carried = await store.queueInquiry({
		idempotencyKey: "ask-after-reset",
		workspaceId: "workspace-A",
		leaderSessionId: "leader-A",
		question: "What remains?",
	});
	const replacement = { ...leader, sessionId: "leader-next" };
	expect(
		await coordinationHandlers.neta_superleader_answer(
			{ actor: { ...actor, sessionId: "leader-next" }, deps: { store: { getLeader: () => replacement } } } as never,
			{ inquiryId: carried.id, answer: "The question survived the leader reset" },
		),
	).toMatchObject({ ok: true, data: { status: "answered" } });
	expect(await openMeStore().listInquiries("workspace-B")).toEqual([]);
	const turn = await store.appendSolTurn({
		workspaceId: "workspace-A",
		idempotencyKey: "handoff-user",
		author: "user",
		text: "Check tests",
	});
	const route = await store.queueRoute({
		idempotencyKey: "handoff-route",
		solTurnId: turn.id,
		instruction: turn.text,
		destinationSessionIds: [leader.sessionId],
		provenanceSourceIds: [],
	});
	await store.updateRoute(route.id, "delivering");
	await store.updateRoute(route.id, "delivered", "route-receipt");
	delivered.push({
		id: "route-receipt",
		sourceId: `sol-route:${route.id}`,
		turnId: "leader-route-turn",
		status: "delivered",
	});
	await captureAnswer("leader-route-turn", "All focused tests passed");
	const attention = await bridge.call("superleader_attention", {});
	expect(attention.structuredContent?.routes).toMatchObject([
		{ id: route.id, leaderReply: "All focused tests passed" },
	]);
});

test("Sol route forwards only a saved user turn whose native transcript matches to a current leader", async () => {
	const dir = mkdtempSync(join(tmpdir(), "neta-sol-route-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const workspace: Workspace = {
		id: "workspace-route",
		kind: "folder",
		name: "Route",
		roots: [{ machineId: "machine-route", path: dir }],
		createdAt: new Date(0).toISOString(),
	};
	const leader: Leader = {
		workspaceId: workspace.id,
		machineId: "machine-route",
		name: "Leader",
		sessionId: "leader-current",
		provider: "fake",
		model: "fixture",
		mode: "lead",
		modeSince: new Date(0).toISOString(),
		modeActiveMs: 0,
		state: "idle",
	};
	const otherLeader = { ...leader, workspaceId: "workspace-other", sessionId: "leader-other" };
	const store = openMeStore();
	const identity = await store.bindSolRuntime({ workspaceId: workspace.id, provider: "fake", model: "fixture" });
	const savedTurn = await store.appendSolTurn({
		idempotencyKey: "route-user-turn",
		author: "user",
		text: "Fix the login bug",
	});
	await store.bindSolNativeTurn(savedTurn.id, "native-user-turn");
	const sent: Array<{ sessionId: string; text: string; sourceId: string }> = [];
	let nativeText = "Fix the login bug";
	const ctx = {
		store: {
			listLeaders: () => [leader, otherLeader],
			getLeader: (workspaceId: string) =>
				workspaceId === workspace.id ? leader : workspaceId === otherLeader.workspaceId ? otherLeader : undefined,
			tailConversation: async (sessionId: string) => ({
				blocks:
					sessionId === identity.sessionId
						? [{ turnId: "native-user-turn", role: "user", kind: "text", text: nativeText, seq: 1 }]
						: [],
			}),
		},
		runtime: {
			send: async (sessionId: string, text: string, _attachments: never[], provenance: { sourceId: string }) => {
				sent.push({ sessionId, text, sourceId: provenance.sourceId });
				return {
					id: "receipt-route-1",
					sessionId,
					createdAt: new Date(0).toISOString(),
					text,
					attachments: [],
					status: "delivered" as const,
				};
			},
		},
		hub: { broadcast() {} },
	} as unknown as NodeContext;
	const result = await meHandlers["sol.route"](
		ctx,
		{
			idempotencyKey: "route-idempotency",
			solTurnId: savedTurn.id,
			destinationSessionId: leader.sessionId,
			derivedInstruction: "Inspect and fix the login bug; report findings.",
			derivation: "The user directly requested the login bug fix.",
			provenanceSourceIds: [],
		},
		{} as never,
	);
	expect(result).toMatchObject({ status: "delivered", receipt: "receipt-route-1" });
	expect(sent).toHaveLength(1);
	expect(sent[0]?.sessionId).toBe(leader.sessionId);
	expect(sent[0]?.text).toContain("Fix the login bug");
	expect(sent[0]?.text).toContain("Inspect and fix the login bug; report findings.");
	await expect(
		meHandlers["sol.route"](
			ctx,
			{
				idempotencyKey: "cross-workspace-route",
				solTurnId: savedTurn.id,
				destinationSessionId: otherLeader.sessionId,
				derivedInstruction: "Do work elsewhere",
				derivation: "cross-workspace",
				provenanceSourceIds: [],
			},
			{} as never,
		),
	).rejects.toThrow("another workspace");
	nativeText = "A forged native user turn";
	await expect(
		meHandlers["sol.route"](
			ctx,
			{
				idempotencyKey: "route-forged",
				solTurnId: savedTurn.id,
				destinationSessionId: leader.sessionId,
				derivedInstruction: "Do unrelated work",
				derivation: "fabricated",
				provenanceSourceIds: [],
			},
			{} as never,
		),
	).rejects.toThrow("does not match Neta's captured native user turn");
	expect(sent).toHaveLength(1);
});
