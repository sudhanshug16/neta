import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { Mission } from "../src/core/types.ts";
import { appendLine, readText } from "../src/store/files.ts";
import { openStore } from "../src/store/index.ts";
import { monthKey } from "../src/store/paths.ts";

const prev = process.env.NETA_DIR;

afterEach(() => {
	if (prev === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = prev;
	}
});

function useTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "neta-restore-"));
	process.env.NETA_DIR = dir;
	return dir;
}

function mission(workspaceId: string, number: number): Mission {
	return {
		id: ulid(),
		number,
		workspaceId,
		machineId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		name: `mission ${number}`,
		objective: "Do it.",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readOnly",
		state: "running",
		createdAt: new Date(Date.parse("2026-09-03T17:00:00.000Z") + number * 1000).toISOString(),
	};
}

// Simulate a crash mid-append: add one full line, then cut it mid-JSON so the
// file ends in a torn fragment with no trailing newline.
async function tearLastLine(path: string, line: unknown): Promise<void> {
	await appendLine(path, line);
	const text = (await readText(path)) as string;
	const lines = text.split("\n");
	const last = lines[lines.length - 2];
	const cut = last.slice(0, Math.floor(last.length / 2));
	writeFileSync(path, `${lines.slice(0, -2).join("\n")}${lines.length > 2 ? "\n" : ""}${cut}`);
}

describe("store crash consistency", () => {
	test("torn tails are dropped with one warning per file, then appends land cleanly", async () => {
		useTempDir();
		const ws = "git:github.com/org/repo";
		const sessionId = ulid();
		const store = await openStore();
		await store.workspaces.load(ws, () => ({
			id: ws,
			kind: "git",
			name: "repo",
			remote: "github.com/org/repo",
			roots: [],
			createdAt: "2026-09-03T17:00:00.000Z",
		}));
		const m1 = mission(ws, await store.missions.allocateNumber(ws));
		const m2 = mission(ws, await store.missions.allocateNumber(ws));
		await store.missions.create(m1);
		await store.missions.create(m2);
		await store.events.append({ workspaceId: ws, kind: "mission.created", missionId: m1.id, data: { number: 1 } });
		await store.events.append({ workspaceId: ws, kind: "mission.created", missionId: m2.id, data: { number: 2 } });
		await store.conversations.create({
			sessionId,
			provider: "claude",
			model: "sonnet",
			createdAt: "2026-09-03T17:00:00.000Z",
		});
		const turnId = ulid();
		await store.conversations.appendTurn({
			id: turnId,
			sessionId,
			startedAt: "2026-09-03T17:00:00.000Z",
			role: "user",
		});
		await store.conversations.appendBlock(sessionId, {
			turnId,
			seq: 1,
			at: "2026-09-03T17:00:00.000Z",
			role: "user",
			kind: "text",
			text: "hello",
		});
		await store.conversations.appendBlock(sessionId, {
			turnId,
			seq: 2,
			at: "2026-09-03T17:00:00.000Z",
			role: "agent",
			kind: "text",
			text: "hi",
		});
		await store.close();

		const month = monthKey("2026-09-03T17:00:00.000Z");
		await tearLastLine(join(store.dir, "missions", encodeURIComponent(ws), "registry.ndjson"), {
			op: "update",
			at: "2026-09-03T18:00:00.000Z",
			mission: m2,
		});
		await tearLastLine(join(store.dir, "events", encodeURIComponent(ws), `${month}.ndjson`), {
			seq: 99,
			at: "2026-09-03T18:00:00.000Z",
			workspaceId: ws,
			kind: "mission.created",
			data: {},
		});
		await tearLastLine(join(store.dir, "conversations", `${sessionId}.ndjson`), {
			t: "block",
			block: { turnId, seq: 3, at: "2026-09-03T18:00:00.000Z", role: "agent", kind: "text", text: "torn" },
		});

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (message?: unknown): void => {
			warnings.push(String(message));
		};
		try {
			const reopened = await openStore();
			const missions = await reopened.missions.list(ws, {});
			expect(missions.missions).toHaveLength(2);
			const events = await reopened.events.list(ws, {});
			expect(events.events).toHaveLength(2);
			const tail = await reopened.conversations.tail({ sessionId });
			expect(tail.blocks.map((b) => b.text)).toEqual(["hello", "hi"]);
			expect(warnings).toHaveLength(3);

			const m3 = mission(ws, await reopened.missions.allocateNumber(ws));
			await reopened.missions.create(m3);
			expect((await reopened.missions.byNumber(ws, 3))?.id).toBe(m3.id);
			await reopened.events.append({ workspaceId: ws, kind: "mission.created", missionId: m3.id, data: {} });
			expect((await reopened.events.list(ws, {})).events).toHaveLength(3);
			await reopened.conversations.appendBlock(sessionId, {
				turnId,
				seq: 3,
				at: "2026-09-03T18:00:00.000Z",
				role: "agent",
				kind: "text",
				text: "clean",
			});
			const retailed = await reopened.conversations.tail({ sessionId });
			expect(retailed.blocks.map((b) => b.text)).toEqual(["hello", "hi", "clean"]);
			expect(warnings).toHaveLength(3);
			await reopened.close();
		} finally {
			console.warn = origWarn;
		}
	});
});

describe("store restore", () => {
	test("5000 missions across two workspaces restore fast, numbering continues, modes hold", async () => {
		const dir = useTempDir();
		const big = "git:github.com/org/big";
		const small = "git:github.com/org/small";
		const store = await openStore();
		for (const [ws, count] of [
			[big, 3000],
			[small, 2000],
		] as const) {
			for (let n = 0; n < count; n++) {
				const number = await store.missions.allocateNumber(ws);
				await store.missions.create(mission(ws, number));
			}
		}
		await store.close();

		const reopened = await openStore();
		await reopened.missions.load(big);
		const from = new Date(Date.parse("2026-09-04T00:00:00.000Z") - 24 * 3_600_000).toISOString();
		const started = Date.now();
		const page = await reopened.missions.list(big, { from, limit: 1000 });
		const elapsed = Date.now() - started;
		expect(page.missions).toHaveLength(1000);
		expect(elapsed).toBeLessThan(50);
		expect(await reopened.missions.allocateNumber(big)).toBe(3001);
		expect(await reopened.missions.allocateNumber(small)).toBe(2001);
		await reopened.close();

		const stack: string[] = [dir];
		while (stack.length > 0) {
			const current = stack.pop() as string;
			for (const name of readdirSync(current)) {
				const full = join(current, name);
				const st = statSync(full);
				if (st.isDirectory()) {
					expect(st.mode & 0o777).toBe(0o700);
					stack.push(full);
				} else {
					expect(st.mode & 0o777).toBe(0o600);
				}
			}
		}
	}, 120000);
});
