import { openRouterCost, type OpenRouterModel } from "../src/providers/openrouter-api.ts";
import type { ClassifierModel, ImageModel, Model } from "../src/types.ts";
import { getOpenRouterThinkingLevelMap, type OpenRouterReasoningMetadata } from "./openrouter-reasoning-options.ts";
export interface OpenRouterModelListItem extends OpenRouterModel {
	name: string;
	supported_parameters?: string[];
	architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
	reasoning?: OpenRouterReasoningMetadata;
}
export interface OpenRouterCatalog {
	chat: Model<"anthropic-messages" | "openai-completions">[];
	images: ImageModel<"openrouter-images">[];
	classifiers: ClassifierModel<"typesafe-system-one">[];
}
const modalities = (values: string[] | undefined): ("text" | "image")[] => [
	...new Set(values?.filter((value): value is "text" | "image" => value === "text" || value === "image") ?? []),
];
export function buildOpenRouterCatalog(
	listed: readonly OpenRouterModelListItem[],
	imageListed: readonly OpenRouterModelListItem[],
	decisionListed: readonly OpenRouterModelListItem[],
): OpenRouterCatalog {
	const catalog: OpenRouterCatalog = { chat: [], images: [], classifiers: [] };
	for (const model of listed) {
		if (!model.supported_parameters?.includes("tools")) continue;
		const anthropic = model.id.startsWith("anthropic/") && !model.id.endsWith(":batch");
		const thinkingLevelMap = getOpenRouterThinkingLevelMap(model.reasoning);
		catalog.chat.push({
			type: "chat",
			id: model.id,
			name: model.name,
			provider: "openrouter",
			api: anthropic ? "anthropic-messages" : "openai-completions",
			baseUrl: anthropic ? "https://openrouter.ai/api" : "https://openrouter.ai/api/v1",
			reasoning: model.supported_parameters.includes("reasoning"),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: model.architecture?.modality?.includes("image") ? ["text", "image"] : ["text"],
			cost: openRouterCost(model.pricing ?? undefined),
			contextWindow: model.top_provider?.context_length || model.context_length || 4096,
			maxTokens: model.top_provider?.max_completion_tokens || 4096,
		});
	}
	for (const model of imageListed) {
		if (catalog.images.some((entry) => entry.id === model.id)) continue;
		const output = modalities(model.architecture?.output_modalities),
			input = modalities(model.architecture?.input_modalities);
		if (!output.includes("image")) continue;
		catalog.images.push({
			type: "image",
			id: model.id,
			name: model.name,
			provider: "openrouter",
			api: "openrouter-images",
			baseUrl: "https://openrouter.ai/api/v1",
			input: input.length ? input : ["text"],
			output,
			cost: openRouterCost(model.pricing ?? undefined),
		});
	}
	for (const model of decisionListed) {
		if (
			catalog.classifiers.some((entry) => entry.id === model.id) ||
			!model.architecture?.output_modalities?.includes("decisions")
		)
			continue;
		const input = modalities(model.architecture.input_modalities);
		catalog.classifiers.push({
			type: "classifier",
			id: model.id,
			name: model.name,
			provider: "openrouter",
			api: "typesafe-system-one",
			baseUrl: "https://openrouter.ai/api/v1",
			input: input.length ? input : ["text"],
			cost: openRouterCost(model.pricing ?? undefined),
			contextWindow: model.top_provider?.context_length || model.context_length || 4096,
			compat: { imageInput: "state-image-urls", sendImageOptInHeader: false },
		});
	}
	return catalog;
}
