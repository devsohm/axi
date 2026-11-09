import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import {
	CACHE_WARMING_MAX_AGE_MS,
	CACHE_WARMING_MAX_IDLE_AGE_MS,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	getCacheWarmingRequestOptions,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type CacheWarmingPhase,
	type Model,
	type SimpleStreamOptions,
} from "../src/index.ts";

afterEach(() => vi.unstubAllEnvs());

function model(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "cache-fixture",
		name: "Cache fixture",
		provider: "fixture",
		api: "anthropic-messages",
		baseUrl: "https://fixture.invalid",
		input: ["text"],
		reasoning: true,
		contextWindow: 2_000_000,
		maxTokens: 4096,
		promptCache: { short: 300, long: 3600 },
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		...overrides,
	};
}

test("retention resolves request settings before environment settings and uses the selected lifetime", () => {
	vi.stubEnv("AXI_CACHE_RETENTION", "long");
	const priced = model();
	expect(getPromptCacheTtlMs(priced, undefined)).toBe(3_600_000);
	expect(getPromptCacheTtlMs(priced, { cacheRetention: "short" })).toBe(300_000);
	expect(getPromptCacheTtlMs(priced, { cacheRetention: "none" })).toBeUndefined();
	expect(getPromptCacheTtlMs(priced, { env: { AXI_CACHE_RETENTION: "short" } })).toBe(300_000);
	expect(getPromptCacheTtlMs(priced, { env: { AXI_CACHE_RETENTION: "" } })).toBe(3_600_000);
	vi.stubEnv("AXI_CACHE_RETENTION", "");
	expect(getPromptCacheTtlMs(priced, undefined)).toBe(300_000);
	expect(getPromptCacheTtlMs(priced, { env: { AXI_CACHE_RETENTION: "long" } })).toBe(3_600_000);
	expect(getPromptCacheTtlMs(priced, { cacheRetention: "short", env: { AXI_CACHE_RETENTION: "long" } })).toBe(300_000);
	expect(getPromptCacheTtlMs(model({ promptCache: { short: 0.5 } }), { cacheRetention: "long" })).toBeUndefined();
	expect(getPromptCacheTtlMs(model({ promptCache: { short: 0.5 } }), undefined)).toBe(500);
	expect(getPromptCacheTtlMs(model({ promptCache: undefined }), undefined)).toBeUndefined();
});

test("refresh timing keeps a ten-second margin and remains inside the streaming and idle horizons", () => {
	expect([-1, 0, 10_000, 10_000.5, 30_000, 60_000, 300_000, 3_600_000].map(getCacheWarmingDelayMs)).toEqual([
		undefined,
		undefined,
		undefined,
		1,
		20_000,
		50_000,
		270_000,
		3_240_000,
	]);
	expect(CACHE_WARMING_MAX_AGE_MS).toBe(3_600_000);
	expect(CACHE_WARMING_MAX_IDLE_AGE_MS).toBe(1_800_000);
});

test("budget-based Anthropic thinking cannot be safely replayed with a one-token cap", () => {
	expect(isCacheWarmingReplayable(model(), undefined)).toBe(true);
	expect(isCacheWarmingReplayable(model(), { reasoning: "medium" })).toBe(false);
	expect(isCacheWarmingReplayable(model({ compat: { forceAdaptiveThinking: false } }), { reasoning: "high" })).toBe(
		false,
	);
	expect(isCacheWarmingReplayable(model({ compat: { forceAdaptiveThinking: true } }), { reasoning: "high" })).toBe(
		true,
	);
	const responses: Model<"openai-responses"> = { ...model(), api: "openai-responses", compat: undefined };
	expect(isCacheWarmingReplayable(responses, { reasoning: "high" })).toBe(true);
});

