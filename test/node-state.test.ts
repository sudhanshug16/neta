import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSettings } from "../src/acp/settings.ts";
import { getManagedSession, nodeState, startManagedSession } from "../src/node/state.ts";
import { openStore } from "../src/store/index.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;

const prevDir = process.env.NETA_DIR;

afterEach(() => {
	if (prevDir === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = prevDir;
	}
});

function settings() {
	const fake: ProviderSettings = { command: process.execPath, args: [FIXTURE], resume: true, defaultModel: "" };
	return { providers: { fake }, leader: { provider: "fake" }, forbiddenModels: [] as string[] };
}

const WS = "git:github.com/org/repo";

describe("node state", () => {
	test("a fake session starts against cwd with the entry access", async () => {
		process.env.NETA_DIR = mkdtempSync(join(tmpdir(), "neta-node-"));
		const store = await openStore();
		try {
			const s = nodeState({ store, settings: settings() });
			expect(s.cwd).toBe(process.cwd());
			expect(s.defaultAccess).toBe("readOnly");
			const session = await startManagedSession(s, {
				workspaceId: WS,
				provider: "fake",
				model: "test-model",
				access: "readOnly",
			});
			expect(session.access).toBe("readOnly");
			expect(session.cwd).toBe(process.cwd());
			expect(getManagedSession(s, session.sessionId)).toBe(session);
			const meta = await store.conversations.meta(session.sessionId);
			expect(meta?.provider).toBe("fake");
			await session.close();
		} finally {
			await store.close();
		}
	});

	test("a pre-seeded conversation meta is reused, not overwritten", async () => {
		process.env.NETA_DIR = mkdtempSync(join(tmpdir(), "neta-node-"));
		const store = await openStore();
		try {
			const s = nodeState({ store, settings: settings() });
			const seeded = await store.conversations.create({
				sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				provider: "fake",
				model: "seeded-model",
				createdAt: "2026-09-01T00:00:00.000Z",
			});
			const session = await startManagedSession(s, {
				sessionId: seeded.sessionId,
				workspaceId: WS,
				provider: "fake",
				model: "test-model",
				access: "readOnly",
			});
			expect(session.sessionId).toBe(seeded.sessionId);
			expect((await store.conversations.meta(seeded.sessionId))?.createdAt).toBe("2026-09-01T00:00:00.000Z");
			await session.close();
		} finally {
			await store.close();
		}
	});
});
