import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAll, SessionTable, switchProvider } from "../src/acp/lifecycle.ts";
import { startSession } from "../src/acp/session.ts";
import type { ProviderSettings } from "../src/acp/settings.ts";
import { openConversationStore } from "../src/store/conversations.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;

function fake(args: string[] = []): ProviderSettings {
	return { command: process.execPath, args: [FIXTURE, ...args], resume: true, defaultModel: "" };
}

describe("session lifecycle", () => {
	test("switching providers keeps the Neta session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-acp-"));
		process.env.NETA_DIR = dir;
		try {
			const settings = {
				providers: { fake: fake(), other: fake(["--config-options"]) },
				leader: { provider: "fake" },
				forbiddenModels: [] as string[],
			};
			const cwd = mkdtempSync(join(tmpdir(), "neta-acp-"));
			const store = openConversationStore();
			const first = await startSession({ settings, provider: "fake", access: "readWrite", cwd });
			await store.create({
				sessionId: first.sessionId,
				provider: "fake",
				model: "test-model",
				createdAt: "2026-09-03T17:00:00.000Z",
			});
			const sessions = new SessionTable({ settings, cwd, access: "readWrite" });
			sessions.set(first.sessionId, { session: first, provider: "fake" });
			const next = await switchProvider(sessions, store, first.sessionId, "other");
			expect(next.sessionId).toBe(first.sessionId);
			expect(next.provider).toBe("other");
			// The old session is freed: prompting it throws.
			expect(() => first.prompt("after free")).toThrow();
			expect(sessions.get(first.sessionId)?.session).toBe(next);
			expect((await store.meta(first.sessionId))?.model).toBe(next.model);
			await closeAll(sessions);
			expect(sessions.values()).toEqual([]);
		} finally {
			delete process.env.NETA_DIR;
		}
	});

	test("closeAll closes every session and never throws", async () => {
		const settings = {
			providers: { fake: fake() },
			leader: { provider: "fake" },
			forbiddenModels: [] as string[],
		};
		const cwd = mkdtempSync(join(tmpdir(), "neta-acp-"));
		const sessions = new SessionTable({ settings, cwd, access: "readOnly" });
		const a = await startSession({ settings, provider: "fake", access: "readOnly", cwd });
		const b = await startSession({ settings, provider: "fake", access: "readOnly", cwd });
		sessions.set(a.sessionId, { session: a, provider: "fake" });
		const broken = {
			close: async (): Promise<void> => {
				throw new Error("boom");
			},
		};
		sessions.set(b.sessionId, { session: broken as unknown as typeof a, provider: "fake" });
		await closeAll(sessions);
		expect(sessions.values()).toEqual([]);
		await closeAll(sessions);
		await a.close();
		await b.close();
	});
});
