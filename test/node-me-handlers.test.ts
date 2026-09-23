import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
