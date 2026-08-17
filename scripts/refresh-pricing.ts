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

export interface ApiData {
	[provider: string]: ProviderData;
}

interface TrimmedProviderData {
	[modelId: string]: {
		input: number;
		output: number;
	};
}

export interface TrimmedData {
	anthropic: TrimmedProviderData;
	openai: TrimmedProviderData;
}

/** Kept only so completed historical Fable runs retain an honest cost. */
const HISTORICAL_PRICING: TrimmedProviderData = {
	"claude-fable-5": { input: 10, output: 50 },
};

export function buildPricingSnapshot(data: ApiData): TrimmedData {
	const trimmed: TrimmedData = {
		anthropic: {},
		openai: {},
	};

	for (const provider of ["anthropic", "openai"] as const) {
		const providerData = data[provider];
		if (!providerData?.models) continue;
		for (const [modelId, modelEntry] of Object.entries(providerData.models)) {
			const cost = modelEntry.cost;
			if (cost?.input !== undefined && cost?.output !== undefined) {
				trimmed[provider][modelId] = { input: cost.input, output: cost.output };
			}
		}
	}

	Object.assign(trimmed.anthropic, HISTORICAL_PRICING);
	return trimmed;
}

async function main() {
	console.log(`Fetching pricing data from ${MODELS_DEV_URL}...`);
	const response = await fetch(MODELS_DEV_URL);
	if (!response.ok) {
		throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as ApiData;

	for (const provider of ["anthropic", "openai"] as const) {
		if (!data[provider]?.models) console.warn(`Provider ${provider} has no models data`);
	}
	const trimmed = buildPricingSnapshot(data);

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

if (import.meta.main) {
	main().catch((error) => {
		console.error("Failed to refresh pricing:", error);
		process.exit(1);
	});
}
