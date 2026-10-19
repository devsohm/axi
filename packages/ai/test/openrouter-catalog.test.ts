import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { fetchCatalog } from "../scripts/catalog-sources.ts";
import { personalizeOpenRouterCatalog } from "../src/providers/openrouter.ts";
import type { OpenRouterModel, OpenRouterPricing } from "../src/providers/openrouter-api.ts";
import type { Model } from "../src/types.ts";

afterEach(() => vi.restoreAllMocks());

it("exports the optional model limits and pricing contract", () => {
	expectTypeOf<OpenRouterModel>().toEqualTypeOf<{
		id: string;
		context_length?: number | null;
		top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
		pricing?: OpenRouterPricing;
	}>();
	expectTypeOf<OpenRouterPricing["overrides"]>().toEqualTypeOf<
		| {
				min_prompt_tokens?: number;
				utc_start?: number;
				utc_end?: number;
				utc_days?: string[];
				prompt?: string;
				completion?: string;
				input_cache_read?: string;
				input_cache_write?: string;
		  }[]
		| undefined
	>();
});

it("generates a catalog without discarding models with nullable pricing metadata", async () => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		if (String(url).startsWith("https://openrouter.ai/"))
			return Response.json({
				data: [
					{
						id: "listed",
						name: "Listed",
						supported_parameters: ["tools"],
						pricing: { prompt: "0.000003", overrides: [{ min_prompt_tokens: 100, utc_start: null }] },
					},
				],
			});
		if (String(url).startsWith("https://models.dev/"))
			return Response.json({ "typesafe/jev-latest": { type: "decision", name: "Classifier" } });
		return Response.json({ data: [] });
	});
	const catalog = await fetchCatalog({}, false);
	expect(catalog.openrouter?.find((model) => model.id === "listed")?.cost).toEqual({
		input: 3,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

it.each([
	{ fields: { top_provider: null }, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
	{ fields: { pricing: null }, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
	{
		fields: { pricing: { prompt: "0.000003", overrides: null } },
		cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		fields: { pricing: { prompt: "0.000003", overrides: [{ min_prompt_tokens: 100, utc_start: null }] } },
		cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
])("keeps catalog models with nullable optional metadata $fields", async ({ fields, cost }) => {
	const model: Model<"openai-completions"> = {
		id: "listed",
		name: "Listed",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 50000,
	};
	vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ id: "listed", ...fields }] }));
	const models = await personalizeOpenRouterCatalog([model], {
		credential: { type: "api_key", key: "fixture" },
		publish: async () => true,
		allowNetwork: true,
		signal: new AbortController().signal,
	});
	expect(models).toStrictEqual([{ ...model, cost }]);
});