test("warming overrides only output, retry, continuation and cancellation settings without mutating the request", () => {
	const previous = new AbortController();
	const controller = new AbortController();
	const original = Object.freeze({
		maxTokens: 2048,
		maxRetries: 3,
		disableContinuation: false,
		signal: previous.signal,
		sessionId: "session",
		reasoning: "medium",
		metadata: { tag: "original" },
		custom: "retained",
	} satisfies SimpleStreamOptions & { custom: string });
	const replay = getCacheWarmingRequestOptions(original, controller.signal);
	expectTypeOf(replay).toEqualTypeOf<typeof original>();
	expect(replay).toEqual({
		...original,
		maxTokens: 1,
		maxRetries: 0,
		disableContinuation: true,
		signal: controller.signal,
	});
	expect(replay).not.toBe(original);
	expect(replay.metadata).toBe(original.metadata);
	expect(original).toMatchObject({
		maxTokens: 2048,
		maxRetries: 3,
		disableContinuation: false,
		signal: previous.signal,
	});
	controller.abort();
	expect(replay.signal.aborted).toBe(true);
	expect(original.signal.aborted).toBe(false);
});

test.each([
	{
		tokens: 1_000_000,
		phase: "streaming",
		warmCost: 0.300015,
		missCost: 3.45,
		probability: 1,
		savings: 3.149985,
		action: "warm",
	},
	{
		tokens: 1_000_000,
		phase: "idle",
		warmCost: 0.300015,
		missCost: 3.45,
		probability: 0.15,
		savings: 0.217485,
		action: "warm",
	},
	{
		tokens: 80_000,
		phase: "idle",
		warmCost: 0.024015,
		missCost: 0.276,
		probability: 0.15,
		savings: 0.017385,
		action: "stop",
	},
	{
		tokens: 10_000,
		phase: "streaming",
		warmCost: 0.003015,
		missCost: 0.0345,
		probability: 1,
		savings: 0.031485,
		action: "stop",
	},
] satisfies {
	tokens: number;
	phase: CacheWarmingPhase;
	warmCost: number;
	missCost: number;
	probability: number;
	savings: number;
	action: string;
}[])(
	"accounts for $phase continuation at $tokens prompt tokens",
	({ tokens, phase, warmCost, missCost, probability, savings, action }) => {
		const decision = evaluateCacheWarming(model(), tokens, phase);
		expect(decision).toMatchObject({ phase, continuationProbability: probability, economicsAvailable: true, action });
		expect(decision.warmCost).toBeCloseTo(warmCost, 10);
		expect(decision.missCost).toBeCloseTo(missCost, 10);
		expect(decision.expectedSavings).toBeCloseTo(savings, 10);
	},
);

test("falls back to input pricing, respects tier boundaries and never charges a negative cache miss", () => {
	const fallback = evaluateCacheWarming(
		model({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } }),
		1_000_000,
		"streaming",
	);
	expect(fallback.missCost).toBeCloseTo(2.7, 10);
	expect(fallback.expectedSavings).toBeCloseTo(2.399985, 10);
	const expensiveHit = evaluateCacheWarming(
		model({ cost: { input: 3, output: 15, cacheRead: 4, cacheWrite: 3 } }),
		1_000_000,
		"streaming",
	);
	expect(expensiveHit.missCost).toBe(0);
	expect(expensiveHit.action).toBe("stop");
	const tiered = model({
		cost: {
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
			tiers: [{ inputTokensAbove: 100_000, input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 }],
		},
	});
	expect(evaluateCacheWarming(tiered, 100_000, "streaming").warmCost).toBeCloseTo(0.030015, 10);
	expect(evaluateCacheWarming(tiered, 100_001, "streaming").warmCost).toBeCloseTo(0.0600306, 10);
});

test("reports missing economics and applies the inclusive five-cent threshold", () => {
	expect(evaluateCacheWarming(model(), 0, "streaming")).toMatchObject({
		economicsAvailable: false,
		action: "stop",
		missCost: 0,
	});
	const free = model({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	expect(evaluateCacheWarming(free, 100_000, "idle")).toMatchObject({
		economicsAvailable: false,
		action: "stop",
		expectedSavings: 0,
	});
	const boundary = model({ cost: { input: 0.05, output: 0, cacheRead: 0, cacheWrite: 0 } });
	expect(evaluateCacheWarming(boundary, 1_000_000, "streaming")).toMatchObject({
		expectedSavings: 0.05,
		action: "warm",
	});
	expect(evaluateCacheWarming(boundary, 999_999, "streaming").action).toBe("stop");
});
