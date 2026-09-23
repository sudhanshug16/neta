import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Access } from "../src/core/types.ts";
import { UnknownModelError } from "../src/session/models.ts";
import type { ProviderSettings } from "../src/session/settings.ts";
import type { SessionEvent } from "./fixtures/legacy-acp/session.ts";
import { ResumeFailedError, startSession, TurnInProgressError } from "./fixtures/legacy-acp/session.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;

function provider(extraArgs: string[] = []): ProviderSettings {
	return { command: process.execPath, args: [FIXTURE, ...extraArgs], resume: true, defaultModel: "" };
}

function settingsFor(extraArgs: string[] = []) {
	return {
		providers: { fake: provider(extraArgs) },
		leader: { provider: "fake" },
		forbiddenModels: [] as string[],
	};
}

async function start(
	extraArgs: string[] = [],
	opts?: {
		access?: Access;
		provider?: string;
		unsandboxed?: boolean;
		unsandboxedMode?: string;
		model?: string;
		mcpServers?: { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[];
		steeringSafe?: boolean;
		forbiddenModels?: string[];
	},
) {
	return startSession({
		settings: {
			...settingsFor(extraArgs),
			providers: { [opts?.provider ?? "fake"]: { ...provider(extraArgs), unsandboxedMode: opts?.unsandboxedMode } },
			forbiddenModels: opts?.forbiddenModels ?? [],
		},
		provider: opts?.provider ?? "fake",
		access: opts?.access ?? "readWrite",
		unsandboxed: opts?.unsandboxed,
		cwd: mkdtempSync(join(tmpdir(), "neta-acp-")),
		model: opts?.model,
		mcpServers: opts?.mcpServers,
		steeringSafe: opts?.steeringSafe,
	});
}

// One events() consumer per session, shared across its turns: attach once,
// prompt, then wait for the matching turnEnd.
const collectors = new WeakMap<Awaited<ReturnType<typeof start>>, { seen: SessionEvent[]; at: number }>();

function collectorFor(session: Awaited<ReturnType<typeof start>>): { seen: SessionEvent[]; at: number } {
	let collector = collectors.get(session);
	if (collector === undefined) {
		collector = { seen: [], at: 0 };
		collectors.set(session, collector);
		const owned = collector;
		void (async (): Promise<void> => {
			for await (const event of session.events()) {
				owned.seen.push(event);
			}
		})();
	}
	return collector;
}

async function promptAndDrain(session: Awaited<ReturnType<typeof start>>, text: string): Promise<SessionEvent[]> {
	const collector = collectorFor(session);
	const turnId = session.prompt(text);
	for (;;) {
		const end = collector.seen
			.slice(collector.at)
			.find((e) => (e.type === "turnEnd" && e.turnId === turnId) || e.type === "interrupted");
		if (end !== undefined) {
			const out = collector.seen.slice(collector.at);
			collector.at = collector.seen.length;
			return out;
		}
		await Bun.sleep(10);
	}
}

describe("acp session", () => {
	test("an empty requested model keeps the provider-advertised default", async () => {
		const legacy = await start([], { model: "" });
		try {
			expect(legacy.model).toBe("test-model");
		} finally {
			await legacy.close();
		}

		const configured = await start(["--config-options"], { model: "" });
		try {
			expect(configured.model).toBe("fixture-default");
		} finally {
			await configured.close();
		}
	});

	test("an explicit unknown model still fails instead of becoming a default request", async () => {
		await expect(start([], { model: "not-advertised" })).rejects.toThrow(UnknownModelError);
	});

	test("legacy model selection sends the active vendor session id", async () => {
		const session = await start([], { model: "" });
		try {
			expect(session.vendorSessionId).not.toBe("");
			await session.setModel("legacy-other");
			expect(session.model).toBe("legacy-other");
		} finally {
			await session.close();
		}
	});

	test("a forbidden advertised default follows the existing safe fallback policy", async () => {
		const session = await start(["--claude-fable-default"], {
			model: "",
			forbiddenModels: ["claude-fable-5"],
		});
		try {
			expect(session.model).toBe("haiku");
		} finally {
			await session.close();
		}
	});

	test("legacy advertised modes use session/set_mode and reject unadvertised modes", async () => {
		const session = await start([], { unsandboxed: true, unsandboxedMode: "test-mode" });
		try {
			const events = await promptAndDrain(session, "REPORT_SANDBOX_POLICY");
			const text = events
				.filter((event) => event.type === "block" && event.block.kind === "text")
				.map((event) => (event as { block: { text: string } }).block.text)
				.join("");
			expect(text).toContain("mode:test-mode");
		} finally {
			await session.close();
		}
		await expect(start([], { unsandboxed: true, unsandboxedMode: "missing-mode" })).rejects.toThrow(
			"does not advertise unsandboxed mode missing-mode",
		);
	});

	test("leaders select the adapter-advertised unrestricted mode and keep it across relaunch", async () => {
		for (const mode of ["agent-full-access", "bypassPermissions"]) {
			const storeFile = join(mkdtempSync(join(tmpdir(), "neta-acp-policy-")), "sessions.json");
			writeFileSync(storeFile, JSON.stringify({ counter: 0, sessions: {} }));
			const session = await start(["--config-options", "--unrestricted-mode", mode, "--session-store", storeFile], {
				access: "readOnly",
				unsandboxed: true,
				unsandboxedMode: mode,
			});
			try {
				const permission = await promptAndDrain(session, "EDIT");
				expect(
					permission
						.filter((event) => event.type === "block" && event.block.kind === "text")
						.map((event) => (event as { block: { text: string } }).block.text)
						.join(""),
				).toContain("permission=allow");
				for (const access of ["readOnly", "readWrite"] as const) {
					if (session.access !== access) await session.relaunch(access);
					const events = await promptAndDrain(session, "REPORT_SANDBOX_POLICY");
					const text = events
						.filter((event) => event.type === "block" && event.block.kind === "text")
						.map((event) => (event as { block: { text: string } }).block.text)
						.join("");
					expect(text).toContain(`mode:${mode}`);
				}
			} finally {
				await session.close();
			}
		}
	});

	test("ordinary agents do not select the provider unrestricted mode", async () => {
		const session = await start(["--config-options", "--unrestricted-mode", "agent-full-access"], {
			access: "readWrite",
			unsandboxed: false,
			unsandboxedMode: "agent-full-access",
		});
		try {
			const events = await promptAndDrain(session, "REPORT_SANDBOX_POLICY");
			const text = events
				.filter((event) => event.type === "block" && event.block.kind === "text")
				.map((event) => (event as { block: { text: string } }).block.text)
				.join("");
			expect(text).toContain("mode:ask");
		} finally {
			await session.close();
		}
	});

	test("THINK, DIFF and USAGE yield thought, tool plus diff, and status blocks", async () => {
		const session = await start();
		try {
			const think = await promptAndDrain(session, "THINK");
			expect(
				think
					.filter((e) => e.type === "block" && e.block.kind === "thought")
					.map((e) => (e as { block: { text: string } }).block.text),
			).toEqual(["weighing options"]);
			const diff = await promptAndDrain(session, "DIFF");
			const tool = diff.filter((e) => e.type === "block" && e.block.kind === "tool");
			expect(tool).toHaveLength(2);
			const diffs = diff.filter((e) => e.type === "block" && e.block.kind === "diff");
			expect(diffs).toHaveLength(2);
			for (const d of diffs) {
				expect((d as { block: { text: string } }).block.text).toBe("/repo/config.json (+1 −1)");
			}
			const usage = await promptAndDrain(session, "USAGE");
			const statuses = usage.filter((e) => e.type === "block" && e.block.kind === "usage");
			expect(statuses.map((e) => (e as { block: { text: string } }).block.text)).toEqual(["1500 tokens"]);
			expect(statuses[0]).toMatchObject({
				type: "block",
				block: { data: { usedTokens: 1200, contextSize: 200000, inputTokens: 1000, outputTokens: 500 } },
			});
			const end = usage.find((e) => e.type === "turnEnd");
			expect(end).toMatchObject({ stopReason: "end_turn", cancelled: false });
		} finally {
			await session.close();
		}
	});

	test("STREAM chunks coalesce into one block re-emitted at the same seq", async () => {
		const session = await start();
		try {
			const events = await promptAndDrain(session, "STREAM");
			const texts = events.filter((e) => e.type === "block" && e.block.kind === "text");
			expect(texts.map((e) => (e as { block: { text: string } }).block.text)).toEqual([
				"First paragraph",
				"First paragraph continues.\n\nSecond",
				"First paragraph continues.\n\nSecond paragraph.",
			]);
			const seqs = texts.map((e) => (e as { block: { seq: number } }).block.seq);
			expect(new Set(seqs).size).toBe(1);
		} finally {
			await session.close();
		}
	});

	test("plan, tool lifecycle and usage coalesce before the final turn boundary", async () => {
		const session = await start();
		try {
			const events = await promptAndDrain(session, "FULL_SEQUENCE");
			const blocks = events.filter((event) => event.type === "block").map((event) => event.block);
			expect(blocks.some((block) => block.kind === "plan" && block.text.includes("Inspect the workspace"))).toBe(
				true,
			);
			const tools = blocks.filter((block) => block.kind === "tool");
			expect(tools.map((block) => block.data?.status)).toEqual(["pending", "in_progress", "completed", "completed"]);
			expect(new Set(tools.map((block) => block.seq)).size).toBe(1);
			const usage = blocks.filter((block) => block.kind === "usage");
			expect(usage).toHaveLength(1);
			expect(new Set(usage.map((block) => block.seq)).size).toBe(1);
			expect(events.at(-1)).toMatchObject({ type: "turnEnd", stopReason: "end_turn" });
			expect(session.openTurnId).toBeUndefined();
		} finally {
			await session.close();
		}
	});

	test("a second prompt mid-turn throws, steering cancels the first", async () => {
		const session = await start();
		const seen: SessionEvent[] = [];
		const draining = (async (): Promise<void> => {
			for await (const event of session.events()) {
				seen.push(event);
				if (event.type === "turnEnd" || event.type === "interrupted") {
					break;
				}
			}
		})();
		const first = session.prompt("HOLD_FOREVER");
		expect(session.openTurnId).toBe(first);
		expect(() => session.prompt("again")).toThrow(TurnInProgressError);
		try {
			session.prompt("again");
		} catch (error) {
			expect((error as TurnInProgressError).turnId).toBe(first);
		}
		await session.cancel();
		await draining;
		const end = seen.find((e) => e.type === "turnEnd");
		expect(end).toMatchObject({ turnId: first, stopReason: "cancelled", cancelled: true });
		await session.close();
	});

	test("WAIT_FOR_BARRIER without a file rejects into a status block and error turnEnd", async () => {
		const session = await start();
		try {
			const events = await promptAndDrain(session, "WAIT_FOR_BARRIER");
			const end = events.find((e) => e.type === "turnEnd");
			expect(end).toMatchObject({ stopReason: "error", cancelled: false });
			const statuses = events.filter((e) => e.type === "block" && e.block.kind === "status");
			expect(statuses.length).toBeGreaterThan(0);
		} finally {
			await session.close();
		}
	});

	test("CONFIG_UPDATE and MODE_UPDATE give status blocks and typed events", async () => {
		const session = await start();
		try {
			const config = await promptAndDrain(session, "CONFIG_UPDATE");
			expect(config.filter((e) => e.type === "block" && e.block.kind === "status").length).toBeGreaterThan(0);
			expect(config.find((e) => e.type === "model")).toEqual({
				type: "model",
				model: "fixture-fast",
				bindingGeneration: session.bindingGeneration,
			});
			expect(session.model).toBe("fixture-fast");
			expect(session.listModels().map((model) => model.id)).toContain("fixture-fast");
			const mode = await promptAndDrain(session, "MODE_UPDATE");
			expect(mode.find((e) => e.type === "mode")).toEqual({
				type: "mode",
				modeId: "plan",
				bindingGeneration: session.bindingGeneration,
			});
		} finally {
			await session.close();
		}
	});

	test("OpenCode read-only workers can inspect external files and execute shell but cannot edit", async () => {
		const session = await start([], { provider: "opencode", access: "readOnly" });
		try {
			for (const [prompt, outcome] of [
				["SHELL", "allow"],
				["PERMISSION_READ", "allow"],
				["PERMISSION_SEARCH", "allow"],
				["PERMISSION_FETCH", "allow"],
				["PERMISSION_OTHER", "reject"],
				["EDIT", "reject"],
			] as const) {
				const events = await promptAndDrain(session, prompt);
				expect(
					events.some(
						(e) => e.type === "block" && e.block.kind === "text" && e.block.text === `permission=${outcome}`,
					),
				).toBe(true);
			}
		} finally {
			await session.close();
		}
	});

	test("EDIT takes allow in readWrite and reject in readOnly", async () => {
		const rw = await start([], { access: "readWrite" });
		try {
			const events = await promptAndDrain(rw, "EDIT");
			const texts = events.filter((e) => e.type === "block" && e.block.kind === "text");
			expect(texts.map((e) => (e as { block: { text: string } }).block.text)).toContain("permission=allow");
		} finally {
			await rw.close();
		}
		const ro = await start([], { access: "readOnly" });
		try {
			const events = await promptAndDrain(ro, "EDIT");
			const texts = events.filter((e) => e.type === "block" && e.block.kind === "text");
			expect(texts.map((e) => (e as { block: { text: string } }).block.text)).toContain("permission=reject");
		} finally {
			await ro.close();
		}
	});

	test("an MCP server list reaches session/new, which the MCP word proves", async () => {
		const session = await start([], {
			mcpServers: [{ name: "neta", command: "neta", args: ["mcp"], env: [] }],
		});
		try {
			const events = await promptAndDrain(session, "MCP");
			const texts = events.filter((e) => e.type === "block" && e.block.kind === "text");
			const joined = texts.map((e) => (e as { block: { text: string } }).block.text).join("\n");
			expect(joined).toContain('"name":"neta"');
		} finally {
			await session.close();
		}
	});

	test("a rejected resume throws ResumeFailedError", async () => {
		const storeFile = join(mkdtempSync(join(tmpdir(), "neta-acp-")), "store.json");
		writeFileSync(storeFile, JSON.stringify({ counter: 0, sessions: {} }));
		const settings = settingsFor(["--reject-resume", "--session-store", storeFile]);
		await expect(
			startSession({
				settings,
				provider: "fake",
				access: "readWrite",
				cwd: mkdtempSync(join(tmpdir(), "neta-acp-")),
				resumeVendorSessionId: "s1",
			}),
		).rejects.toThrow(ResumeFailedError);
	});

	test("closing mid-turn interrupts with no replay", async () => {
		const session = await start();
		const seen: SessionEvent[] = [];
		const draining = (async (): Promise<void> => {
			for await (const event of session.events()) {
				seen.push(event);
			}
		})();
		const turnId = session.prompt("HOLD_FOR_STEER");
		await session.close();
		await draining;
		const interrupted = seen.find((e) => e.type === "interrupted");
		expect(interrupted).toMatchObject({ turnId });
		expect(seen.filter((e) => e.type === "turnEnd")).toEqual([]);
	});

	test("trusted native steering injects without cancelling and records the user message", async () => {
		const session = await start([], { steeringSafe: true });
		const seen: SessionEvent[] = [];
		void (async () => {
			for await (const event of session.events()) seen.push(event);
		})();
		const turnId = session.prompt("HOLD_FOREVER");
		while (session.openTurnId !== turnId) await new Promise((done) => setTimeout(done, 5));
		expect(session.steeringSupported).toBe(true);
		expect(await session.steer("message-1", "change direction", [])).toBe("injected");
		expect(session.openTurnId).toBe(turnId);
		for (
			let attempts = 0;
			attempts < 20 && !seen.some((event) => event.type === "block" && event.block.data?.messageId === "message-1");
			attempts += 1
		)
			await new Promise((done) => setTimeout(done, 5));
		expect(
			seen.some(
				(event) =>
					event.type === "block" &&
					event.block.role === "user" &&
					event.block.text === "change direction" &&
					event.block.data?.messageId === "message-1",
			),
		).toBe(true);
		for (
			let attempts = 0;
			attempts < 100 && !seen.some((event) => event.type === "turnEnd" && event.turnId === turnId);
			attempts += 1
		)
			await new Promise((done) => setTimeout(done, 5));
		const agentText = seen
			.filter((event) => event.type === "block" && event.block.role === "agent")
			.map((event) => (event.type === "block" ? event.block.text : ""))
			.join("\n");
		expect(agentText).toContain("steered:change direction");
		expect(seen.some((event) => event.type === "turnEnd" && event.turnId === turnId)).toBe(true);
		await session.close();
	});

	test("relaunch keeps sessionId, vendorSessionId and the history", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-acp-"));
		const storeFile = join(dir, "store.json");
		writeFileSync(storeFile, JSON.stringify({ counter: 0, sessions: {} }));
		const settings = settingsFor(["--session-store", storeFile]);
		const session = await startSession({
			settings,
			provider: "fake",
			access: "readOnly",
			cwd: mkdtempSync(join(tmpdir(), "neta-acp-")),
		});
		try {
			const before = session.vendorSessionId;
			await promptAndDrain(session, "hello");
			await session.relaunch("readWrite");
			expect(session.access).toBe("readWrite");
			expect(session.vendorSessionId).toBe(before);
			const events = await promptAndDrain(session, "HISTORY");
			const texts = events.filter((e) => e.type === "block" && e.block.kind === "text");
			const joined = texts.map((e) => (e as { block: { text: string } }).block.text).join("\n");
			expect(joined).toContain("hello");
		} finally {
			await session.close();
		}
	});
});

