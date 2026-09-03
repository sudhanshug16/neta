import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { ForbiddenModelError, modelStateFrom, planModel, UnknownModelError } from "../src/acp/models.ts";
import { spawnProvider } from "../src/acp/process.ts";
import type { ProviderSettings } from "../src/acp/settings.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;

const HANDLERS = {
	onSessionUpdate: (): void => undefined,
	requestPermission: async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "cancelled" } }),
};

async function newResponse(extraArgs: string[]): Promise<unknown> {
	const provider: ProviderSettings = {
		command: process.execPath,
		args: [FIXTURE, ...extraArgs],
		resume: true,
		defaultModel: "",
	};
	const proc = await spawnProvider({
		provider,
		access: "readOnly",
		cwd: mkdtempSync(`${tmpdir()}/neta-acp-`),
		handlers: HANDLERS,
	});
	try {
		return await proc.connection.agent.request("session/new", {
			cwd: mkdtempSync(`${tmpdir()}/neta-acp-`),
			mcpServers: [],
		});
	} finally {
		await proc.kill();
	}
}

describe("model negotiation", () => {
	test("the plain fixture gives legacy with test-model current", async () => {
		const state = modelStateFrom(await newResponse([]));
		expect(state.source).toBe("legacy");
		expect(state.current).toBe("test-model");
		expect(state.options.map((o) => o.id)).toContain("test-model");
		expect(planModel(state, undefined, [])).toEqual({ model: "test-model" });
	});

	test("--config-options gives config", async () => {
		const state = modelStateFrom(await newResponse(["--config-options"]));
		expect(state.source).toBe("config");
		expect(state.configId).toBe("model");
		const plan = planModel(state, "fixture-fast", []);
		expect(plan).toEqual({
			model: "fixture-fast",
			call: { method: "session/set_config_option", params: { configId: "model", value: "fixture-fast" } },
		});
	});

	test("--bare gives none", async () => {
		const state = modelStateFrom(await newResponse(["--bare"]));
		expect(state).toEqual({ source: "none", options: [] });
		expect(planModel(state, "whatever", [])).toEqual({});
	});

	test("a forbidden current plans a switch to the first allowed option", async () => {
		const state = modelStateFrom(await newResponse(["--claude-fable-default"]));
		expect(state.source).toBe("config");
		expect(state.current).toBe("claude-fable-5");
		const plan = planModel(state, undefined, ["claude-fable-5"]);
		expect(plan.model).toBe("haiku");
		expect(plan.call).toEqual({
			method: "session/set_config_option",
			params: { configId: "model", value: "haiku" },
		});
	});

	test("forbidden and unknown requests throw", () => {
		const state = modelStateFrom({
			models: { availableModels: [{ modelId: "a" }, { modelId: "b" }], currentModelId: "a" },
		});
		expect(() => planModel(state, "banned", ["banned"])).toThrow(ForbiddenModelError);
		expect(() => planModel(state, "zzz", [])).toThrow(UnknownModelError);
		try {
			planModel(state, "zzz", []);
		} catch (error) {
			expect((error as UnknownModelError).options.map((o) => o.id)).toEqual(["a", "b"]);
		}
		expect(planModel(state, "b", [])).toEqual({
			model: "b",
			call: { method: "session/set_model", params: { modelId: "b" } },
		});
		expect(() => planModel({ source: "legacy", current: "a", options: [] }, undefined, ["a"])).toThrow(
			ForbiddenModelError,
		);
	});
});
