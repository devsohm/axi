import type { ModelCost, ModelCostRates, ModelCostTier } from "../types.ts";

export interface OpenRouterPricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	overrides?: OpenRouterPricingOverride[];
}
export interface OpenRouterPricingOverride {
	min_prompt_tokens?: number;
	utc_start?: number;
	utc_end?: number;
	utc_days?: string[];
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}
export interface OpenRouterModel {
	id: string;
	context_length?: number | null;
	top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
	pricing?: OpenRouterPricing;
}

function rate(value: string | undefined, fallback: number): number {
	const parsed = Number.parseFloat(value ?? "");
	return parsed >= 0 ? Number((parsed * 1000000).toFixed(6)) : fallback;
}
function costs(pricing: OpenRouterPricing | undefined, fallback: ModelCostRates): ModelCostRates {
	return {
		input: rate(pricing?.prompt, fallback.input),
		output: rate(pricing?.completion, fallback.output),
		cacheRead: rate(pricing?.input_cache_read, fallback.cacheRead),
		cacheWrite: rate(pricing?.input_cache_write, fallback.cacheWrite),
	};
}
export function openRouterCost(pricing: OpenRouterPricing | undefined): ModelCost {
	const base = costs(pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	const tiers: ModelCostTier[] = [];
	for (const row of pricing?.overrides ?? []) {
		if (
			row.min_prompt_tokens !== undefined &&
			row.utc_start === undefined &&
			row.utc_end === undefined &&
			row.utc_days === undefined
		)
			tiers.push({ inputTokensAbove: row.min_prompt_tokens, ...costs(row, base) });
	}
	return tiers.length ? { ...base, tiers } : base;
}
