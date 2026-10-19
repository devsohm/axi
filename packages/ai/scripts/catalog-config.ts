import { assertExactModelIds, record } from "./model-data.ts";

export const individualModels = new Set([
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
]);
export function validateIndividualCatalog(catalog: unknown): void {
	const provider = record(catalog) ? catalog["alibaba-token-plan"] : undefined;
	const models = record(provider) && record(provider.models) ? provider.models : {};
	assertExactModelIds(
		"qwen-token-plan-individual",
		individualModels,
		Object.keys(models).filter((id) => individualModels.has(id) && record(models[id]) && models[id].tool_call === true),
	);
}
