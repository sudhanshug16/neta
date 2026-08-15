/**
 * Worker cost estimation from bundled pricing snapshot.
 */

import { PRICING_SNAPSHOT } from "./pricing-snapshot.ts";
import type { WorkerUsage } from "./types.ts";

/**
 * Estimates the cost of a worker's usage when the backend reports token counts
 * but no cost.
 *
 * @param modelId - The model identifier from WorkerSummary
 * @param usage - Token usage reported by the backend
 * @returns Estimated cost in USD, or undefined if estimation is not possible
 */
export function estimateCost(modelId: string | undefined, usage: WorkerUsage): number | undefined {
	if (!modelId) return undefined;
	if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;

	// Normalize: lowercase and strip bracket suffixes like "[high]"
	const normalized = modelId.toLowerCase().replace(/\[[^\]]+\]$/, "");

	// Look up pricing across both providers
	const allPricing: Record<string, { input: number; output: number }> = {
		...PRICING_SNAPSHOT.anthropic,
		...PRICING_SNAPSHOT.openai,
	};

	// 1. Try exact match
	let pricing = allPricing[normalized];
	if (pricing) {
		return (pricing.input * usage.inputTokens + pricing.output * usage.outputTokens) / 1e6;
	}

	// 2. Fuzzy match: find the longest key that is a substring of normalized,
	//    or of which normalized is a substring
	let bestMatch: string | undefined;
	let bestMatchLength = 0;

	for (const key of Object.keys(allPricing)) {
		if (normalized.includes(key) || key.includes(normalized)) {
			if (key.length > bestMatchLength) {
				bestMatch = key;
				bestMatchLength = key.length;
			}
		}
	}

	if (bestMatch) {
		pricing = allPricing[bestMatch];
		return (pricing.input * usage.inputTokens + pricing.output * usage.outputTokens) / 1e6;
	}

	return undefined;
}
