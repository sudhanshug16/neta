#!/usr/bin/env bun
/**
 * Fetches pricing data from models.dev and generates a trimmed TypeScript snapshot
 * containing only Anthropic and OpenAI model pricing for input/output tokens.
 */

const MODELS_DEV_URL = "https://models.dev/api.json";
const OUTPUT_PATH = new URL("../src/pricing-snapshot.ts", import.meta.url).pathname;

interface ModelCost {
	input: number;
	output: number;
	cache_read?: number;
	cache_write?: number;
}

interface ModelEntry {
	cost?: ModelCost;
	[key: string]: unknown;
}

interface ProviderData {
	models?: Record<string, ModelEntry>;
	[key: string]: unknown;
}

interface ApiData {
	[provider: string]: ProviderData;
}

interface TrimmedProviderData {
	[modelId: string]: {
		input: number;
		output: number;
	};
}

interface TrimmedData {
	anthropic: TrimmedProviderData;
	openai: TrimmedProviderData;
}

async function main() {
	console.log(`Fetching pricing data from ${MODELS_DEV_URL}...`);
	const response = await fetch(MODELS_DEV_URL);
	if (!response.ok) {
		throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as ApiData;

	const trimmed: TrimmedData = {
		anthropic: {},
		openai: {},
	};

	for (const provider of ["anthropic", "openai"] as const) {
		const providerData = data[provider];
		if (!providerData?.models) {
			console.warn(`Provider ${provider} has no models data`);
			continue;
		}

		for (const [modelId, modelEntry] of Object.entries(providerData.models)) {
			const cost = modelEntry.cost;
			if (cost?.input !== undefined && cost?.output !== undefined) {
				trimmed[provider][modelId] = {
					input: cost.input,
					output: cost.output,
				};
			}
		}
	}

	const anthropicCount = Object.keys(trimmed.anthropic).length;
	const openaiCount = Object.keys(trimmed.openai).length;
	console.log(`Extracted ${anthropicCount} Anthropic models, ${openaiCount} OpenAI models`);

	const snapshotDate = new Date().toISOString().split("T")[0];
	const content = `/**
 * GENERATED FILE - DO NOT EDIT
 *
 * Pricing snapshot from ${MODELS_DEV_URL}
 * Generated on ${snapshotDate}
 *
 * Prices are per 1 million tokens in USD.
 */

export const PRICING_SNAPSHOT = ${JSON.stringify(trimmed, null, "\t")} as const;
`;

	await Bun.write(OUTPUT_PATH, content);
	console.log(`Wrote pricing snapshot to ${OUTPUT_PATH}`);
}

main().catch((error) => {
	console.error("Failed to refresh pricing:", error);
	process.exit(1);
});
