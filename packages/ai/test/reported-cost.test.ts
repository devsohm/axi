import { expect, it } from "vitest";
import { calculateCost } from "../src/models.ts";
import type { Model, Usage } from "../src/types.ts";
import { applyOpenRouterReportedCost, isOpenRouterModel } from "../src/utils/openrouter-cost.ts";

const model: Model<"test"> = {
	api: "test",
	id: "priced",
	name: "Priced",
	provider: "test",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	contextWindow: 100,
	maxTokens: 10,
	cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 3 },
};
function usage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0, total: 10 },
	};
}
it("recognizes the provider and custom endpoint independently", () => {
	expect([
		isOpenRouterModel({ provider: "openrouter", baseUrl: "" }),
		isOpenRouterModel({ provider: "private", baseUrl: "https://openrouter.ai/api/v1" }),
		isOpenRouterModel({ provider: "private", baseUrl: "https://example.test" }),
	]).toEqual([true, true, false]);
});
it.each([
	[{ cost: 0, is_byok: false }, 0],
	[{ cost: 0.2, is_byok: true, cost_details: { upstream_inference_cost: 0.3 } }, 0.5],
	[
		{
			cost: 0.2,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: null,
				upstream_inference_prompt_cost: 0.1,
				upstream_inference_completions_cost: 0.2,
				server_tool_cost: 9,
			},
		},
		0.5,
	],
])("uses complete billed accounting without replacing component estimates: %j", (reported, total) => {
	const value = usage();
	applyOpenRouterReportedCost(value, reported);
	expect(value.cost).toEqual({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0, total, totalFromProvider: true });
	calculateCost(model, value);
	expect(value.cost.totalFromProvider).toBe(false);
	expect(value.cost.total).toBeCloseTo(0.00001);
});
it.each([
	null,
	{},
	{ cost: -1, is_byok: false },
	{ cost: Infinity, is_byok: false },
	{ cost: NaN, is_byok: false },
	{ cost: "1", is_byok: false },
	{ cost: 1 },
	{ cost: 1, is_byok: true, cost_details: null },
	{
		cost: 1,
		is_byok: true,
		cost_details: {
			upstream_inference_cost: undefined,
			upstream_inference_prompt_cost: 1,
			upstream_inference_completions_cost: 2,
		},
	},
	{
		cost: 1,
		is_byok: true,
		cost_details: {
			upstream_inference_cost: null,
			upstream_inference_prompt_cost: -1,
			upstream_inference_completions_cost: 2,
		},
	},
])("keeps the estimate when billing data is incomplete or invalid: %j", (reported) => {
	const value = usage();
	applyOpenRouterReportedCost(value, reported);
	expect(value.cost).toEqual({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0, total: 10 });
});
