import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessage } from "../src/core/types.ts";
import { commitNoticeForTurn, deliverPendingNotices, reconcileNoticePresentations } from "../src/me/notice-delivery.ts";
import { openMeStore } from "../src/me/store.ts";

const previousDir = process.env.NETA_DIR;
let directory = "";
afterEach(async () => {
	if (previousDir === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = previousDir;
	if (directory) await rm(directory, { recursive: true, force: true });
});

test("notice delivery uses a stable inbox source and waits for a native presentation", async () => {
	directory = await mkdtemp(join(tmpdir(), "neta-notice-"));
	process.env.NETA_DIR = directory;
	const store = openMeStore();
	const source = await store.capture({
		id: "",
		workspaceId: "workspace-A",
		workspaceName: "Workspace A",
		sessionId: "leader-A",
		actorKind: "leader",
		kind: "failure",
		at: new Date(0).toISOString(),
		text: "worktree.setupFailed",
		eventId: "workspace-A:9",
		explicit: false,
		forceVisible: true,
		destinationSessionIds: ["leader-A"],
	});
	await store.decide(source.id, {
		action: "surface",
		concernKey: "setup-52",
		headline: "Mission setup failed",
		summary: "The worktree did not finish setup.",
		evidenceSourceIds: [source.id],
		needsReply: false,
		resolved: false,
		destinationSessionIds: ["leader-A"],
	});
	const inbox: InboxMessage[] = [];
	let sends = 0;
	const runtime = {
		listInbox: async () => inbox,
		send: async (sessionId: string, text: string, _attachments: [], provenance: { sourceId?: string }) => {
			sends++;
			expect(text).toContain("Mission setup failed");
			expect(text).toContain(source.id);
			const message: InboxMessage = {
				id: "inbox-1",
				sessionId,
				createdAt: new Date(0).toISOString(),
				text,
				attachments: [],
				status: "delivered",
				deliveredAt: new Date(0).toISOString(),
				turnId: "turn-1",
				sourceId: provenance.sourceId,
			};
			inbox.push(message);
			return message;
		},
	};
	const input = { store, runtime, openNeta: async () => ({ sessionId: "neta-A" }) };
	const first = await deliverPendingNotices(input);
	expect(first.delivered).toHaveLength(1);
	expect((await store.pendingNotices())[0]?.status).toBe("delivered");
	await deliverPendingNotices(input);
	expect(sends).toBe(1);
	const notice = (await store.pendingNotices())[0];
	if (!notice) throw new Error("missing notice");
	await store.declareNotice(notice.id, [source.id]);
	expect(
		await commitNoticeForTurn({
			store,
			runtime,
			sessionId: "neta-A",
			turn: {
				id: "turn-1",
				sessionId: "neta-A",
				startedAt: new Date(0).toISOString(),
				endedAt: new Date(1).toISOString(),
				role: "user",
			},
			blocks: [
				{
					turnId: "turn-1",
					seq: 1,
					at: new Date(1).toISOString(),
					role: "agent",
					kind: "text",
					text: "The setup failed before a mission was created.",
				},
			],
		}),
	).toEqual([notice.id]);
	expect(await store.pendingNotices()).toEqual([]);
});

test("a fast native turn commits before send returns and restart does not resend it", async () => {
	directory = await mkdtemp(join(tmpdir(), "neta-notice-fast-"));
	process.env.NETA_DIR = directory;
	const store = openMeStore();
	const source = await store.capture({
		id: "",
		workspaceId: "workspace-A",
		workspaceName: "Workspace A",
		sessionId: "leader-A",
		actorKind: "leader",
		kind: "failure",
		at: new Date(0).toISOString(),
		text: "Mission setup failed",
		eventId: "setup-1",
		explicit: true,
		forceVisible: true,
		destinationSessionIds: ["leader-A"],
	});
	await store.decide(source.id, {
		action: "surface",
		concernKey: "setup-1",
		headline: "Setup failed",
		summary: "Mission not created",
		evidenceSourceIds: [source.id],
		needsReply: false,
		resolved: false,
		destinationSessionIds: ["leader-A"],
	});
	const notice = (await store.pendingNotices())[0];
	if (!notice) throw new Error("missing notice");
	const neta = await store.solIdentity("workspace-A");
	const turn = {
		id: "turn-fast",
		sessionId: neta.sessionId,
		startedAt: new Date(0).toISOString(),
		endedAt: new Date(1).toISOString(),
		role: "user" as const,
	};
	const blocks = [
		{
			turnId: turn.id,
			seq: 1,
			at: turn.endedAt,
			role: "agent" as const,
			kind: "text" as const,
			text: "Setup failed before mission registration.",
		},
	];
	const inbox: InboxMessage[] = [];
	let sends = 0;
	const runtime = {
		listInbox: async () => inbox,
		send: async (sessionId: string, text: string, _attachments: [], provenance: { sourceId?: string }) => {
			sends++;
			const message: InboxMessage = {
				id: "inbox-fast",
				sessionId,
				createdAt: turn.startedAt,
				text,
				attachments: [],
				status: "delivered",
				turnId: turn.id,
				sourceId: provenance.sourceId,
			};
			inbox.push(message);
			await store.declareNotice(notice.id, [source.id]);
			expect(await commitNoticeForTurn({ store, runtime, sessionId, turn, blocks })).toEqual([notice.id]);
			return message;
		},
	};
	await deliverPendingNotices({ store, runtime, openNeta: async () => neta });
	expect((await store.getNotice(notice.id))?.status).toBe("committed");
	const reopened = openMeStore();
	expect(
		await reconcileNoticePresentations({
			store: reopened,
			runtime,
			readTurn: async () => ({ turn, blocks }),
		}),
	).toEqual([]);
	await deliverPendingNotices({ store: reopened, runtime, openNeta: async () => neta });
	expect(sends).toBe(1);
	expect((await reopened.listPresentations("workspace-A"))[0]?.declaredSourceIds).toEqual([source.id]);
});
