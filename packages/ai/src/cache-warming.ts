import { calculateCost } from "./models.ts";
import type { Api, Model, SimpleStreamOptions, Usage } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

export type CacheWarmingAction = "warm" | "stop";
export type CacheWarmingPhase = "streaming" | "idle";

export interface CacheWarmingDecision {
	phase: CacheWarmingPhase;
	warmCost: number;
	missCost: number;
	continuationProbability: number;
	expectedSavings: number;
	economicsAvailable: boolean;
	action: CacheWarmingAction;
}

export const CACHE_WARMING_MAX_AGE_MS = 3_600_000;
export const CACHE_WARMING_MAX_IDLE_AGE_MS = 1_800_000;
export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
export const CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY = 0.15;

export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	const retention =
		options?.cacheRetention ?? (getProviderEnvValue("AXI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short");
	if (retention === "none") return undefined;
	const lifetime = model.promptCache?.[retention];
	return lifetime === undefined ? undefined : lifetime * 1000;
}

export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	const deadline = Math.min(ttlMs * 0.9, ttlMs - 10_000);
	return Math.max(1, Math.floor(deadline));
}

export function isCacheWarmingReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (!options?.reasoning || model.api !== "anthropic-messages") return true;
	const compat = model.compat;
	return compat != null && "forceAdaptiveThinking" in compat && compat.forceAdaptiveThinking === true;
}

export function getCacheWarmingRequestOptions<T extends SimpleStreamOptions>(options: T, signal: AbortSignal): T {
	return { ...options, maxTokens: 1, maxRetries: 0, disableContinuation: true, signal };
}

export function evaluateCacheWarming(
	model: Model<Api>,
	promptTokens: number,
	phase: CacheWarmingPhase,
): CacheWarmingDecision {
	const hit = tokenCost(model, { cacheRead: promptTokens });
	const miss = tokenCost(model, model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens });
	const warmCost = tokenCost(model, { cacheRead: promptTokens, output: 1 });
	const missCost = Math.max(0, miss - hit);
	const continuationProbability = phase === "idle" ? CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY : 1;
	const expectedSavings = continuationProbability * missCost - warmCost;
	return {
		phase,
		warmCost,
		missCost,
		continuationProbability,
		expectedSavings,
		economicsAvailable: promptTokens > 0 && (hit > 0 || miss > 0),
		action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
	};
}

function tokenCost(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	return calculateCost(model, {
		input: tokens.input ?? 0,
		output: tokens.output ?? 0,
		cacheRead: tokens.cacheRead ?? 0,
		cacheWrite: tokens.cacheWrite ?? 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}).total;
}
