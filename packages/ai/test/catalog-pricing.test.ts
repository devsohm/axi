import { expect, it } from "vitest";
import { buildModelsDevCatalog, parseModelsDev, type ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import type { ModelCost } from "../src/types.ts";

const base = { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 };
const cases = [
	{
		name: "an output override without a price does not create a tier",
		cost: {
			text: {
				input: { price: 2 },
				output: { price: 8, overrides: [{ when: { context: { gt: 100 } } }] },
			},
		},
		expected: base,
	},
	{
		name: "an input cache override can create a tier without a token price",
		cost: {
			text: {
				input: { price: 2, overrides: [{ when: { context: { gt: 100 } }, cache: { read: 1 } }] },
				output: { price: 8 },
			},
		},
		expected: { ...base, tiers: [{ ...base, inputTokensAbove: 100, cacheRead: 1 }] },
	},
	...(["input", "output"] as const).map((kind) => ({
		name: `an empty ${kind} unit is not a token price`,
		cost: { text: { input: { price: 2 }, output: { price: 8 }, [kind]: { unit: "", price: 2 } } },
		expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	})),
	{
		name: "a zero output price is an explicit tier",
		cost: {
			text: {
				input: { price: 2 },
				output: { price: 8, overrides: [{ when: { context: { gte: 100 } }, price: 0 }] },
			},
		},
		expected: { ...base, tiers: [{ ...base, inputTokensAbove: 100, output: 0 }] },
	},
] satisfies { name: string; cost: ModelsDevV2Model["cost"]; expected: ModelCost }[];

it.each(cases)("normalizes catalog pricing: $name", ({ cost, expected }) => {
	const model: ModelsDevV2Model = {
		id: "priced",
		name: "Priced model",
		type: "chat",
		modalities: { input: ["text"], output: ["text"] },
		capabilities: { tools: { supported: true }, reasoning: { supported: false } },
		api: { "chat-completions": { base_url: "https://catalog.invalid/v1" } },
		cost,
	};
	const source = parseModelsDev({ cerebras: { models: { priced: model } } });
	expect(buildModelsDevCatalog(source).models.map((entry) => entry.cost)).toEqual([expected]);
});
