import { MODELS, CLASSIFIER_MODELS } from "../src/models.generated.ts";
import { hasApi } from "../src/models.ts";
import type { AnyModel, Api, ClassifierApi, ClassifierModel, Model, ModelCost, ModelType } from "../src/types.ts";
import { applyCatalogMetadata, applyImageMetadata } from "./catalog-metadata.ts";
import type { buildModelsDevCatalog } from "./models-dev-catalog.ts";
import type { OpenRouterCatalog } from "./openrouter-catalog.ts";

const staticModels: Readonly<Record<string, Readonly<Record<string, Model<Api>>>>> = MODELS;
type CatalogModel = AnyModel & { type: ModelType };
const chat = (provider: string, id: string): Model<Api> => {
	const seed = staticModels[provider]?.[id];
	if (!seed) throw new Error(`Missing fixed model metadata: ${provider}/${id}`);
	const {
		type: _type,
		compat: _compat,
		thinkingLevelMap: _thinking,
		inputLimits: _limits,
		promptCache: _cache,
		...value
	} = structuredClone(seed);
	return value;
};
const standardIds = [
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
	"gpt-6.1-sol",
];
const standards = new Map(standardIds.map((id) => [id, chat("openai", id).cost]));
function longContext(cost: ModelCost): ModelCost {
	const rounded = (value: number) => Number(value.toFixed(6));
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: 272000,
				input: rounded(cost.input * 2),
				output: rounded(cost.output * 1.5),
				cacheRead: rounded(cost.cacheRead * 2),
				cacheWrite: rounded(cost.cacheWrite * 2),
			},
		],
	};
}
const extendedCopilot = new Set([
	"claude-fable-5",
	"claude-opus-4.8",
	"claude-opus-5",
	"claude-opus-5.5",
	"claude-sonnet-4.6",
	"claude-sonnet-5",
	"gpt-5.3-codex",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
]);
const shortOpenAI = new Set(["gpt-5.4", "gpt-5.5", ...standardIds]);
const longOpenAI = new Set(["gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", ...standardIds]);
const excludedXai = new Set([
	"grok-3",
	"grok-3-fast",
	"grok-4.20-0309-non-reasoning",
	"grok-4.20-0309-reasoning",
	"grok-build-0.1",
	"grok-code-fast-1",
]);
const clone = <T>(value: T): T => structuredClone(value);
function prependCorrections(models: Model<Api>[]): void {
	for (const model of models) {
		const { provider, id } = model;
		if (provider === "github-copilot" && extendedCopilot.has(id)) model.contextWindow = 1000000;
		if (
			(provider === "anthropic" && ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].includes(id)) ||
			(provider === "github-copilot" && id === "claude-opus-5.5")
		)
			model.thinkingLevelMap = {
				...model.thinkingLevelMap,
				...(id !== "claude-haiku-5-5" ? { off: null } : {}),
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			};
		if (
			["anthropic", "opencode", "opencode-go"].includes(provider) &&
			["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4.6", "claude-sonnet-4.6"].includes(id)
		)
			model.contextWindow = 1000000;
		if (["opencode", "opencode-go"].includes(provider)) {
			if (["claude-sonnet-4-5", "claude-sonnet-4"].includes(id)) model.contextWindow = 200000;
			if (id === "gpt-5.4") {
				model.contextWindow = 272000;
				model.maxTokens = 128000;
			}
		}
		if (provider === "openai") {
			if (shortOpenAI.has(id)) {
				model.contextWindow = 272000;
				model.maxTokens = 128000;
			}
			if (longOpenAI.has(id)) model.cost = longContext(standards.get(id) ?? model.cost);
			if (id === "gpt-5-pro") model.maxTokens = 128000;
		}
		if (provider === "cloudflare-ai-gateway") {
			const cost = standards.get(id);
			if (cost) model.cost = longContext(cost);
		}
		if (
			(provider === "openrouter" && ["moonshotai/kimi-k3", "~moonshotai/kimi-latest"].includes(id)) ||
			(provider === "vercel-ai-gateway" && id === "moonshotai/kimi-k3")
		)
			model.maxTokens = 131072;
		if (provider === "openrouter") {
			if (id === "moonshotai/kimi-k2.5") {
				model.cost.input = 0.41;
				model.cost.output = 2.06;
				model.cost.cacheRead = 0.07;
				model.maxTokens = 4096;
			}
			if (id.startsWith("moonshotai/kimi-k2.6"))
				model.compat = {
					...model.compat,
					supportsDeveloperRole: false,
					requiresReasoningContentOnAssistantMessages: true,
				};
			if (id === "z-ai/glm-5") {
				model.cost.input = 0.6;
				model.cost.output = 1.9;
				model.cost.cacheRead = 0.119;
			}
		}
	}
}
function fallbacks(models: Model<Api>[], provider: string, ids: string[]): void {
	for (const id of ids)
		if (!models.some((model) => model.provider === provider && model.id === id)) models.push(chat(provider, id));
}
function allowedFallbacks(models: Model<Api>[]): void {
	const byId = new Map(
		models
			.filter((model) => model.provider === "anthropic" && hasApi(model, "anthropic-messages"))
			.map((model) => [model.id, model]),
	);
	for (const [id, alternatives] of [
		["claude-fable-5", ["claude-opus-4-8", "claude-opus-5"]],
		["claude-opus-5", ["claude-opus-4-8"]],
	] as const) {
		const model = byId.get(id);
		if (!model || !hasApi(model, "anthropic-messages")) continue;
		const allowed = alternatives
			.filter((id) => !model.compat?.supportsMidConvoEffort || /^claude-opus-5(?:-\d{8})?$/.test(id))
			.flatMap((id) => {
				const target = byId.get(id);
				return target ? [{ provider: target.provider, model: target.id, cost: target.cost }] : [];
			});
		if (allowed.length) model.compat = { ...model.compat, allowedFallbackModels: allowed };
	}
}
export function assembleCatalog(
	source: ReturnType<typeof buildModelsDevCatalog>,
	router: OpenRouterCatalog,
	gateway: { chat: Model<Api>[]; classifiers: ClassifierModel<ClassifierApi>[] },
	classifiers: ClassifierModel<ClassifierApi>[],
): Record<string, CatalogModel[]> {
	let models = [...source.models, ...router.chat, ...gateway.chat].filter(
		(model) =>
			!(model.provider === "xai" && excludedXai.has(model.id)) &&
			!(["opencode", "opencode-go"].includes(model.provider) && model.id === "gpt-5.3-codex-spark"),
	);
	fallbacks(models, "github-copilot", ["claude-opus-5.5", "gpt-6-sol", "gpt-6-luna"]);
	prependCorrections(models);
	fallbacks(models, "openai", [
		"gpt-6.1-sol",
		"gpt-6-astra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5-chat-latest",
	]);
	for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
		const model = chat("deepseek", id);
		model.compat = { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" };
		if (id === "deepseek-flash")
			model.thinkingLevelMap = { minimal: null, low: "low", medium: null, high: "high", max: "max" };
		models.push(model);
	}
	for (const id of ["Ling-2.6-flash", "Ling-2.6-1T", "Ring-2.6-1T"]) {
		const model = chat("ant-ling", id);
		model.compat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
			...(id.startsWith("Ring") ? { thinkingFormat: "ant-ling" } : {}),
		};
		models.push(model);
	}
	for (const model of models)
		if (
			model.api === "openai-completions" &&
			model.id.includes("deepseek-v4") &&
			!model.provider.startsWith("qwen-token-plan")
		)
			model.compat = {
				...model.compat,
				requiresReasoningContentOnAssistantMessages: true,
				...(["openrouter", "opencode"].includes(model.provider) ? {} : { thinkingFormat: "deepseek" }),
			};
	models.push(
		...Object.keys(MODELS["openai-codex"])
			.filter((id) => !["gpt-5.3-codex-spark", "gpt-5.5"].includes(id))
			.map((id) => chat("openai-codex", id)),
	);
	if (!models.some((model) => model.provider === "mistral" && model.id === "mistral-medium-3.5"))
		models.push({
			...chat("mistral", "mistral-medium-3.5"),
			name: "Mistral Medium 3.5",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262144,
			maxTokens: 262144,
			thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
			cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
		});
	fallbacks(models, "openrouter", ["auto", "openrouter/fusion"]);
	const azureContext: Readonly<Record<string, number>> = {
		"gpt-5.4": 1050000,
		"gpt-5.5": 1050000,
		"gpt-5.6-luna": 1050000,
		"gpt-5.6-sol": 1050000,
		"gpt-5.6-terra": 1050000,
	};
	const azure: Model<Api>[] = models
		.filter((model) => model.provider === "openai" && model.api === "openai-responses")
		.map((model) => ({
			...model,
			provider: "azure",
			api: "azure-openai-responses",
			baseUrl: "",
			contextWindow: azureContext[model.id] ?? model.contextWindow,
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
		}));
	for (const model of models)
		if (model.provider === "deepseek" && model.id === "deepseek-v4-pro")
			azure.push({
				...model,
				provider: "azure",
				baseUrl: "",
				cost: { input: 1.925, output: 3.828, cacheRead: 0.165, cacheWrite: 0 },
				compat: {
					...model.compat,
					supportsDeveloperRole: false,
					supportsMidConvoSystemMessages: true,
					thinkingFormat: "openai",
					supportsLongCacheRetention: false,
				},
			});
	models.push(...azure);
	for (const model of models) applyCatalogMetadata(model, source.options.get(`${model.provider}:${model.id}`));
	allowedFallbacks(models);
	const entries: CatalogModel[] = models.map((model) => ({ ...model, type: "chat" }));
	for (const model of router.images) {
		applyImageMetadata(model);
		entries.push(model);
	}
	entries.push(
		...classifiers,
		...router.classifiers,
		...gateway.classifiers,
		...clone(Object.values(CLASSIFIER_MODELS.opencode)),
		...clone(Object.values(CLASSIFIER_MODELS["cloudflare-workers-ai"])),
		...clone(Object.values(CLASSIFIER_MODELS.openai)),
	);
	const providers = new Map<string, Map<string, CatalogModel>>();
	for (const model of entries) {
		let group = providers.get(model.provider);
		if (!group) {
			group = new Map();
			providers.set(model.provider, group);
		}
		const key = `${model.type}:${model.id}`;
		if (!group.has(key)) group.set(key, model);
	}
	const order = { chat: 0, image: 1, classifier: 2 };
	return Object.fromEntries(
		[...providers]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([provider, group]) => [
				provider,
				[...group.values()].sort(
					(a, b) => order[a.type ?? "chat"] - order[b.type ?? "chat"] || a.id.localeCompare(b.id),
				),
			]),
	);
}
