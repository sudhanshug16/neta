import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/acp/settings.ts";
import { adaptAcp } from "../src/node/lifecycle.ts";
import { openStore } from "../src/store/index.ts";

for (const alternatives of [[], ["allowed-small-model"]]) {
	test(`assignment alternatives ${JSON.stringify(alternatives)} survive cold resume, reset, and crash recovery`, async () => {
		const previousDirectory = process.env.NETA_DIR;
		const previousFallback = process.env.NETA_FALLBACK_MODELS;
		const dir = await mkdtemp(join(tmpdir(), "neta-policy-"));
		process.env.NETA_DIR = dir;
		process.env.NETA_FALLBACK_MODELS = '["inherited-unwanted-flagship"]';
		const capture = join(dir, "launches.jsonl");
		const wrapper = join(dir, "fixture.mjs");
		const fixture = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;
		await writeFile(
			wrapper,
			`import { appendFileSync } from "node:fs";\nimport ${JSON.stringify(fixture)};\nappendFileSync(${JSON.stringify(capture)}, JSON.stringify({ fallback: process.env.NETA_FALLBACK_MODELS, generation: process.env.NETA_SYSTEM_CONTEXT_GENERATION }) + "\\n");\n`,
		);
		const settings = loadSettings({ netaDir: dir }).settings;
		settings.providers.fake = {
			command: process.execPath,
			args: [wrapper, "--session-store", join(dir, "provider.json")],
			resume: true,
			defaultModel: "test-model",
		};
		const store = await openStore();
		let runtime = adaptAcp(settings, store.conversations);
		try {
			const request = {
				workspaceId: "fixture",
				cwd: dir,
				provider: "fake",
				model: "test-model",
				access: "readOnly" as const,
				netaTools: false,
				actorId: "worker",
			};
			const created = await runtime.createSession({ ...request, fallbackModels: alternatives });
			expect((await store.conversations.meta(created.sessionId))?.fallbackModels).toEqual(alternatives);
			await runtime.closeAll();
			runtime = adaptAcp(settings, store.conversations);
			const resumed = await runtime.ensureSession({ ...request, sessionId: created.sessionId, allowFresh: false });
			expect(resumed.sessionId).toBe(created.sessionId);
			expect((await store.conversations.meta(resumed.sessionId))?.fallbackModels).toEqual(alternatives);
			const reset = await runtime.resetSession(
				resumed.sessionId,
				"current worker instructions",
				async () => undefined,
			);
			expect((await store.conversations.meta(reset.sessionId))?.fallbackModels).toEqual(alternatives);
			let interrupted!: () => void;
			let completed!: () => void;
			const crash = new Promise<void>((resolve) => {
				interrupted = resolve;
			});
			const recovery = new Promise<void>((resolve) => {
				completed = resolve;
			});
			runtime.onTurn((notification) => {
				if (notification.sessionId !== reset.sessionId || !notification.turn?.endedAt) return;
				if (notification.turn.cancelled) interrupted();
				else completed();
			});
			await runtime.prompt(reset.sessionId, "EXIT_MID_TURN");
			await crash;
			await runtime.prompt(reset.sessionId, "recovered prompt");
			await recovery;
			expect((await store.conversations.meta(reset.sessionId))?.fallbackModels).toEqual(alternatives);
			const launches = (await readFile(capture, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { fallback: string; generation: string });
			expect(launches).toHaveLength(4);
			for (const launch of launches) expect(JSON.parse(launch.fallback)).toEqual(alternatives);
			expect(new Set(launches.map((launch) => launch.generation)).size).toBe(4);
		} finally {
			await runtime.closeAll();
			await store.close();
			if (previousDirectory === undefined) delete process.env.NETA_DIR;
			else process.env.NETA_DIR = previousDirectory;
			if (previousFallback === undefined) delete process.env.NETA_FALLBACK_MODELS;
			else process.env.NETA_FALLBACK_MODELS = previousFallback;
			await rm(dir, { recursive: true, force: true });
		}
	}, 10_000);
}
