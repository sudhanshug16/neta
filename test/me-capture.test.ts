import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Event, Leader, Mission, Workspace } from "../src/core/types.ts";
import { captureMeEvent, replayMeEvents } from "../src/me/capture.ts";
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
