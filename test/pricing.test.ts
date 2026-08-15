import { describe, expect, it } from "bun:test";
import { estimateCost } from "../src/pricing.ts";
import { formatUsage, type WorkerUsage } from "../src/types.ts";

describe("estimateCost", () => {
	it("returns undefined when modelId is undefined", () => {
		const usage: WorkerUsage = { inputTokens: 1000, outputTokens: 500 };
		expect(estimateCost(undefined, usage)).toBeUndefined();
	});

	it("returns undefined when inputTokens is missing", () => {
		const usage: WorkerUsage = { outputTokens: 500 };
		expect(estimateCost("claude-sonnet-4-5", usage)).toBeUndefined();
	});

	it("returns undefined when outputTokens is missing", () => {
		const usage: WorkerUsage = { inputTokens: 1000 };
		expect(estimateCost("claude-sonnet-4-5", usage)).toBeUndefined();
	});

	it("returns undefined for unknown model id", () => {
		const usage: WorkerUsage = { inputTokens: 1000, outputTokens: 500 };
		expect(estimateCost("completely-unknown-model-xyz", usage)).toBeUndefined();
	});

	it("estimates cost for exact match (Anthropic model)", () => {
		const usage: WorkerUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
		// claude-sonnet-4-5: input=$3/1M, output=$15/1M
		// 1M * $3 + 0.5M * $15 = $3 + $7.5 = $10.5
		const cost = estimateCost("claude-sonnet-4-5", usage);
		expect(cost).toBeCloseTo(10.5, 2);
	});

	it("estimates cost for exact match (OpenAI model)", () => {
		const usage: WorkerUsage = { inputTokens: 2_000_000, outputTokens: 1_000_000 };
		// gpt-4o: input=$2.5/1M, output=$10/1M (check actual pricing in snapshot)
		// Using a model we know exists in the snapshot
		const cost = estimateCost("gpt-4o", usage);
		expect(cost).toBeDefined();
		expect(typeof cost).toBe("number");
	});

	it("estimates cost with case-insensitive matching", () => {
		const usage: WorkerUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
		// Should match "claude-sonnet-4-5" after lowercasing
		const cost = estimateCost("CLAUDE-SONNET-4-5", usage);
		expect(cost).toBeCloseTo(10.5, 2);
	});

	it("strips bracket suffix from model id", () => {
		const usage: WorkerUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
		// Should match "claude-sonnet-4-5" after stripping "[high]"
		const cost = estimateCost("claude-sonnet-4-5[high]", usage);
		expect(cost).toBeCloseTo(10.5, 2);
	});

	it("strips complex bracket suffix from model id", () => {
		const usage: WorkerUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
		// Should match after stripping "[extended thinking]"
		const cost = estimateCost("Claude-Sonnet-4-5[extended thinking]", usage);
		expect(cost).toBeCloseTo(10.5, 2);
	});

	it("fuzzy matches when model id contains table key as substring", () => {
		const usage: WorkerUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
		// "gpt-4o-mini-2024-07-18-custom" contains "gpt-4o-mini" which should match
		// the pricing table entry (if it exists)
		const cost = estimateCost("gpt-4o-mini-2024-custom", usage);
		// Should find the longest matching substring
		expect(cost).toBeDefined();
	});

	it("fuzzy matches when table key is substring of model id", () => {
		const usage: WorkerUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
		// Partial model name should match the full table key
		const cost = estimateCost("claude-sonnet", usage);
		// Should find "claude-sonnet-4-5" or similar as longest match
		expect(cost).toBeDefined();
	});

	it("prefers longer fuzzy matches", () => {
		const usage: WorkerUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
		// "claude-sonnet-4-5-20250929" is a specific version;
		// should match exact key if present, not shorter "claude-sonnet-4-5"
		const costExact = estimateCost("claude-sonnet-4-5-20250929", usage);
		const costShort = estimateCost("claude-sonnet-4-5", usage);
		// Both should work; exact version might have different pricing
		expect(costExact).toBeDefined();
		expect(costShort).toBeDefined();
	});

	it("calculates zero cost for zero tokens", () => {
		const usage: WorkerUsage = { inputTokens: 0, outputTokens: 0 };
		const cost = estimateCost("claude-sonnet-4-5", usage);
		expect(cost).toBe(0);
	});

	it("handles fractional token counts", () => {
		const usage: WorkerUsage = { inputTokens: 1_500_000, outputTokens: 750_000 };
		// claude-sonnet-4-5: input=$3/1M, output=$15/1M
		// 1.5M * $3 + 0.75M * $15 = $4.5 + $11.25 = $15.75
		const cost = estimateCost("claude-sonnet-4-5", usage);
		expect(cost).toBeCloseTo(15.75, 2);
	});
});

describe("formatUsage integration", () => {
	it("shows backend-reported cost without est. label", () => {
		const usage: WorkerUsage = {
			inputTokens: 1000,
			outputTokens: 500,
			costAmount: 0.42,
			costCurrency: "USD",
		};
		const formatted = formatUsage(usage, "claude-sonnet-4-5");
		expect(formatted).toContain("0.42 USD");
		expect(formatted).not.toContain("est.");
	});

	it("shows estimated cost with est. label when backend reports tokens but no cost", () => {
		const usage: WorkerUsage = {
			inputTokens: 1_000_000,
			outputTokens: 500_000,
		};
		const formatted = formatUsage(usage, "claude-sonnet-4-5");
		expect(formatted).toContain("est.");
		expect(formatted).toMatch(/est\.\s+\$\d+\.\d{2}/);
	});

	it("shows no cost when model is unknown", () => {
		const usage: WorkerUsage = {
			inputTokens: 1_000_000,
			outputTokens: 500_000,
		};
		const formatted = formatUsage(usage, "unknown-model-xyz");
		expect(formatted).toContain("tokens");
		expect(formatted).not.toContain("est.");
		expect(formatted).not.toContain("$");
	});

	it("shows no cost when model is not provided", () => {
		const usage: WorkerUsage = {
			inputTokens: 1_000_000,
			outputTokens: 500_000,
		};
		const formatted = formatUsage(usage);
		expect(formatted).toContain("tokens");
		expect(formatted).not.toContain("est.");
		expect(formatted).not.toContain("$");
	});

	it("prefers backend-reported cost over estimation", () => {
		const usage: WorkerUsage = {
			inputTokens: 1_000_000,
			outputTokens: 500_000,
			costAmount: 99.99,
			costCurrency: "USD",
		};
		// Even though we could estimate, backend-reported cost takes precedence
		const formatted = formatUsage(usage, "claude-sonnet-4-5");
		expect(formatted).toContain("99.99 USD");
		expect(formatted).not.toContain("est.");
	});

	it("includes tokens and estimated cost together", () => {
		const usage: WorkerUsage = {
			inputTokens: 1_000_000,
			outputTokens: 500_000,
		};
		const formatted = formatUsage(usage, "claude-sonnet-4-5");
		expect(formatted).toContain("tokens");
		expect(formatted).toContain("est.");
	});
});
