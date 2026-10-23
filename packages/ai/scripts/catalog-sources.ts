import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Api, ClassifierModel, Model } from "../src/types.ts";
import { getAiGatewayCost } from "./ai-gateway-pricing.ts";
import { assembleCatalog } from "./catalog-generation.ts";
import { record } from "./model-data.ts";
import { buildModelsDevCatalog, parseModelsDev } from "./models-dev-catalog.ts";
import { buildOpenRouterCatalog, type OpenRouterModelListItem } from "./openrouter-catalog.ts";

async function json(url: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Catalog request failed (${response.status}): ${url}`);
	return response.json();
}
async function fallback<T>(label: string, strict: boolean, empty: T, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (strict) throw error;
		process.stderr.write(`${label}: ${error instanceof Error ? error.message : String(error)}\n`);
		return empty;
	}
}
const price = Type.Optional(Type.Union([Type.String(), Type.Number()]));
const tier = Type.Object({ cost: price, min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()) });
const tiers = Type.Optional(Type.Array(tier));
const gatewaySchema = Type.Object({
	data: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				name: Type.Optional(Type.String()),
				type: Type.Optional(Type.String()),
				context_window: Type.Optional(Type.Number()),
				max_tokens: Type.Optional(Type.Number()),
				tags: Type.Optional(Type.Array(Type.String())),
				pricing: Type.Optional(
					Type.Object({
						input: price,
						output: price,
						input_cache_read: price,
						input_cache_write: price,
						input_tiers: tiers,
						output_tiers: tiers,
						input_cache_read_tiers: tiers,
						input_cache_write_tiers: tiers,
					}),
				),
			}),
		),
	),
});
export async function fetchCatalog(raw: unknown, strict: boolean) {
	const source = parseModelsDev(raw);
	const nvidia = source.nvidia?.models
		? await fallback("NVIDIA model list", strict, [] as string[], async () => {
				const body = await json("https://integrate.api.nvidia.com/v1/models");
				if (!record(body) || (body.data !== undefined && !Array.isArray(body.data)))
					throw new Error("Invalid NVIDIA model list");
				return (body.data ?? []).map((value: unknown) => {
					if (!record(value) || typeof value.id !== "string") throw new Error("Invalid NVIDIA model identity");
					return value.id;
				});
			})
		: [];
	const generated = buildModelsDevCatalog(source, nvidia);
	const classifiers = await fallback<ClassifierModel<"typesafe-system-one">[]>(
		"Classifier metadata",
		strict,
		[],
		async () => {
			const body = await json("https://models.dev/models.json?type=decision"),
				value = record(body) ? body["typesafe/jev-latest"] : undefined;
			if (!record(value) || value.type !== "decision" || typeof value.name !== "string")
				throw new Error("Missing classifier metadata: typesafe/jev-latest");
			const contextWindow =
				record(value.limit) && typeof value.limit.context === "number" ? value.limit.context || 64000 : 64000;
			return [
				{
					type: "classifier",
					id: "jev-latest",
					name: value.name,
					api: "typesafe-system-one",
					provider: "typesafe",
					baseUrl: "https://api.typesafe.ai/v1/",
					input: ["text", "image"],
					compat: { imageInput: "assets", sendImageOptInHeader: true },
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
				},
			];
		},
	);
	const router = await fallback(
		"OpenRouter model list",
		strict,
		{ chat: [], images: [], classifiers: [] } as ReturnType<typeof buildOpenRouterCatalog>,
		async () => {
			const lists = await Promise.all(
				["", "?output_modalities=image", "?output_modalities=decisions"].map(async (query) => {
					const body = (await json(`https://openrouter.ai/api/v1/models${query}`)) as {
						data?: OpenRouterModelListItem[];
					};
					return body.data ?? [];
				}),
			);
			const catalog = buildOpenRouterCatalog(lists[0], lists[1], lists[2]);
			if (strict && !catalog.images.length) throw new Error("OpenRouter API returned no usable image models");
			return catalog;
		},
	);
	const gateway = await fallback(
		"AI Gateway model list",
		strict,
		{ chat: [] as Model<Api>[], classifiers: [] as ClassifierModel<"typesafe-system-one">[] },
		async () => {
			const body = await json("https://ai-gateway.vercel.sh/v1/models");
			if (!Value.Check(gatewaySchema, body)) throw new Error("Invalid AI Gateway model list");
			const chat: Model<Api>[] = [],
				classifiers: ClassifierModel<"typesafe-system-one">[] = [];
			for (const model of body.data ?? []) {
				const cost = getAiGatewayCost(model.pricing);
				if (model.type === "evaluation") {
					classifiers.push({
						type: "classifier",
						id: model.id,
						name: model.name || model.id,
						api: "typesafe-system-one",
						provider: "vercel-ai-gateway",
						baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1",
						input: ["text"],
						cost: { input: cost.input, output: cost.output, cacheRead: 0, cacheWrite: 0 },
						contextWindow: model.context_window || 4096,
					});
					continue;
				}
				if (!model.tags?.includes("tool-use")) continue;
				chat.push({
					id: model.id,
					name: model.name || model.id,
					api: "anthropic-messages",
					provider: "vercel-ai-gateway",
					baseUrl: "https://ai-gateway.vercel.sh",
					reasoning: model.tags.includes("reasoning"),
					input: model.tags.includes("vision") ? ["text", "image"] : ["text"],
					compat: { allowEmptySignature: true },
					cost,
					contextWindow: model.context_window || 4096,
					maxTokens: model.max_tokens || 4096,
				});
			}
			return { chat, classifiers };
		},
	);
	return assembleCatalog(generated, router, gateway, classifiers);
}
