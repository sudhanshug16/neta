import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Event, InboxMessage, Leader, Mission, Workspace } from "../src/core/types.ts";
import { type ArtifactActor, inspectArtifact, publishArtifact, reviewArtifact } from "../src/me/artifacts.ts";
import { captureMeEvent } from "../src/me/capture.ts";
import { createMeCurator } from "../src/me/curator.ts";
import { commitNoticeForTurn, deliverPendingNotices, noticePrompt } from "../src/me/notice-delivery.ts";
import { openMeStore } from "../src/me/store.ts";

const previousDir = process.env.NETA_DIR;
let directory = "";
afterEach(async () => {
	if (previousDir === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = previousDir;
	if (directory) await rm(directory, { recursive: true, force: true });
});

test("worker CSV moves by reference through both parents, the filter, and one native Neta turn", async () => {
	directory = await mkdtemp(join(tmpdir(), "neta-pipeline-"));
	process.env.NETA_DIR = join(directory, "state");
	const worktree = join(directory, "worktree");
	await mkdir(worktree);
	const csv = "name,total\nA,12\nB,14\n";
	await writeFile(join(worktree, "table.csv"), csv);
	const at = new Date(0).toISOString();
	const workspace: Workspace = { id: "workspace-A", kind: "folder", name: "Workspace A", roots: [], createdAt: at };
	const leader: Leader = {
		workspaceId: workspace.id,
		machineId: "machine-A",
		name: "Leader",
		sessionId: "leader-A",
		provider: "fake",
		model: "fake",
		mode: "lead",
		modeSince: at,
		modeActiveMs: 0,
		state: "idle",
	};
	const mission: Mission = {
		id: "mission-A",
		number: 5,
		workspaceId: workspace.id,
		machineId: "machine-A",
		name: "Totals table",
		objective: "Prepare totals",
		changes: [],
		lead: { kind: "agent", agentId: "lead-A" },
		agentIds: ["lead-A", "worker-A"],
		access: "readOnly",
		state: "running",
		createdAt: at,
	};
	const lead: Agent = {
		id: "lead-A",
		missionId: mission.id,
		workspaceId: workspace.id,
		name: "Cedar",
		task: "Review totals",
		access: "readOnly",
		provider: "fake",
		model: "fake",
		skills: [],
		sessionId: "lead-A",
		canSpawn: true,
		state: "running",
		startedAt: at,
	};
	const worker: Agent = { ...lead, id: "worker-A", sessionId: "worker-A", name: "Pine", canSpawn: false };
	const actor: ArtifactActor = {
		workspaceId: workspace.id,
		machineId: "machine-A",
		missionId: mission.id,
		actorId: worker.id,
		kind: "agent",
	};
	const artifact = await publishArtifact({
		actor,
		assignedRoot: worktree,
		path: "table.csv",
		title: "Totals",
		mimeType: "text/csv",
		audience: "user",
	});
	const store = openMeStore();
	const context = {
		machineId: "machine-A",
		workspaces: [workspace],
		leaders: [leader],
		missions: [mission],
		agents: [lead, worker],
	};
	const event = (seq: number, kind: Event["kind"], sessionId: string, agentId?: string): Event => ({
		seq,
		kind,
		at,
		workspaceId: workspace.id,
		missionId: mission.id,
		sessionId,
		...(agentId ? { agentId } : {}),
		data: {
			artifactId: artifact.id,
			title: artifact.title,
			audience: artifact.audience,
			verdict: "accepted",
			note: "Reviewed totals",
		},
	});
	expect(await captureMeEvent(store, event(1, "artifact.published", worker.sessionId, worker.id), context)).toBe(true);
	await reviewArtifact({ ...actor, actorId: lead.id, kind: "lead" }, artifact.id, "accepted", "Rows checked.");
	expect(await captureMeEvent(store, event(2, "artifact.reviewed", lead.sessionId, lead.id), context)).toBe(true);
	await expect(inspectArtifact({ ...actor, actorId: "neta-A", kind: "neta" }, artifact.id)).rejects.toThrow(
		"workspace leader",
	);
	await reviewArtifact(
		{ ...actor, actorId: leader.sessionId, kind: "leader" },
		artifact.id,
		"accepted",
		"Lead review accepted.",
	);
	expect(await captureMeEvent(store, event(3, "artifact.reviewed", leader.sessionId), context)).toBe(true);
	const filterInputs: string[] = [];
	const curator = createMeCurator({
		store,
		classify: async ({ source }) => {
			filterInputs.push(JSON.stringify(source));
			return {
				action: source.actorKind === "leader" ? "surface" : "suppress",
				concernKey: `artifact:${artifact.id}`,
				headline: "Totals table ready",
				summary: `Reviewed CSV ${artifact.id}`,
				evidenceSourceIds: [source.id],
				needsReply: false,
				resolved: false,
				destinationSessionIds: source.destinationSessionIds,
			};
		},
	});
	expect((await curator.drain()).pending).toBe(0);
	expect(filterInputs.join("\n")).not.toContain("A,12");
	const notice = (await store.pendingNotices())[0];
	if (!notice) throw new Error("missing Neta notice");
	expect(noticePrompt(notice)).not.toContain("A,12");
	const neta = await store.solIdentity(workspace.id);
	const inbox: InboxMessage[] = [];
	const runtime = {
		listInbox: async () => inbox,
		send: async (sessionId: string, text: string, _attachments: [], provenance: { sourceId?: string }) => {
			const message: InboxMessage = {
				id: "inbox-1",
				sessionId,
				createdAt: at,
				text,
				attachments: [],
				status: "delivered",
				turnId: "turn-1",
				sourceId: provenance.sourceId,
			};
			inbox.push(message);
			return message;
		},
	};
	expect((await deliverPendingNotices({ store, runtime, openNeta: async () => neta })).delivered).toEqual([notice.id]);
	expect(
		(
			await inspectArtifact({ ...actor, actorId: neta.sessionId, kind: "neta" }, artifact.id, {
				offset: 0,
				limit: 100,
			})
		).text,
	).toBe(csv);
	await store.declareNotice(notice.id, notice.sourceIds);
	expect(
		await commitNoticeForTurn({
			store,
			runtime,
			sessionId: neta.sessionId,
			turn: {
				id: "turn-1",
				sessionId: neta.sessionId,
				role: "user",
				startedAt: at,
				endedAt: new Date(1).toISOString(),
			},
			blocks: [
				{
					turnId: "turn-1",
					seq: 1,
					at: new Date(1).toISOString(),
					role: "agent",
					kind: "text",
					text: `Totals CSV: ${artifact.id}`,
				},
			],
		}),
	).toEqual([notice.id]);
	expect(await openMeStore().listPresentations(workspace.id)).toHaveLength(1);
});
