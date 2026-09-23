import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Leader, Workspace } from "../src/core/types.ts";
import { type MeDecision, type MeSource, meSourceId, openMeStore } from "../src/me/store.ts";
import { meHandlers } from "../src/node/handlers-me.ts";
import type { NodeContext } from "../src/node/server.ts";

const original = process.env.NETA_DIR;
const dirs: string[] = [];
afterEach(async () => {
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
		setModel: async (_id: string, model: string) => calls.push(["model", model]),
		setNativeVariant: async (_id: string, variant: string) => calls.push(["variant", variant]),
		runtimeDiagnostics: async () => ({ model: "openai/gpt-6-sol", variant: "medium" }),
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
	const restored = (await meHandlers["sol.open"](ctx, {}, {} as never)) as { sessionId: string };
	expect(restored.sessionId).toBe(opened.sessionId);
	expect(
		calls.some(
			(call) => typeof call === "object" && call !== null && "allowFresh" in call && call.allowFresh === false,
		),
	).toBe(true);
	expect(calls.filter((call) => typeof call === "object" && call !== null && "allowFresh" in call)).toHaveLength(1);
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
			listLeaders: () => [leader],
			getLeader: (workspaceId: string) => (workspaceId === workspace.id ? leader : undefined),
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
	expect(sent[0]).toMatchObject({
		sessionId: leader.sessionId,
		text: "Inspect and fix the login bug; report findings.",
	});
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
	).rejects.toThrow("does not match Sol's captured native user turn");
	expect(sent).toHaveLength(1);
});
