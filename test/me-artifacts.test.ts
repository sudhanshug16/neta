import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactActor, inspectArtifact, publishArtifact } from "../src/me/artifacts.ts";

const previousDir = process.env.NETA_DIR;
let directory = "";
afterEach(async () => {
	if (previousDir === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = previousDir;
	if (directory) await rm(directory, { recursive: true, force: true });
});

test("worker CSV is stored once and parents open it by reference", async () => {
	directory = await mkdtemp(join(tmpdir(), "neta-artifacts-"));
	process.env.NETA_DIR = join(directory, "state");
	const worktree = join(directory, "worktree");
	await mkdir(worktree);
	await writeFile(join(worktree, "table.csv"), "name,total\nA,12\nB,14\n");
	const worker: ArtifactActor = {
		workspaceId: "workspace-A",
		machineId: "machine-A",
		missionId: "mission-A",
		actorId: "worker-A",
		kind: "agent",
	};
	const artifact = await publishArtifact({
		actor: worker,
		assignedRoot: worktree,
		path: "table.csv",
		title: "Totals",
		mimeType: "text/csv",
	});
	expect(artifact.preview).toContain("name,total");
	expect(artifact.hash).toMatch(/^[a-f0-9]{64}$/);
	expect((await inspectArtifact({ ...worker, actorId: "lead-A", kind: "lead" }, artifact.id)).text).toBeUndefined();
	expect(
		(await inspectArtifact({ ...worker, actorId: "lead-A", kind: "lead" }, artifact.id, { offset: 0, limit: 100 }))
			.text,
	).toBe("name,total\nA,12\nB,14\n");
	expect(
		(await inspectArtifact({ ...worker, actorId: "neta-A", kind: "neta", missionId: undefined }, artifact.id))
			.artifact.id,
	).toBe(artifact.id);
	await expect(
		inspectArtifact({ ...worker, workspaceId: "workspace-B", actorId: "neta-B", kind: "neta" }, artifact.id),
	).rejects.toThrow();
	await writeFile(join(worktree, "table.csv"), "changed");
	expect((await inspectArtifact(worker, artifact.id, { offset: 0, limit: 100 })).text).toBe(
		"name,total\nA,12\nB,14\n",
	);
	const bytes = await readFile(join(process.env.NETA_DIR, "artifacts", "workspace-A", `${artifact.id}.data`));
	expect(bytes.toString()).toContain("A,12");
	await writeFile(join(process.env.NETA_DIR, "artifacts", "workspace-A", `${artifact.id}.data`), "changed");
	await expect(inspectArtifact(worker, artifact.id, { offset: 0, limit: 100 })).rejects.toThrow("missing or changed");
});

test("all actors in a workspace copy can read artifacts across missions, including saved parent artifacts", async () => {
	directory = await mkdtemp(join(tmpdir(), "neta-artifacts-shared-"));
	process.env.NETA_DIR = join(directory, "state");
	const worktree = join(directory, "worktree");
	await mkdir(worktree);
	const worker: ArtifactActor = {
		workspaceId: "workspace-A",
		machineId: "machine-A",
		missionId: "mission-A",
		actorId: "worker-A",
		kind: "agent",
	};
	const lead: ArtifactActor = { ...worker, actorId: "lead-A", kind: "lead" };
	const coordinator: ArtifactActor = { ...worker, actorId: "leader-A", kind: "leader", missionId: undefined };
	const workspaceLeader: ArtifactActor = { ...worker, actorId: "neta-A", kind: "neta", missionId: undefined };
	const workerArtifact = await publishArtifact({
		actor: worker,
		assignedRoot: worktree,
		text: "Worker finding",
		title: "Worker finding",
		mimeType: "text/plain",
	});
	await writeFile(
		join(process.env.NETA_DIR, "artifacts", "workspace-A", `${workerArtifact.id}.json`),
		JSON.stringify({ ...workerArtifact, audience: "parent" }),
	);
	const saved = (await inspectArtifact(lead, workerArtifact.id)).artifact;
	expect(saved.id).toBe(workerArtifact.id);
	expect(saved).not.toHaveProperty("audience");
	expect(
		(await inspectArtifact({ ...lead, missionId: "mission-B" }, workerArtifact.id, { offset: 0, limit: 100 })).text,
	).toBe("Worker finding");
	expect((await inspectArtifact(coordinator, workerArtifact.id)).artifact.id).toBe(workerArtifact.id);
	expect((await inspectArtifact(workspaceLeader, workerArtifact.id)).artifact.id).toBe(workerArtifact.id);
	const leadArtifact = await publishArtifact({
		actor: lead,
		assignedRoot: worktree,
		text: "Lead finding",
		title: "Lead finding",
		mimeType: "text/plain",
	});
	expect((await inspectArtifact(coordinator, leadArtifact.id)).artifact.id).toBe(leadArtifact.id);
	expect((await inspectArtifact(workspaceLeader, leadArtifact.id)).artifact.id).toBe(leadArtifact.id);
	await expect(inspectArtifact({ ...lead, machineId: "machine-B" }, leadArtifact.id)).rejects.toThrow("unavailable");
});

test("artifact publishing rejects paths outside the assigned worktree and private files", async () => {
	directory = await mkdtemp(join(tmpdir(), "neta-artifacts-private-"));
	process.env.NETA_DIR = join(directory, "state");
	const worktree = join(directory, "worktree");
	await mkdir(worktree);
	await writeFile(join(directory, "outside.csv"), "secret");
	await symlink(join(directory, "outside.csv"), join(worktree, "outside.csv"));
	await writeFile(join(worktree, ".env"), "TOKEN=secret");
	const actor: ArtifactActor = {
		workspaceId: "workspace-A",
		machineId: "machine-A",
		missionId: "mission-A",
		actorId: "worker-A",
		kind: "agent",
	};
	const base = { actor, assignedRoot: worktree, title: "Private", mimeType: "text/csv" };
	await expect(publishArtifact({ ...base, path: "outside.csv" })).rejects.toThrow("outside");
	await expect(publishArtifact({ ...base, path: ".env" })).rejects.toThrow("private");
});
