import { describe, expect, it } from "bun:test";
import { buildPricingSnapshot } from "../scripts/refresh-pricing.ts";

describe("refresh-pricing generator", () => {
	it("pins historical Fable pricing when the live feed omits it", () => {
		const generated = buildPricingSnapshot({
			anthropic: {
				models: { "claude-opus-5": { cost: { input: 5, output: 25 } } },
			},
			openai: {
				models: { "gpt-5.6": { cost: { input: 5, output: 30 } } },
			},
		});

		expect(generated.anthropic["claude-fable-5"]).toEqual({ input: 10, output: 50 });
		expect(generated.anthropic["claude-opus-5"]).toEqual({ input: 5, output: 25 });
	});

	it("does not let live data rewrite the historical Fable price", () => {
		const generated = buildPricingSnapshot({
			anthropic: {
				models: { "claude-fable-5": { cost: { input: 999, output: 999 } } },
			},
		});

		expect(generated.anthropic["claude-fable-5"]).toEqual({ input: 10, output: 50 });
	});
});
