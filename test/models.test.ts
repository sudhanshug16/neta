import { describe, expect, it } from "bun:test";
import { selectableBackendModels } from "../src/models.ts";

describe("selectableBackendModels", () => {
	it("hides Fable only from Claude selection output", () => {
		const models = ["haiku", "opus[1m]", "fable", "claude-fable-5[1m]", "fablefish"];

		expect(selectableBackendModels("claude", models)).toEqual(["haiku", "opus[1m]", "fablefish"]);
		expect(selectableBackendModels("opencode", models)).toEqual(models);
	});
});
