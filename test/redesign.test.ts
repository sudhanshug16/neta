import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { leaderTools } from "../src/mcp/leader.ts";
import { workerTools } from "../src/mcp/worker.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import { NetaConfig } from "../src/settings.ts";
import { waitFor } from "./helpers.ts";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

describe("settled tool surface and revival", () => {
	const managers: WorkerManager[] = [];
	const dirs: string[] = [];

	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.dispose();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function manager(extraArgs: string[] = []): WorkerManager {
		const dir = mkdtempSync(join(tmpdir(), "neta-redesign-"));
		dirs.push(dir);
		const config = new NetaConfig({
			backends: {
				codex: {
					detect: "bun",
					command: process.execPath,
					args: [fakeAgent, "--config-options", "--session-store", join(dir, "sessions.json"), ...extraArgs],
				},
			},
			tiers: {
				apprentice: { backend: "codex" },
				journeyman: { backend: "codex" },
				expert: { backend: "codex" },
				architect: { backend: "codex" },
			},
		});
		const value = new WorkerManager({
			cwd: process.cwd(),
			agentDir: dir,
			config,
			channelAddress: join(dir, "neta.sock"),
			onEvent: () => {},
		});
		managers.push(value);
		return value;
	}

	it("registers exactly the ten leader tools and only gives room tools to team workers", () => {
		const value = manager();
		expect(
			leaderTools(value)
				.map((tool) => tool.name)
				.sort(),
		).toEqual([
			"neta_attach",
			"neta_delegate",
			"neta_exec",
			"neta_inspect",
			"neta_kill",
			"neta_note",
			"neta_send",
			"neta_status",
			"neta_wait",
			"neta_workers",
		]);
		expect(
			workerTools("socket", "ro1", "token")
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["neta_blocked", "neta_progress", "neta_status"]);
		expect(
			workerTools("socket", "ro1", "token", "review")
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["neta_blocked", "neta_progress", "neta_room", "neta_room_post", "neta_status"]);
	});

	it("delegates independent and team batches with actual assignments and prevalidates before seeding", async () => {
		const value = manager();
		const delegate = leaderTools(value).find((tool) => tool.name === "neta_delegate");
		if (!delegate) throw new Error("neta_delegate missing");
		const single = await delegate.run({ workers: [{ role: "scout", tier: "expert", task: "single" }] });
		expect(single.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("codex (read-only") });
		const team = await delegate.run({
			team: "review",
			seed: "compare",
			workers: [
				{ role: "scout", tier: "expert", task: "one" },
				{ role: "reviewer", tier: "expert", task: "two" },
			],
		});
		expect(team.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('Team "review"') });
		expect(value.roomTranscript("review")[0]?.text).toBe("compare");
		const before = value.list().length;
		await expect(
			delegate.run({
				team: "bad",
				seed: "must not land",
				workers: [{ role: "missing", tier: "expert", task: "x" }],
			}),
		).rejects.toThrow("Unknown role");
		expect(value.list()).toHaveLength(before);
		expect(value.roomTranscript("bad")).toEqual([]);
	});

	it("resumes done and failed workers twice in the exact recorded ACP session", async () => {
		const value = manager();
		const worker = await value.spawn({ role: "scout", tier: "expert", task: "first" });
		await waitFor(() => expect(value.get(worker.id).state).toBe("done"));
		const vendor = value.get(worker.id).vendorSessionId;
		await value.steer(worker.id, "second");
		expect((await value.wait([worker.id], 5_000)).reason).toBe("completed");
		expect(value.get(worker.id)).toMatchObject({ vendorSessionId: vendor, revivalCount: 1, result: "echo:second" });
		await value.steer(worker.id, "FAIL third");
		expect((await value.wait([worker.id], 5_000)).reason).toBe("completed");
		expect(value.get(worker.id).state).toBe("failed");
		await value.steer(worker.id, "fourth");
		expect((await value.wait([worker.id], 5_000)).reason).toBe("completed");
		expect(value.get(worker.id)).toMatchObject({ vendorSessionId: vendor, revivalCount: 3, result: "echo:fourth" });
	});

	it("makes neta_blocked terminal, releases a writer, wakes wait distinctly, and resumes on send", async () => {
		const value = manager();
		const worker = await value.spawn({ role: "worker", tier: "expert", task: "HOLD_FOREVER", writer: true });
		await waitFor(() => expect(value.get(worker.id).state).toBe("running"));
		const waiting = value.wait([worker.id], 5_000);
		expect(value.blocked(worker.id, "Which database?")).toMatchObject({ ok: true });
		const result = await waiting;
		expect(result).toMatchObject({
			reason: "blocked",
			wokeBy: { id: worker.id, pendingQuestion: "Which database?" },
		});
		expect(value.statusSnapshot().writerSlot).toBeUndefined();
		await value.steer(worker.id, "Use Postgres");
		expect((await value.wait([worker.id], 5_000)).reason).toBe("completed");
		expect(value.get(worker.id)).toMatchObject({ revivalCount: 1, pendingQuestion: undefined });
		expect(value.get(worker.id).result).toContain("echo:Use Postgres");
	});

	it("queues a revived writer behind the active writer and resumes rather than rerunning its task", async () => {
		const value = manager();
		const first = await value.spawn({ role: "worker", tier: "expert", task: "original", writer: true });
		await waitFor(() => expect(value.get(first.id).state).toBe("done"));
		const holder = await value.spawn({ role: "worker", tier: "expert", task: "HOLD_FOREVER", writer: true });
		await waitFor(() => expect(value.get(holder.id).state).toBe("running"));
		const queued = await value.steer(first.id, "resumed instruction");
		expect(queued).toMatchObject({ delivery: "pending-brief", worker: { state: "queued", queuedBehind: holder.id } });
		expect(value.statusSnapshot().writerSlot?.id).toBe(holder.id);
		await value.kill(holder.id);
		await waitFor(() => expect(value.get(first.id).state).toBe("done"));
		expect(value.get(first.id).result).toContain("echo:resumed instruction");
		expect(value.get(first.id).result).not.toContain("echo:original");
	});

	it("refuses killed and interrupted workers and rolls back a rejected resume", async () => {
		const value = manager();
		const done = await value.spawn({ role: "scout", tier: "expert", task: "done" });
		await waitFor(() => expect(value.get(done.id).state).toBe("done"));
		const killed = await value.spawn({ role: "scout", tier: "expert", task: "HOLD_FOREVER" });
		await value.kill(killed.id);
		await expect(value.steer(killed.id, "again")).rejects.toThrow("cannot be resumed safely");

		const rejecting = manager(["--reject-resume"]);
		const terminal = await rejecting.spawn({ role: "scout", tier: "expert", task: "done" });
		await waitFor(() => expect(rejecting.get(terminal.id).state).toBe("done"));
		const before = rejecting.get(terminal.id);
		await expect(rejecting.steer(terminal.id, "again")).rejects.toThrow("failed to start an ACP session");
		expect(rejecting.get(terminal.id)).toMatchObject({
			state: before.state,
			result: before.result,
			endedAt: before.endedAt,
			revivalCount: 0,
		});
	});
});
