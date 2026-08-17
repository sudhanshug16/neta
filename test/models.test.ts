import { describe, expect, it } from "bun:test";
import { selectableBackendModels } from "../src/models.ts";
import { NetaConfig } from "../src/settings.ts";

describe("selectableBackendModels", () => {
	it("hides Fable only from Claude selection output", () => {
		const models = ["haiku", "opus[1m]", "fable", "claude-fable-5[1m]", "fablefish"];

		expect(selectableBackendModels(true, models)).toEqual(["haiku", "opus[1m]", "fablefish"]);
		expect(selectableBackendModels(false, models)).toEqual(models);
	});

	it("hides Fable for a custom Claude alias while leaving OpenCode unchanged", () => {
		const config = new NetaConfig({
			backends: {
				"review-primary": {
					command: "npx",
					args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
				},
			},
		});
		const models = ["opus[1m]", "anthropic/claude-fable-5-20260817-v1", "fablefish"];

		expect(selectableBackendModels(config.isClaudeBackend("review-primary"), models)).toEqual([
			"opus[1m]",
			"fablefish",
		]);
		expect(selectableBackendModels(config.isClaudeBackend("opencode"), models)).toEqual(models);
	});
});
