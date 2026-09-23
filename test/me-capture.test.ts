import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Block, Event, Leader, Mission, Turn, Workspace } from "../src/core/types.ts";
import {
	captureMeEvent,
	captureMeLeaderTurn,
	captureMePermissionRequest,
	replayMeEvents,
	replayMeLeaderTurns,
} from "../src/me/capture.ts";
import { openMeStore } from "../src/me/store.ts";

const original = process.env.NETA_DIR;
const dirs: string[] = [];
afterEach(async () => {
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "neta-me-capture-"));
	dirs.push(dir);
	process.env.NETA_DIR = dir;
	const workspace: Workspace = {
		id: "workspace-A",
		kind: "folder",
		name: "Payments",
		roots: [],
		createdAt: "2026-09-23T09:00:00.000Z",
	};
	const leader: Leader = {
		workspaceId: workspace.id,
		machineId: "machine-A",
		name: "Leader",
		sessionId: "leader-A",
		provider: "opencode",
		model: "fixture",
		mode: "lead",
		modeSince: "2026-09-23T09:00:00.000Z",
		modeActiveMs: 0,
		state: "idle",
	};
	const mission: Mission = {
		id: "mission-A",
		number: 4,
		workspaceId: workspace.id,
		machineId: "machine-A",
		name: "Release gate",
		objective: "check the release",
		changes: [],
		state: "blocked",
		createdAt: "2026-09-23T09:00:00.000Z",
		lead: { kind: "leader" },
		agentIds: ["agent-A"],
		access: "readOnly",
	};
	const agent: Agent = {
		id: "agent-A",
		missionId: mission.id,
		workspaceId: workspace.id,
		name: "Cedar",
		task: "check release gate",
		access: "readOnly",
		provider: "opencode",
		model: "fixture",
		skills: [],
		sessionId: "agent-session-A",
		canSpawn: false,
		state: "failed",
		startedAt: "2026-09-23T09:00:00.000Z",
	};
	const context = { workspaces: [workspace], leaders: [leader], agents: [agent], missions: [mission] };
	return { store: openMeStore(), context, workspace, leader, agent, mission };
}

test("permission audit capture keeps the native policy outcome visible without turning it into an approval", async () => {
	const { store, workspace } = fixture();
	const captured = await captureMePermissionRequest({
		store,
		workspace,
		sessionId: "agent-session-A",
		actorKind: "agent",
		missionId: "mission-A",
		request: {
			id: "per_fixture",
			action: "edit",
			resources: ["src/feature.ts"],
			message: "The tool requested write access.",
		},
		disposition: "reject",
	});
	expect(captured).toMatchObject({
		kind: "permission",
		explicit: true,
		forceVisible: true,
		destinationSessionIds: ["agent-session-A"],
		missionId: "mission-A",
	});
	expect(captured.text).toContain("Existing runtime policy disposition: rejected.");
	expect(captured.text).toContain("src/feature.ts");
	expect(
		(
			await captureMePermissionRequest({
				store,
				workspace,
				sessionId: "agent-session-A",
				actorKind: "agent",
				missionId: "mission-A",
				request: {
					id: "per_fixture",
					action: "edit",
					resources: ["different-retry-payload"],
				},
				disposition: "once",
			})
		).id,
	).toBe(captured.id);
});

function event(seq: number, overrides: Partial<Event> = {}): Event {
	return {
		seq,
		at: `2026-09-23T10:0${seq}:00.000Z`,
		workspaceId: "workspace-A",
		kind: "mission.failed",
		missionId: "mission-A",
		agentId: "agent-A",
		sessionId: "agent-session-A",
		data: {},
		...overrides,
	};
}

test("event capture uses current session provenance and only explicit escalation flags", async () => {
	const { store, context } = fixture();
	await captureMeEvent(store, event(1, { data: { needsReply: true } }), context);
	const [source] = await store.pendingSources();
	expect(source).toMatchObject({
		workspaceId: "workspace-A",
		workspaceName: "Payments",
		sessionId: "agent-session-A",
		actorKind: "agent",
		kind: "failure",
		explicit: true,
		destinationSessionIds: ["agent-session-A", "leader-A"],
		text: "mission.failed · Mission #4: Release gate · Agent: Cedar",
	});
	await expect(
		store.decide(source.id, {
			action: "suppress",
			concernKey: "deployment",
			headline: "Deployment",
			summary: "Suppressed",
			evidenceSourceIds: [source.id],
			needsReply: false,
			resolved: false,
			destinationSessionIds: [],
		}),
	).rejects.toThrow("explicit user escalation");
	await captureMeEvent(store, event(2, { data: {} }), context);
	expect((await store.pendingSources()).map((source) => source.explicit)).toEqual([true, false]);
});

