import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { spawnProvider } from "../src/acp/process.ts";
import type { ProviderSettings } from "../src/acp/settings.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;

function fixtureProvider(extraArgs: string[] = []): ProviderSettings {
	return {
		command: process.execPath,
		args: [FIXTURE, ...extraArgs],
		resume: true,
		defaultModel: "",
	};
}

const HANDLERS = {
	onSessionUpdate: (): void => undefined,
	requestPermission: async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "cancelled" } }),
};

describe("provider process", () => {
	test("the fixture completes initialize and reports its agent name", async () => {
		const proc = await spawnProvider({
			provider: fixtureProvider(),
			access: "readOnly",
			cwd: mkdtempSync(`${tmpdir()}/neta-acp-`),
			handlers: HANDLERS,
		});
		expect(proc.initialize.agentInfo?.name).toBe("fake-acp-agent");
		expect(proc.pid).toBeGreaterThan(0);
		const exit = await proc.kill();
		expect(exit.signal).toBe("SIGTERM");
		expect(await proc.exited).toEqual(exit);
		// kill() is safe to call twice.
		expect(await proc.kill()).toEqual(exit);
	});

	test("TRAP_SIGTERM is ended only by the SIGKILL escalation", async () => {
		const proc = await spawnProvider({
			provider: fixtureProvider(),
			access: "readWrite",
			cwd: mkdtempSync(`${tmpdir()}/neta-acp-`),
			handlers: HANDLERS,
		});
		const created = await proc.connection.agent.request("session/new", {
			cwd: mkdtempSync(`${tmpdir()}/neta-acp-`),
			mcpServers: [],
		});
		await proc.connection.agent.request("session/prompt", {
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "TRAP_SIGTERM" }],
		});
		const exit = await proc.kill();
		expect(exit.signal).toBe("SIGKILL");
	}, 15000);

	test("a missing command rejects with the stderr tail", async () => {
		const missing: ProviderSettings = {
			command: "neta-definitely-missing-binary",
			args: [],
			resume: false,
			defaultModel: "",
		};
		await expect(
			spawnProvider({ provider: missing, access: "readOnly", cwd: tmpdir(), handlers: HANDLERS }),
		).rejects.toThrow("neta-definitely-missing-binary");
	});
});
