import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { Block, Turn } from "../src/core/types.ts";
import { openConversationStore } from "../src/store/conversations.ts";

const prev = process.env.NETA_DIR;

afterEach(() => {
	if (prev === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = prev;
	}
});

function useTempDir(): void {
	process.env.NETA_DIR = mkdtempSync(join(tmpdir(), "neta-conv-"));
}

async function seedTurns(sessionId: string, turns: number, blocksPerTurn: number): Promise<Turn[]> {
	const store = openConversationStore();
	const out: Turn[] = [];
	let seq = 0;
	for (let t = 0; t < turns; t++) {
		const turn: Turn = {
			id: ulid(Date.parse("2026-09-03T17:00:00.000Z") + t),
			sessionId,
			startedAt: "2026-09-03T17:00:00.000Z",
			role: t % 2 === 0 ? "user" : "agent",
		};
		await store.appendTurn(turn);
		out.push(turn);
		for (let b = 0; b < blocksPerTurn; b++) {
			seq += 1;
			const block: Block = {
				turnId: turn.id,
				seq,
				at: "2026-09-03T17:00:00.000Z",
				role: turn.role,
				kind: "text",
				text: `turn ${t} block ${b}`,
			};
			await store.appendBlock(sessionId, block);
		}
	}
	return out;
}

describe("conversation store", () => {
	test("tail, follow, reopen, turnRange and readBefore over 5000 blocks", async () => {
		useTempDir();
		const sessionId = ulid();
		const store = openConversationStore();
		await store.create({
			sessionId,
			provider: "claude",
			model: "sonnet",
			createdAt: "2026-09-03T17:00:00.000Z",
		});
		const turns = await seedTurns(sessionId, 50, 100);

		const tail = await store.tail({ sessionId });
		expect(tail.blocks).toHaveLength(100);
		expect(tail.blocks[0].text).toBe("turn 49 block 0");
		expect(tail.blocks[99].text).toBe("turn 49 block 99");
		expect(tail.more).toBe(false);

		const live = openConversationStore();
		for (let b = 0; b < 10; b++) {
			await live.appendBlock(sessionId, {
				turnId: turns[49].id,
				seq: 5001 + b,
				at: "2026-09-03T18:00:00.000Z",
				role: "agent",
				kind: "text",
				text: `late ${b}`,
			});
		}
		const followed = await store.tail({ sessionId, cursor: tail.cursor });
		expect(followed.blocks.map((b) => b.text)).toEqual(Array.from({ length: 10 }, (_, b) => `late ${b}`));

		// A cursor survives a reopen: a fresh instance follows from it.
		const fresh = openConversationStore();
		const refollow = await fresh.tail({ sessionId, cursor: tail.cursor });
		expect(refollow.blocks).toHaveLength(10);

		const range = await store.turnRange(sessionId, turns[24].id);
		expect(range).toBeDefined();
		const page = await store.tail({ sessionId, cursor: range?.start });
		expect(page.blocks[0].text).toBe("turn 24 block 0");
		expect(page.from).toBeGreaterThan(0);

		const end = await store.tail({ sessionId, limit: 500 });
		const back = await store.readBefore({ sessionId, cursor: end.cursor, limit: 30 });
		expect(back.blocks).toHaveLength(30);
		expect(back.blocks[29].text).toBe("late 9");

		// Page all the way back: every block once, in order, ending at 0.
		const all: string[] = [];
		let cursor: number | null = end.cursor;
		for (;;) {
			const chunk = await store.readBefore({ sessionId, cursor: cursor as number, limit: 500 });
			all.unshift(...chunk.blocks.map((b) => b.text));
			cursor = chunk.prevCursor;
			if (cursor === null) {
				break;
			}
		}
		expect(all).toHaveLength(5010);
		expect(all[0]).toBe("turn 0 block 0");
		expect(all[5009]).toBe("late 9");
	}, 120000);

	test("setMeta changes the model and keeps createdAt", async () => {
		useTempDir();
		const sessionId = ulid();
		const store = openConversationStore();
		await store.create({
			sessionId,
			provider: "claude",
			model: "sonnet",
			createdAt: "2026-09-03T17:00:00.000Z",
		});
		const next = await store.setMeta(sessionId, { model: "opus", vendorSessionId: "v-1" });
		expect(next.model).toBe("opus");
		expect(next.vendorSessionId).toBe("v-1");
		expect(next.createdAt).toBe("2026-09-03T17:00:00.000Z");
	});

	test("a block for an unknown turn is an error", async () => {
		useTempDir();
		const sessionId = ulid();
		const store = openConversationStore();
		await expect(
			store.appendBlock(sessionId, {
				turnId: ulid(),
				seq: 1,
				at: "2026-09-03T17:00:00.000Z",
				role: "agent",
				kind: "text",
				text: "orphan",
			}),
		).rejects.toThrow();
	});
});