test("replay captures before advancing checkpoints and is idempotent after restart", async () => {
	const { store, context } = fixture();
	const events = [event(1), event(2, { kind: "mission.changed" }), event(3, { kind: "routing.failed" })];
	const read = async (sinceSeq: number, limit: number) => events.filter((item) => item.seq > sinceSeq).slice(0, limit);
	expect(await replayMeEvents({ store, workspaceId: "workspace-A", read, context: () => context })).toBe(2);
	expect((await openMeStore().getCheckpoint()).workspaces[0]?.eventSeq).toBe(3);
	expect(
		await replayMeEvents({ store: openMeStore(), workspaceId: "workspace-A", read, context: () => context }),
	).toBe(0);
	expect(await openMeStore().pendingSources()).toHaveLength(2);
});

test("capture failure leaves event cursor behind for replay", async () => {
	const { store, context } = fixture();
	const capture = store.capture;
	store.capture = async () => {
		throw new Error("durable write failed");
	};
	await expect(
		replayMeEvents({ store, workspaceId: "workspace-A", read: async () => [event(1)], context: () => context }),
	).rejects.toThrow("durable write failed");
	expect((await store.getCheckpoint()).workspaces).toEqual([]);
	store.capture = capture;
	expect(
		await replayMeEvents({ store, workspaceId: "workspace-A", read: async () => [event(1)], context: () => context }),
	).toBe(1);
});

test("long leader turns retain bounded previews and exact transcript pointers", async () => {
	const { store, workspace } = fixture();
	const turn: Turn = {
		id: "turn-long",
		sessionId: "leader-A",
		startedAt: "2026-09-23T10:00:00.000Z",
		endedAt: "2026-09-23T10:01:00.000Z",
		role: "user",
		readerDirected: true,
	};
	const at = "2026-09-23T10:01:00.000Z";
	const blocks: Block[] = [{ turnId: turn.id, seq: 2, at, role: "agent", kind: "text", text: "x".repeat(9_000) }];
	await captureMeLeaderTurn({ store, workspace, sessionId: turn.sessionId, turn, blocks });
	const source = (await store.pendingSources())[0];
	expect(source?.text).toHaveLength(8_000);
	expect(source?.transcriptPointer).toMatchObject({
		sessionId: "leader-A",
		turnId: "turn-long",
		firstSeq: 2,
		lastSeq: 2,
		sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
});

test("failed reader-directed turns are captured even with no transcript blocks", async () => {
	const { store, workspace } = fixture();
	const turn: Turn = {
		id: "turn-failed",
		sessionId: "leader-A",
		startedAt: "2026-09-23T10:00:00.000Z",
		endedAt: "2026-09-23T10:01:00.000Z",
		role: "user",
		readerDirected: true,
		failed: true,
	};
	await captureMeLeaderTurn({ store, workspace, sessionId: turn.sessionId, turn, blocks: [] });
	expect((await store.pendingSources())[0]).toMatchObject({
		kind: "failure",
		text: "Workspace leader runtime turn failed.",
	});
	expect((await store.pendingSources())[0]?.transcriptPointer).toBeUndefined();
});

test("turn replay buffers a page-split turn and checkpoints only after its final block", async () => {
	const { store, workspace } = fixture();
	const turn: Turn = {
		id: "turn-split",
		sessionId: "leader-A",
		startedAt: "2026-09-23T10:00:00.000Z",
		endedAt: "2026-09-23T10:01:00.000Z",
		role: "user",
		readerDirected: true,
	};
	const at = "2026-09-23T10:01:00.000Z";
	const block = (seq: number): Block => ({
		turnId: turn.id,
		seq,
		at,
		role: "agent",
		kind: "text",
		text: `part-${seq}`,
	});
	let reads = 0;
	const captured = await replayMeLeaderTurns({
		store,
		workspace,
		sessionId: turn.sessionId,
		read: async (cursor) => {
			reads++;
			if (cursor === 0) return { blocks: [block(1), block(2)], cursor: 10, more: true };
			return { blocks: [block(3)], cursor: 20, more: false };
		},
		getTurn: async (turnId) => (turnId === turn.id ? turn : undefined),
	});
	expect(captured).toBe(1);
	expect(reads).toBe(2);
	expect((await store.pendingSources())[0]?.text).toBe("part-1\n\npart-2\n\npart-3");
	expect((await store.getCheckpoint()).workspaces[0]?.turns).toEqual([
		{ sessionId: "leader-A", turnId: "turn-split", blockSeq: 3 },
	]);
	expect(
		await replayMeLeaderTurns({
			store: openMeStore(),
			workspace,
			sessionId: turn.sessionId,
			read: async () => ({ blocks: [block(1), block(2), block(3)], cursor: 20, more: false }),
			getTurn: async () => turn,
		}),
	).toBe(0);
	expect(await openMeStore().pendingSources()).toHaveLength(1);
});
