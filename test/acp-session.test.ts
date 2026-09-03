import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "../src/acp/session.ts";
import { ResumeFailedError, startSession, TurnInProgressError } from "../src/acp/session.ts";
import type { ProviderSettings } from "../src/acp/settings.ts";
import type { Access } from "../src/core/types.ts";

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
		model?: string;
		mcpServers?: { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[];
	},
) {
	return startSession({
		settings: settingsFor(extraArgs),
		provider: "fake",
		access: opts?.access ?? "readWrite",
		cwd: mkdtempSync(join(tmpdir(), "neta-acp-")),
		model: opts?.model,
		mcpServers: opts?.mcpServers,
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
			const statuses = usage.filter((e) => e.type === "block" && e.block.kind === "status");
			expect(statuses.map((e) => (e as { block: { text: string } }).block.text)).toContain(
				"1200/200000 tokens · $0.42",
			);
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
			expect(config.find((e) => e.type === "model")).toEqual({ type: "model", model: "fixture-fast" });
			expect(session.model).toBe("fixture-fast");
			const mode = await promptAndDrain(session, "MODE_UPDATE");
			expect(mode.find((e) => e.type === "mode")).toEqual({ type: "mode", modeId: "plan" });
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
		const turnId = session.prompt("HOLD_FOREVER");
		await session.close();
		await draining;
		const interrupted = seen.find((e) => e.type === "interrupted");
		expect(interrupted).toMatchObject({ turnId });
		expect(seen.filter((e) => e.type === "turnEnd")).toEqual([]);
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
