import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessSwitchUnsupported, planAccessSwitch, quirkValue, switchAccess } from "../src/acp/access.ts";
import { startSession } from "../src/acp/session.ts";
import type { ProviderSettings } from "../src/acp/settings.ts";
import type { Access } from "../src/core/types.ts";

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

async function start(extraArgs: string[] = [], access: Access = "readWrite") {
	return startSession({
		settings: settingsFor(extraArgs),
		provider: "fake",
		access,
		cwd: mkdtempSync(join(tmpdir(), "neta-acp-")),
	});
}

describe("access switching", () => {
	test("planAccessSwitch is undefined for same access, shaped otherwise", async () => {
		const session = await start([], "readOnly");
		try {
			expect(planAccessSwitch(session, "readOnly")).toBeUndefined();
			const plan = planAccessSwitch(session, "readWrite");
			expect(plan?.modes).toEqual([]);
			expect(plan?.quirks).toEqual([
				{ configId: "mode", readWriteValue: "bypassPermissions", readOnlyValue: "ask" },
			]);
			expect(
				quirkValue(
					plan?.quirks[0] as { configId: string; readWriteValue: string; readOnlyValue: string },
					"readWrite",
				),
			).toBe("bypassPermissions");
			expect(
				quirkValue(
					plan?.quirks[0] as { configId: string; readWriteValue: string; readOnlyValue: string },
					"readOnly",
				),
			).toBe("ask");
		} finally {
			await session.close();
		}
	});

	test("a readWrite session switches to readOnly and back, keeping sessionId, model and config", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-acp-"));
		const storeFile = join(dir, "store.json");
		writeFileSync(storeFile, JSON.stringify({ counter: 0, sessions: {} }));
		const session = await start(["--config-options", "--session-store", storeFile], "readWrite");
		try {
			const id = session.sessionId;
			const model = session.model;
			const down = planAccessSwitch(session, "readOnly");
			await switchAccess(session, "readOnly", down);
			expect(session.access).toBe("readOnly");
			const up = planAccessSwitch(session, "readWrite");
			await switchAccess(session, "readWrite", up);
			expect(session.access).toBe("readWrite");
			expect(session.sessionId).toBe(id);
			expect(session.model).toBe(model);
			expect(session.configOptions.some((o) => o.category === "model")).toBe(true);
		} finally {
			await session.close();
		}
	});

	test("an unsupported resume throws before cancelling or prompting", async () => {
		const session = await start(["--unsupported-resume"], "readOnly");
		const seen: string[] = [];
		const draining = (async (): Promise<void> => {
			for await (const event of session.events()) {
				seen.push(event.type);
			}
		})();
		const turnId = session.prompt("HOLD_FOREVER");
		await expect(
			switchAccess(session, "readWrite", planAccessSwitch(session, "readWrite"), { resume: false }),
		).rejects.toThrow(AccessSwitchUnsupported);
		expect(session.openTurnId).toBe(turnId);
		for (let i = 0; i < 100 && seen.length === 0; i++) {
			await Bun.sleep(10);
		}
		expect(seen).toEqual(["turn"]);
		await session.cancel();
		await session.close();
		await draining;
	});

	test("an upgrade without the plan throws", async () => {
		const session = await start([], "readOnly");
		try {
			await expect(switchAccess(session, "readWrite")).rejects.toThrow(AccessSwitchUnsupported);
			expect(session.access).toBe("readOnly");
		} finally {
			await session.close();
		}
	});
});
