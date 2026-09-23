import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "../src/core/types.ts";
import { accessFor, applyModeSwitch, modeChangeText, type SwitchDeps } from "../src/modes/switch.ts";
import type { ProviderSettings } from "../src/session/settings.ts";
import { type SessionEvent, startSession } from "./fixtures/legacy-acp/session.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;

function settingsFor(extraArgs: string[] = []) {
	const fake: ProviderSettings = {
		command: process.execPath,
		args: [FIXTURE, ...extraArgs],
		resume: true,
		defaultModel: "",
	};
	return { providers: { fake }, leader: { provider: "fake" }, forbiddenModels: [] as string[] };
}

type Started = Awaited<ReturnType<typeof startSession>>;

async function start(): Promise<Started> {
	const dir = mkdtempSync(join(tmpdir(), "neta-switch-"));
	const storeFile = join(dir, "store.json");
	writeFileSync(storeFile, JSON.stringify({ counter: 0, sessions: {} }));
	return startSession({
		settings: settingsFor(["--session-store", storeFile]),
		provider: "fake",
		access: "readOnly",
		cwd: mkdtempSync(join(tmpdir(), "neta-switch-")),
	});
}

const collectors = new WeakMap<Started, { seen: SessionEvent[]; at: number }>();

function collectorFor(session: Started): { seen: SessionEvent[]; at: number } {
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

async function drainTurn(session: Started, turnId: string): Promise<SessionEvent[]> {
	const collector = collectorFor(session);
	for (;;) {
		const end = collector.seen
			.slice(collector.at)
			.find((event) => (event.type === "turnEnd" && event.turnId === turnId) || event.type === "interrupted");
		if (end !== undefined) {
			const out = collector.seen.slice(collector.at);
			collector.at = collector.seen.length;
			return out;
		}
		await Bun.sleep(10);
	}
}

// The 03 steering boundary for these tests: cancel the live turn, then prompt
// the same session once.
function boundary(session: Started, calls: string[]): SwitchDeps {
	return {
		isTurnActive: () => session.openTurnId !== undefined,
		steer: async (id, prompt) => {
			calls.push(`steer:${id}`);
			if (session.openTurnId !== undefined) {
				calls.push(`cancel:${id}`);
				await session.cancel();
				while (session.openTurnId !== undefined) {
					await Bun.sleep(10);
				}
			}
			await drainTurn(session, session.prompt(prompt));
		},
		switchAccess: async (id, access) => {
			calls.push(`access:${id}:${access}`);
		},
	};
}

describe("mode switch through the steering boundary", () => {
	test("a switch during a live turn cancels it and re-prompts the same, unchanged sessionId once", async () => {
		const session = await start();
		try {
			const calls: string[] = [];
			const deps = boundary(session, calls);
			const held = session.prompt("HOLD_FOREVER");
			expect(session.openTurnId).toBe(held);
			const result = await applyModeSwitch(deps, {
				sessionId: session.sessionId,
				from: "lead",
				to: "leadPlus",
				cause: "tool",
				mission: { number: 4, name: "lens port" },
			});
			expect(result).toEqual({ cancelledTurn: true });
			// switchAccess first, then one steer that cancelled and re-prompted.
			expect(calls).toEqual([
				`access:${session.sessionId}:readWrite`,
				`steer:${session.sessionId}`,
				`cancel:${session.sessionId}`,
			]);
			expect(session.sessionId).toBe(session.sessionId);
			expect(session.openTurnId).toBeUndefined();
		} finally {
			await session.close();
		}
	});

	test("with no active turn it re-prompts without a cancel", async () => {
		const session = await start();
		try {
			const calls: string[] = [];
			const idle: SessionId = session.sessionId;
			const result = await applyModeSwitch(boundary(session, calls), {
				sessionId: idle,
				from: "leadPlus",
				to: "lead",
				cause: "user",
			});
			expect(result).toEqual({ cancelledTurn: false });
			expect(calls).toEqual([`access:${idle}:readOnly`, `steer:${idle}`]);
		} finally {
			await session.close();
		}
	});

	test("agent mode and config updates mid-protocol do not change the Neta switch", async () => {
		const session = await start();
		try {
			for (const marker of ["MODE_UPDATE", "CONFIG_UPDATE"]) {
				await drainTurn(session, session.prompt(marker));
			}
			const calls: string[] = [];
			const result = await applyModeSwitch(boundary(session, calls), {
				sessionId: session.sessionId,
				from: "lead",
				to: "leadPlus",
				cause: "tool",
				mission: { number: 4, name: "lens port" },
			});
			// The agent's own mode/config traffic ends its turns; the Neta
			// switch still steers from our from/to exactly once.
			expect(result).toEqual({ cancelledTurn: false });
			expect(calls.filter((call) => call.startsWith("steer:"))).toHaveLength(1);
		} finally {
			await session.close();
		}
	});

	test("a same-mode switch performs no calls", async () => {
		const session = await start();
		try {
			const calls: string[] = [];
			const result = await applyModeSwitch(boundary(session, calls), {
				sessionId: session.sessionId,
				from: "lead",
				to: "lead",
				cause: "user",
			});
			expect(result).toEqual({ cancelledTurn: false });
			expect(calls).toEqual([]);
		} finally {
			await session.close();
		}
	});

	test("access and text", () => {
		expect(accessFor("leadPlus")).toBe("readWrite");
		expect(accessFor("lead")).toBe("readOnly");
		const up = modeChangeText({
			from: "lead",
			to: "leadPlus",
			cause: "tool",
			mission: { number: 4, name: "lens port" },
		});
		expect(up).toContain("Lead++");
		expect(up).toContain("#4 lens port");
		expect(up.split(". ").length).toBeLessThanOrEqual(3);
		const down = modeChangeText({
			from: "leadPlus",
			to: "lead",
			cause: "missionClosed",
			mission: { number: 4, name: "lens port" },
		});
		expect(down).toContain("Lead++ has ended");
		expect(down.split(". ").length).toBeLessThanOrEqual(3);
		for (const text of [up, down]) {
			expect(text.toLowerCase()).not.toContain("lease");
		}
	});
});
