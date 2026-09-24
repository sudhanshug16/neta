import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block, Leader, Turn, Workspace } from "../src/core/types.ts";
import { captureMeLeaderTurn } from "../src/me/capture.ts";
import { meSourceId, openMeStore } from "../src/me/store.ts";
import { conversationHandlers, sessionSystemContext } from "../src/node/handlers-conversation.ts";
import { createSuperleaderToolBridge, meHandlers } from "../src/node/handlers-me.ts";
import type { NodeContext } from "../src/node/server.ts";
import { loadSettings } from "../src/session/settings.ts";
import { openStore } from "../src/store/index.ts";
import { coordinationHandlers } from "../src/tools/handlers/coordination.ts";
import { adaptLegacyAcp as adaptRuntime } from "./fixtures/legacy-acp-runtime.ts";

const oldDir = process.env.NETA_DIR;
let dir = "";

afterEach(async () => {
	if (oldDir === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = oldDir;
	if (dir) await rm(dir, { recursive: true, force: true });
});

test("Sol opens and resumes one native runtime session and admits chat messages idempotently", async () => {
	dir = await mkdtemp(join(tmpdir(), "neta-sol-runtime-"));
	process.env.NETA_DIR = dir;
	const fixture = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			providers: {
				fake: {
					command: process.execPath,
					args: [fixture, "--session-store", join(dir, "fake-sessions.json")],
					resume: true,
					defaultModel: "test-model",
				},
			},
			leader: { provider: "fake" },
		}),
	);
	const persisted = await openStore();
	const workspace: Workspace = {
		id: "workspace-sol",
		kind: "folder",
		name: "Sol runtime fixture",
		roots: [{ machineId: "machine-sol", path: dir }],
		createdAt: new Date(0).toISOString(),
	};
	const leader: Leader = {
		workspaceId: workspace.id,
		machineId: "machine-sol",
		name: "Workspace leader",
		sessionId: "leader-session-sol",
		provider: "fake",
		model: "test-model",
		mode: "lead",
		modeSince: new Date(0).toISOString(),
		modeActiveMs: 0,
		state: "idle",
	};
	const store = {
		machine: () => ({ id: "machine-sol" }),
		getWorkspace: (id: string) => (id === workspace.id ? workspace : undefined),
		getLeader: (id: string) => (id === leader.workspaceId ? leader : undefined),
		listLeaders: () => [leader],
		listAgents: () => [],
		tailConversation: async (id: string, query: { limit: number; cursor?: string }) => {
			const page = await persisted.conversations.tail({ sessionId: id, limit: 500 });
			return {
				...page,
				blocks: page.blocks.filter((block) => block.seq > Number(query.cursor ?? 0)).slice(0, query.limit),
				provider: "fake",
				model: "test-model",
			};
		},
	};
	const context = (runtime: ReturnType<typeof adaptRuntime>) =>
		({ store, runtime, hub: { broadcast() {} } }) as unknown as NodeContext;
	const firstRuntime = adaptRuntime(
		loadSettings({ netaDir: dir }).settings,
		persisted.conversations,
		undefined,
		undefined,
		undefined,
		persisted.inbox,
	);
	try {
		const opened = (await meHandlers["sol.open"](
			context(firstRuntime),
			{ workspaceId: workspace.id },
			{} as never,
		)) as {
			sessionId: string;
			model: string;
		};
		const identity = await openMeStore().solIdentity();
		expect(opened.sessionId).toBe(identity.sessionId);
		expect(opened.model).toBe("test-model");
		expect(await persisted.conversations.meta(identity.sessionId)).toMatchObject({ sessionId: identity.sessionId });
		await firstRuntime.createSession({
			sessionId: leader.sessionId,
			workspaceId: workspace.id,
			cwd: dir,
			provider: leader.provider,
			model: leader.model,
			access: "readOnly",
			netaTools: false,
		});
		const bridge = createSuperleaderToolBridge({
			actorId: identity.sessionId,
			workspaceId: workspace.id,
			context: () => context(firstRuntime),
		});
		const inquiry = await bridge.call("superleader_ask", { question: "What is the current blocker?" });
		const inquiryId = inquiry.structuredContent?.id;
		if (typeof inquiryId !== "string") throw new Error("inquiry was not saved");
		const inquiryDelivery = (await persisted.inbox.list(leader.sessionId)).find(
			(item) => item.sourceId === `superleader-inquiry:${inquiryId}`,
		);
		if (!inquiryDelivery?.turnId) throw new Error("inquiry did not reach the leader");
		let answerRange = await persisted.conversations.turnRange(leader.sessionId, inquiryDelivery.turnId);
		for (let attempt = 0; attempt < 50 && !answerRange?.turn.endedAt; attempt += 1) {
			await Bun.sleep(20);
			answerRange = await persisted.conversations.turnRange(leader.sessionId, inquiryDelivery.turnId);
		}
		if (!answerRange) throw new Error("leader response was not recorded");
		const answerBlocks = (
			await persisted.conversations.tail({ sessionId: leader.sessionId, limit: 200 })
		).blocks.filter((block) => block.turnId === inquiryDelivery.turnId);
		expect(answerRange.turn.readerDirected).toBe(true);
		expect(answerRange.turn.endedAt).toBeDefined();
		expect(answerBlocks.some((block) => block.role === "agent" && block.kind === "text")).toBe(true);
		await captureMeLeaderTurn({
			store: openMeStore(),
			workspace,
			sessionId: leader.sessionId,
			turn: answerRange.turn,
			blocks: answerBlocks,
		});
		expect((await bridge.call("superleader_questions", {})).structuredContent?.inquiries).toMatchObject([
			{ id: inquiryId, status: "replied" },
		]);
		expect(
			await coordinationHandlers.neta_superleader_answer(
				{
					actor: { kind: "leader", workspaceId: workspace.id, sessionId: leader.sessionId },
					deps: { store },
				} as never,
				{ inquiryId, answer: "The workspace leader's confirmed answer" },
			),
		).toMatchObject({ ok: true, data: { status: "answered" } });
		const sent = (await meHandlers["sol.prompt"](
			context(firstRuntime),
			{ workspaceId: workspace.id, idempotencyKey: "sol-message-1", text: "Summarize my attention feed." },
			{} as never,
		)) as { sessionId: string; status: string; solTurnId: string };
		expect(sent).toMatchObject({ sessionId: identity.sessionId, status: "delivered" });
		const originalInstruction = await openMeStore().getSolTurn(sent.solTurnId);
		if (!originalInstruction) throw new Error("Sol did not persist the exact user instruction");
		const route = (await meHandlers["sol.route"](
			context(firstRuntime),
			{
				idempotencyKey: "sol-route-1",
				solTurnId: originalInstruction.id,
				derivedInstruction: "Inspect the deployment checklist and report blockers; do not deploy.",
				derivation: "The user's request asks for a readiness assessment, not execution.",
				destinationSessionId: leader.sessionId,
				provenanceSourceIds: [],
			},
			{} as never,
		)) as {
			id: string;
			instruction: string;
			derivedInstruction: string;
			destinationSessionIds: string[];
			status: string;
		};
		expect(route).toMatchObject({
			instruction: "Summarize my attention feed.",
			derivedInstruction: "Inspect the deployment checklist and report blockers; do not deploy.",
			destinationSessionIds: [leader.sessionId],
			status: "delivered",
		});
		const delayedTurn = await openMeStore().appendSolTurn({
			idempotencyKey: "delayed-sol-message",
			author: "user",
			text: "Check the queued instruction.",
		});
		const delayedInbox = await persisted.inbox.enqueue(identity.sessionId, delayedTurn.text, [], {
			readerDirected: true,
			sourceId: `sol-turn:${delayedTurn.id}`,
		});
		const deliveredTurnId = "delayed-native-turn";
		await persisted.conversations.appendTurn({
			id: deliveredTurnId,
			sessionId: identity.sessionId,
			startedAt: new Date().toISOString(),
			role: "user",
			readerDirected: true,
		});
		await persisted.conversations.appendBlock(identity.sessionId, {
			turnId: deliveredTurnId,
			seq:
				((await persisted.conversations.tail({ sessionId: identity.sessionId, limit: 500 })).blocks.at(-1)?.seq ??
					0) + 1,
			at: new Date().toISOString(),
			role: "user",
			kind: "text",
			text: delayedTurn.text,
		});
		await persisted.inbox.markDelivered(identity.sessionId, delayedInbox.id, deliveredTurnId);
		await meHandlers["sol.route"](
			context(firstRuntime),
			{
				idempotencyKey: "delayed-sol-route",
				solTurnId: delayedTurn.id,
				derivedInstruction: "Check the queued instruction.",
				derivation: "Queue correlation fixture.",
				destinationSessionId: leader.sessionId,
			},
			{} as never,
		);
		expect((await openMeStore().getSolTurn(delayedTurn.id))?.nativeTurnId).toBe(deliveredTurnId);
		expect((await openMeStore().listRoutes()).find((item) => item.idempotencyKey === "sol-route-1")).toMatchObject({
			instruction: "Summarize my attention feed.",
			derivedInstruction: "Inspect the deployment checklist and report blockers; do not deploy.",
			derivation: "The user's request asks for a readiness assessment, not execution.",
			status: "delivered",
		});
		await expect(
			meHandlers["sol.route"](
				context(firstRuntime),
				{
					idempotencyKey: "sol-route-stale",
					solTurnId: originalInstruction.id,
					derivedInstruction: "send to stale",
					derivation: "test stale owner",
					destinationSessionId: "stale-session",
				},
				{} as never,
			),
		).rejects.toThrow("current workspace leader");
		await meHandlers["sol.route"](
			context(firstRuntime),
			{
				idempotencyKey: "sol-route-1",
				solTurnId: originalInstruction.id,
				derivedInstruction: route.derivedInstruction,
				derivation: "The user's request asks for a readiness assessment, not execution.",
				destinationSessionId: leader.sessionId,
				provenanceSourceIds: [],
			},
			{} as never,
		);
		const deliveredRoute = (await persisted.inbox.list(leader.sessionId)).find(
			(item) => item.sourceId === `sol-route:${route.id}`,
		);
		expect(deliveredRoute?.text).toContain(originalInstruction.text);
		expect(deliveredRoute?.text).toContain(route.derivedInstruction);
		expect(
			(await persisted.inbox.list(leader.sessionId)).filter((item) => item.sourceId === deliveredRoute?.sourceId),
		).toHaveLength(1);
		const interruptedRoute = await openMeStore().queueRoute({
			idempotencyKey: "sol-route-interrupted",
			solTurnId: originalInstruction.id,
			instruction: originalInstruction.text,
			derivedInstruction: "Reconcile the deployment inventory and report only the discrepancies.",
			derivation: "Crash-recovery route fixture.",
			destinationSessionIds: [leader.sessionId],
			provenanceSourceIds: [],
		});
		await openMeStore().updateRoute(interruptedRoute.id, "delivering");
		const recoveredRoute = (await meHandlers["sol.route"](
			context(firstRuntime),
			{
				idempotencyKey: "sol-route-interrupted",
				solTurnId: originalInstruction.id,
				derivedInstruction: interruptedRoute.derivedInstruction,
				derivation: interruptedRoute.derivation,
				destinationSessionId: leader.sessionId,
			},
			{} as never,
		)) as { status: string };
		expect(recoveredRoute.status).toBe("delivered");
		expect(
			(await persisted.inbox.list(leader.sessionId)).filter(
				(item) =>
					item.sourceId === `sol-route:${interruptedRoute.id}` &&
					item.text.includes(interruptedRoute.derivedInstruction ?? ""),
			),
		).toHaveLength(1);
		const replyDraft = {
			id: "",
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			sessionId: leader.sessionId,
			actorKind: "leader" as const,
			kind: "failure" as const,
			at: new Date().toISOString(),
			text: "A deployment window is needed.",
			eventId: "leader-event-1",
			explicit: true,
			destinationSessionIds: [leader.sessionId],
		};
		const replySource = await openMeStore().capture({ ...replyDraft, id: meSourceId(replyDraft) });
		const card = await openMeStore().decide(replySource.id, {
			action: "surface",
			concernKey: "deployment-window",
			headline: "Deployment window needed",
			summary: replySource.text,
			evidenceSourceIds: [replySource.id],
			needsReply: true,
			resolved: false,
			destinationSessionIds: [leader.sessionId],
		});
		if (!card) throw new Error("reply card was not created");
		const interruptedReply = await openMeStore().queueReply({
			idempotencyKey: "reply-interrupted",
			cardId: card.id,
			text: "Please report the approved window only.",
			destinationSessionId: leader.sessionId,
		});
		await openMeStore().updateReply(interruptedReply.id, "delivering");
		const recoveredReply = (await meHandlers["me.reply"](
			context(firstRuntime),
			{
				cardId: card.id,
				text: interruptedReply.text,
				idempotencyKey: "reply-interrupted",
				destinationSessionId: leader.sessionId,
			},
			{} as never,
		)) as { status: string };
		expect(recoveredReply.status).toBe("delivered");
		expect(
			(await persisted.inbox.list(leader.sessionId)).filter((item) => item.text === interruptedReply.text),
		).toHaveLength(1);
		const reply = (await meHandlers["me.reply"](
			context(firstRuntime),
			{ cardId: card.id, text: "  hold until Monday\n", idempotencyKey: "exact-reply-1" },
			{} as never,
		)) as { status: string };
		expect(reply.status).toBe("delivered");
		expect((await persisted.inbox.list(leader.sessionId)).some((item) => item.text === "  hold until Monday\n")).toBe(
			true,
		);
		const suppressedDraft = {
			...replyDraft,
			id: "",
			kind: "event" as const,
			at: new Date().toISOString(),
			text: "Routine weekly build passed.",
			eventId: "routine-event-1",
			explicit: false,
		};
		const suppressedSource = await openMeStore().capture({ ...suppressedDraft, id: meSourceId(suppressedDraft) });
		await openMeStore().decide(suppressedSource.id, {
			action: "suppress",
			concernKey: "routine-build",
			headline: "Routine build",
			summary: suppressedSource.text,
			evidenceSourceIds: [suppressedSource.id],
			needsReply: false,
			resolved: false,
			destinationSessionIds: [leader.sessionId],
		});
		const longText = `${"Original long transcript detail ".repeat(260)}end-of-original-source`;
		const sourceAt = new Date().toISOString();
		const transcriptTurn: Turn = {
			id: "long-source-turn",
			sessionId: leader.sessionId,
			startedAt: sourceAt,
			endedAt: sourceAt,
			role: "user",
			readerDirected: true,
		};
		await persisted.conversations.appendTurn(transcriptTurn);
		const lastSeq =
			(await persisted.conversations.tail({ sessionId: leader.sessionId, limit: 500 })).blocks.at(-1)?.seq ?? 0;
		const transcriptBlock: Block = {
			turnId: transcriptTurn.id,
			seq: lastSeq + 1,
			at: sourceAt,
			role: "agent",
			kind: "text",
			text: longText,
		};
		await persisted.conversations.appendBlock(leader.sessionId, transcriptBlock);
		await captureMeLeaderTurn({
			store: openMeStore(),
			workspace,
			sessionId: leader.sessionId,
			turn: transcriptTurn,
			blocks: [transcriptBlock],
		});
		const longSource = (await openMeStore().pendingSources()).find((source) => source.turnId === transcriptTurn.id);
		if (!longSource) throw new Error("long transcript source was not captured");
		await openMeStore().decide(longSource.id, {
			action: "surface",
			concernKey: "long-transcript",
			headline: "Long transcript evidence",
			summary: "Read the full transcript source, not only the bounded preview.",
			evidenceSourceIds: [longSource.id],
			needsReply: false,
			resolved: false,
			destinationSessionIds: [leader.sessionId],
		});
		const superleaderContext = await sessionSystemContext(
			{ store: store as never, superleaderWorkspaceId: workspace.id },
			identity.sessionId,
		);
		expect(superleaderContext).toContain("superleader_missions");
		expect(superleaderContext).not.toContain("A deployment window is needed.");
		expect(superleaderContext).not.toContain("SUPPRESSED HISTORY");
		expect(superleaderContext).not.toContain("Routine weekly build passed.");
		expect(superleaderContext).not.toContain("end-of-original-source");
		expect((await bridge.call("superleader_user_turns", {})).structuredContent?.turns).toContainEqual(
			expect.objectContaining({ id: sent.solTurnId, text: "Summarize my attention feed." }),
		);
		const duplicate = (await meHandlers["sol.prompt"](
			context(firstRuntime),
			{ workspaceId: workspace.id, idempotencyKey: "sol-message-1", text: "Summarize my attention feed." },
			{} as never,
		)) as { sessionId: string };
		expect(duplicate.sessionId).toBe(identity.sessionId);
		const nativeAttachment = {
			url: "http://127.0.0.1:1",
			authorization: "Basic fixture",
			sessionId: "ses_fixture_sol",
			directory: dir,
			apiVersion: 2 as const,
		};
		const nativeRuntime = {
			...firstRuntime,
			nativeAttachment: () => nativeAttachment,
			ensureNativeAttachment: async () => nativeAttachment,
		};
		let closeGateway: (() => void) | undefined;
		const native = (await conversationHandlers["conversation.native"](
			context(nativeRuntime),
			{ sessionId: identity.sessionId },
			{
				onClose: (close: () => void) => {
					closeGateway = close;
				},
			} as never,
		)) as { url: string; authorization: string; sessionId: string };
		try {
			const response = await fetch(`${native.url}/api/session/${native.sessionId}/neta-prompt`, {
				method: "POST",
				headers: { Authorization: native.authorization, "content-type": "application/json" },
				body: JSON.stringify({ id: "msg_native_sol_1", text: "Native chat question" }),
			});
			expect(response.status).toBe(200);
			expect(
				(await openMeStore().listSolTurns({ limit: 10 })).turns.some(
					(turn) => turn.text === "Native chat question",
				),
			).toBe(true);
		} finally {
			closeGateway?.();
		}
	} finally {
		await firstRuntime.closeAll();
	}
	const resumedRuntime = adaptRuntime(
		loadSettings({ netaDir: dir }).settings,
		persisted.conversations,
		undefined,
		undefined,
		undefined,
		persisted.inbox,
	);
	try {
		const resumed = (await meHandlers["sol.open"](
			context(resumedRuntime),
			{ workspaceId: workspace.id },
			{} as never,
		)) as { sessionId: string };
		expect(resumed.sessionId).toBe((await openMeStore().solIdentity()).sessionId);
		expect(resumed.sessionId).toBe((await openMeStore().solIdentity()).sessionId);
	} finally {
		await resumedRuntime.closeAll();
	}
});