test("runtime bindings stamp turns and launch context identity with constrained fallback", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "neta-acp-binding-"));
	const captured = join(cwd, "context-env.json");
	const wrapper = join(cwd, "agent.mjs");
	writeFileSync(
		wrapper,
		`import {writeFileSync} from "node:fs";
import ${JSON.stringify(FIXTURE)};
writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ actorId:process.env.NETA_SYSTEM_CONTEXT_ACTOR_ID, sessionId:process.env.NETA_SYSTEM_CONTEXT_SESSION_ID, generation:process.env.NETA_SYSTEM_CONTEXT_GENERATION, fallback:process.env.NETA_FALLBACK_MODELS }));`,
	);
	const options = {
		settings: {
			providers: { fake: { ...provider(), args: [wrapper, "--session-store", join(cwd, "sessions.json")] } },
			leader: { provider: "fake" },
			forbiddenModels: [],
		},
		provider: "fake",
		access: "readWrite" as const,
		cwd,
		actorId: "actor-1",
		bindingGeneration: "runtime-1",
		fallbackModels: ["test/small"],
	};
	const session = await startSession(options);
	try {
		expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual({
			actorId: "actor-1",
			sessionId: session.sessionId,
			generation: "runtime-1",
			fallback: '["test/small"]',
		});
		const first = await promptAndDrain(session, "first");
		expect(first.find((event) => event.type === "turn")?.bindingGeneration).toBe("runtime-1");
		const opened = first.find((event) => event.type === "turn");
		if (opened?.type === "turn") expect(opened.turn.bindingGeneration).toBe("runtime-1");
		await session.relaunch("readOnly");
		expect(session.bindingGeneration).not.toBe("runtime-1");
		expect(JSON.parse(readFileSync(captured, "utf8")).generation).toBe(session.bindingGeneration);
		const next = await promptAndDrain(session, "second");
		expect(next.every((event) => event.bindingGeneration === session.bindingGeneration)).toBe(true);
	} finally {
		await session.close();
	}
});

test("model catalog refresh updates available models without changing the session or selected model", async () => {
	const session = await start(["--config-options"], { model: "" });
	try {
		const id = session.vendorSessionId;
		const model = session.model;
		expect(session.listModels().map((item) => item.id)).not.toContain("xai/new-model");
		await session.setConfigOption("neta_refresh_models", "");
		expect(session.listModels().map((item) => item.id)).toContain("xai/new-model");
		expect(session.vendorSessionId).toBe(id);
		expect(session.model).toBe(model);
	} finally {
		await session.close();
	}
});
