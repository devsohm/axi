import type { ModelCost, ModelCostRates, ModelCostTier } from "../src/types.ts";
export interface AiGatewayPriceTier {
	cost?: string | number;
	min?: number;
	max?: number;
}
export interface AiGatewayPricing {
	input?: string | number;
	output?: string | number;
	input_cache_read?: string | number;
	input_cache_write?: string | number;
	input_tiers?: AiGatewayPriceTier[];
	output_tiers?: AiGatewayPriceTier[];
	input_cache_read_tiers?: AiGatewayPriceTier[];
	input_cache_write_tiers?: AiGatewayPriceTier[];
}
const fields = {
	input: "input_tiers",
	output: "output_tiers",
	cacheRead: "input_cache_read_tiers",
	cacheWrite: "input_cache_write_tiers",
} as const;
function rate(value: string | number | undefined): number {
	const number = typeof value === "number" ? value : Number.parseFloat(value ?? "0");
	return Number.isFinite(number) ? Number((number * 1000000).toFixed(6)) : 0;
}
export function getAiGatewayCost(pricing: AiGatewayPricing | undefined): ModelCost {
	const base: ModelCostRates = {
		input: rate(pricing?.input),
		output: rate(pricing?.output),
		cacheRead: rate(pricing?.input_cache_read),
		cacheWrite: rate(pricing?.input_cache_write),
	};
	const starts = new Set<number>();
	for (const name of Object.values(fields))
		for (const row of pricing?.[name] ?? []) if (row.min !== undefined && row.min > 0) starts.add(row.min);
	const tiers = [...starts]
		.sort((a, b) => a - b)
		.map((start) => {
			const tier: ModelCostTier = { inputTokensAbove: start - 1, ...base };
			for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				const row = pricing?.[fields[field]]?.find(
					(row) => (row.min ?? 0) <= start && (row.max === undefined || row.max > start),
				);
				if (row?.cost !== undefined) tier[field] = rate(row.cost);
			}
			return tier;
		});
	return tiers.length ? { ...base, tiers } : base;
}
