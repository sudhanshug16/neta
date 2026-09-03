import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSession, TurnInProgressError } from "../src/acp/session.ts";
import type { ProviderSettings } from "../src/acp/settings.ts";
import { steerProvider } from "../src/acp/steer.ts";

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

async function startWithStore() {
	const dir = mkdtempSync(join(tmpdir(), "neta-acp-"));
	const storeFile = join(dir, "store.json");
	writeFileSync(storeFile, JSON.stringify({ counter: 0, sessions: {} }));
	return startSession({
		settings: settingsFor(["--session-store", storeFile]),
		provider: "fake",
		access: "readWrite",
		cwd: mkdtempSync(join(tmpdir(), "neta-acp-")),
	});
}

async function historyOf(session: Awaited<ReturnType<typeof startWithStore>>): Promise<string[]> {
	return new Promise<string[]>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no history reply")), 5000);
		void (async (): Promise<void> => {
			for await (const event of session.events()) {
				if (event.type === "block" && event.block.kind === "text" && event.block.text.startsWith("[")) {
					clearTimeout(timer);
					resolve(JSON.parse(event.block.text) as string[]);
					return;
				}
			}
		})();
		session.prompt("HISTORY");
	});
}

describe("steerProvider", () => {
	test("builds the prompt text exactly", async () => {
		const session = await startWithStore();
		try {
			const leader = steerProvider(session, { kind: "leader" }, "hello");
			await leader.settled;
			const agentId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
			const agent = steerProvider(
				session,
				{ kind: "mission", missionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW", agentId },
				"do it",
			);
			await agent.settled;
			const history = await historyOf(session);
			expect(history[0]).toBe("<role>steer</role>\n<target>leader</target>\n<body>hello</body>");
			expect(history[1]).toBe(`<role>steer</role>\n<target>agent ${agentId}</target>\n<body>do it</body>`);
		} finally {
			await session.close();
		}
	});

	test("a second steer mid-turn throws TurnInProgressError", async () => {
		const session = await startWithStore();
		try {
			const first = steerProvider(session, { kind: "leader" }, "HOLD_FOREVER");
			expect(() => steerProvider(session, { kind: "leader" }, "again")).toThrow(TurnInProgressError);
			await first.cancel();
			await first.settled;
		} finally {
			await session.close();
		}
	});

	test("cancel ends the steered turn", async () => {
		const session = await startWithStore();
		try {
			const handle = steerProvider(session, { kind: "leader" }, "HOLD_FOREVER");
			await handle.cancel();
			await handle.settled;
			expect(session.openTurnId).toBeUndefined();
		} finally {
			await session.close();
		}
	});
});
