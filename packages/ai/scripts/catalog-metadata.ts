import { completionsCompat } from "../src/api/openai-completions-compat.ts";
import { hasApi } from "../src/models.ts";
import type { Api, Model, OpenAICompletionsCompat, ThinkingLevelMap } from "../src/types.ts";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";

export const toolSearchModels = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
]);
const gpt6 = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]);
const codexAdditional = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", ...gpt6]);
const adaptiveFallbacks = new Set(
	[
		"deepseek-v4-flash-0731",
		"deepseek-v4-flash-vision-exp",
		"deepseek-v4-pro-0813",
		"qwen3p8-max",
		"qwen3p8-2p4t-a95b",
	].map((id) => `accounts/fireworks/models/${id}`),
);
const noneReasoning = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-sol",
	"gpt-6-luna",
]);
const includes = (id: string, fragments: string[]) => fragments.some((fragment) => id.includes(fragment));
const thinking = (model: Model<Api>, patch: ThinkingLevelMap) => {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...patch };
};
export function anthropicMetadata(provider: string, id: string) {
	const native =
		/^claude-opus-(?:4[.-]8|5(?:[.-]5)?)(?:-\d{8})?$/.test(id) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(id) ||
		/^claude-(?:fable|mythos)-5(?:[.-]1)?(?:-\d{8})?$/.test(id);
	const canonical = id.toLowerCase().replace(/^~?anthropic\//, "");
	const effort =
		/^claude-opus-(?:5|5[.-]5)(?:-\d{8})?$/.test(canonical) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(canonical) ||
		/^claude-(?:fable|mythos)-5[.-]1(?:-\d{8})?$/.test(canonical);
	return {
		...(["anthropic", "openrouter"].includes(provider) &&
		effort &&
		!(provider === "openrouter" && id === "anthropic/claude-opus-5")
			? { supportsMidConvoEffort: true }
			: {}),
		...(["anthropic", "opencode", "github-copilot"].includes(provider) && native
			? { supportsMidConvoSystemMessages: true }
			: {}),
		...(provider === "anthropic" && native ? { supportsMidConvoToolChanges: true } : {}),
		...(provider === "github-copilot" && ["claude-haiku-4.5", "claude-sonnet-4", "claude-sonnet-4.5"].includes(id)
			? { supportsEagerToolInputStreaming: false }
			: {}),
		...(provider === "xiaomi" ||
		provider.startsWith("xiaomi-token-plan-") ||
		(["opencode", "opencode-go"].includes(provider) && id === "qwen3.8-flash")
			? { allowEmptySignature: true }
			: {}),
	};
}
function completionsMetadata(model: Model<"openai-completions">): void {
	const detected = completionsCompat({ ...model, compat: undefined });
	const defaults = {
		supportsStore: true,
		supportsDeveloperRole: true,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: false,
		thinkingFormat: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		supportsStrictMode: false,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		sendSessionAffinityHeaders: false,
		supportsLongCacheRetention: true,
	};
	const url = model.baseUrl;
	const unsupportedStrict =
		["moonshotai", "moonshotai-cn", "together", "cloudflare-ai-gateway", "nvidia", "cerebras"].includes(
			model.provider,
		) ||
		/api\.moonshot\.|api\.together\.(ai|xyz)|gateway\.ai\.cloudflare\.com|integrate\.api\.nvidia\.com|cerebras\.ai/.test(
			url,
		);
	detected.supportsStrictMode = !unsupportedStrict;
	if (model.provider === "openrouter" && /^~?anthropic\//.test(model.id)) detected.cacheControlFormat = "anthropic";
	const delta = Object.fromEntries(
		Object.entries(detected).filter(([key, value]) => {
			if (key === "cacheControlFormat") return value !== undefined;
			return key in defaults && JSON.stringify(value) !== JSON.stringify(defaults[key as keyof typeof defaults]);
		}),
	) as OpenAICompletionsCompat;
	model.compat = { ...delta, ...model.compat };
	if (!Object.keys(model.compat).length) delete model.compat;
}
export function applyCatalogMetadata(model: Model<Api>, options?: ModelsDevReasoningOption[]): void {
	const { id, provider } = model;
	if (hasApi(model, "openai-completions")) completionsMetadata(model);
	if (hasApi(model, "anthropic-messages")) {
		const metadata = anthropicMetadata(provider, id);
		if (Object.keys(metadata).length) model.compat = { ...model.compat, ...metadata };
		const canonical = id
			.toLowerCase()
			.replace(/^~?anthropic\//, "")
			.replace(/-\d{8}$/, "");
		if (
			model.compat?.supportsMidConvoEffort &&
			!["claude-opus-5", "claude-haiku-5-5", "claude-haiku-5.5"].includes(canonical)
		)
			thinking(model, { off: null });
	}
	const direct =
		["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(model.api) ||
		(hasApi(model, "anthropic-messages") && model.compat?.forceAdaptiveThinking) ||
		(hasApi(model, "openai-completions") &&
			completionsCompat(model).thinkingFormat === "openai" &&
			completionsCompat(model).supportsReasoningEffort);
	if (options && direct) {
		const map = getEffortThinkingLevelMap(options);
		if (map) thinking(model, map);
	}
	if (["openai-responses", "azure-openai-responses"].includes(model.api) && id.startsWith("gpt-5"))
		thinking(model, { off: null });
	if (gpt6.has(id) && ["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(model.api))
		thinking(model, {
			off: id === "gpt-6-astra" || id === "gpt-6.1-sol" ? null : "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	if (provider === "github-copilot" && id.startsWith("gpt-5")) thinking(model, { minimal: "low" });
	if (provider === "openai" && model.api === "openai-responses" && noneReasoning.has(id))
		thinking(model, { off: "none" });
	if (provider === "xai" && model.api === "openai-responses" && model.thinkingLevelMap === undefined)
		thinking(model, { off: null, minimal: null });
	if (/gpt-(?:5\.[23456]|6)/.test(id)) thinking(model, { xhigh: "xhigh" });
	if (
		/gpt-(?:5\.6|6)/.test(id) &&
		["openai-responses", "azure-openai-responses", "openai-codex-responses", "openai-completions"].includes(model.api)
	)
		thinking(model, { max: "max" });
	if (provider === "openai" && id === "gpt-5.5") thinking(model, { minimal: null });
	if (id.endsWith("gpt-5.5-pro")) thinking(model, { off: null, minimal: null, low: null });
	if (includes(id, ["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"])) thinking(model, { max: "max" });
	const adaptive = includes(id, [
		"opus-4-6",
		"opus-4.6",
		"opus-4-7",
		"opus-4.7",
		"opus-4-8",
		"opus-4.8",
		"opus-5",
		"opus.5",
		"sonnet-4-6",
		"sonnet-4.6",
		"sonnet-5",
		"sonnet.5",
		"haiku-5",
		"haiku.5",
		"fable-5",
		"mythos-5",
	]);
	if (
		includes(id, [
			"opus-4-7",
			"opus-4.7",
			"opus-4-8",
			"opus-4.8",
			"opus-5",
			"opus.5",
			"sonnet-5",
			"sonnet.5",
			"haiku-5",
			"haiku.5",
		])
	)
		thinking(model, { xhigh: "xhigh", max: "max" });
	if (id.includes("fable-5")) thinking(model, { off: null, xhigh: "xhigh", max: "max" });
	if (hasApi(model, "anthropic-messages")) {
		if (adaptive) model.compat = { ...model.compat, forceAdaptiveThinking: true };
		if (
			includes(id.toLowerCase(), [
				"opus-4-7",
				"opus-4.7",
				"opus-4-8",
				"opus-4.8",
				"opus-5",
				"opus.5",
				"sonnet-5-5",
				"sonnet-5.5",
				"haiku-5-5",
				"haiku-5.5",
			])
		)
			model.compat = { ...model.compat, supportsTemperature: false };
	}
	if (model.api === "openai-completions" && id.includes("deepseek-v4") && model.thinkingLevelMap === undefined) {
		thinking(model, {
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			max: "max",
			...(provider === "openrouter"
				? { xhigh: "xhigh", max: null }
				: provider === "azure"
					? { low: "low", medium: "medium", xhigh: null, max: null }
					: ["deepseek", "opencode", "opencode-go"].includes(provider) && id.includes("deepseek-v4-flash")
						? { low: "low" }
						: {}),
		});
	}
	if (provider === "groq" && id === "qwen/qwen3.6-27b")
		thinking(model, { minimal: null, low: null, medium: null, high: "default" });
	if (provider === "openai-codex" && /gpt-(?:5\.[23456]|6)/.test(id)) thinking(model, { minimal: "low" });
	if (provider.startsWith("moonshotai") && ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"].includes(id))
		thinking(model, { off: null });
	if (provider === "openrouter" && id.startsWith("inception/mercury-2")) thinking(model, { off: null });
	if (provider === "openrouter" && id === "z-ai/glm-5.2") thinking(model, { xhigh: "xhigh" });
	if (provider === "fireworks") {
		if (hasApi(model, "anthropic-messages") && model.compat?.forceAdaptiveThinking) {
			if (id === "accounts/fireworks/models/qwen3p8-max" && !model.thinkingLevelMap)
				model.thinkingLevelMap = getEffortThinkingLevelMap([{ type: "effort", values: ["low", "medium", "xhigh"] }]);
			if (options?.some((option) => option.type === "toggle") || id === "accounts/fireworks/models/qwen3p8-2p4t-a95b")
				thinking(model, { off: "none" });
			if (id === "accounts/fireworks/models/deepseek-v4-pro-0813") thinking(model, { low: "low" });
		}
		if (id.includes("glm-5p2")) thinking(model, { off: "none", minimal: null, low: null, medium: null, max: "max" });
		if (id.includes("kimi-k3")) thinking(model, { medium: null });
	}
	if (provider === "opencode-go" && id === "glm-5.2")
		thinking(model, { off: null, minimal: null, low: null, medium: null, high: "high", max: "max" });
	if (provider === "opencode-go" && id === "kimi-k2.6") thinking(model, { minimal: null, low: null, medium: null });
	if (provider === "opencode" && id === "grok-build-0.1")
		thinking(model, { off: null, minimal: null, low: null, medium: null });
	if (provider === "ant-ling" && model.reasoning)
		thinking(model, { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh" });
	if (provider === "github-copilot") {
		if (["claude-opus-4.8", "claude-opus-5", "claude-sonnet-4.6"].includes(id))
			thinking(model, { minimal: "low", ...(id === "claude-sonnet-4.6" ? { max: "max" } : {}) });
	}
	if (hasApi(model, "anthropic-messages") && provider === "anthropic")
		model.compat = { ...model.compat, supportsStrictTools: true };
	if (
		hasApi(model, "openai-responses") ||
		hasApi(model, "azure-openai-responses") ||
		hasApi(model, "openai-codex-responses")
	) {
		if (["openai", "cloudflare-ai-gateway"].includes(provider) && model.api === "openai-responses")
			model.compat = { ...model.compat, supportsStrictMode: true };
		if (
			["openai", "openai-codex", "azure", "github-copilot", "opencode", "cloudflare-ai-gateway"].includes(provider) &&
			Number(/^gpt-(\d+)/.exec(id)?.[1] ?? 0) >= 5
		)
			model.compat = { ...model.compat, supportsOpenAIGrammarTools: true };
		const directOpenAI =
			(provider === "openai" && model.api === "openai-responses") ||
			(provider === "openai-codex" && model.api === "openai-codex-responses");
		if (directOpenAI && toolSearchModels.has(id))
			model.compat = {
				...model.compat,
				supportsToolSearch: true,
				...(provider === "openai" || codexAdditional.has(id) ? { supportsAdditionalTools: true } : {}),
			};
		const proxy = ["opencode", "opencode-go", "github-copilot"].includes(provider) && model.api === "openai-responses";
		if ((directOpenAI || proxy) && toolSearchModels.has(id))
			model.compat = {
				...model.compat,
				supportsMidConvoSystemMessages: true,
				...(proxy ? { supportsAdditionalTools: true } : {}),
			};
		if (provider === "openai" && model.api === "openai-responses")
			model.compat = {
				...model.compat,
				...(model.cost.cacheWrite > 0 ? { supportsExplicitPromptCacheMode: true } : {}),
				...(gpt6.has(id) ? { supportsMidConvoEffort: true } : {}),
			};
	}
	if (hasApi(model, "openai-completions")) {
		const k3 =
			(provider.startsWith("moonshot") && id === "kimi-k3") ||
			(provider === "fireworks" && id.includes("kimi-k3")) ||
			(["opencode", "opencode-go"].includes(provider) && id === "kimi-k3");
		const text =
			(provider.startsWith("moonshot") && ["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"].includes(id)) ||
			(provider === "github-copilot" && id === "kimi-k3") ||
			(provider === "deepseek" && id === "deepseek-v4-pro") ||
			(provider === "openrouter" && id.startsWith("openai/") && toolSearchModels.has(id.slice(7)));
		if (k3 || text)
			model.compat = {
				...model.compat,
				supportsMidConvoSystemMessages: true,
				...(k3 ? { supportsMidConvoToolAdditions: true } : {}),
			};
	}
	if (provider === "anthropic" && model.api === "anthropic-messages") model.promptCache = { short: 300, long: 3600 };
	applyImageMetadata(model);
}
export function applyImageMetadata(model: {
	provider: string;
	type?: string;
	input: ("text" | "image")[];
	contextWindow?: number;
	inputLimits?: Model<Api>["inputLimits"];
}): void {
	if (!model.input.includes("image")) return;
	const limits: Model<Api>["inputLimits"] =
		model.provider === "anthropic"
			? {
					maxRequestBytes: 33554432,
					images: { maxPerRequest: model.type !== "image" && model.contextWindow === 200000 ? 100 : 600 },
				}
			: model.provider === "amazon-bedrock"
				? { images: { maxPerMessage: 20 } }
				: model.provider === "openai"
					? { maxRequestBytes: 536870912, images: { maxPerRequest: 1500 } }
					: model.provider === "google"
						? { maxRequestBytes: 20971520, images: { maxPerRequest: 3600 } }
						: {};
	model.inputLimits = {
		...limits,
		...model.inputLimits,
		images: {
			...limits.images,
			...model.inputLimits?.images,
			resize: {
				maxWidth: 2000,
				maxHeight: 2000,
				maxBytes: 4718592,
				jpegQuality: 80,
				...model.inputLimits?.images?.resize,
			},
		},
	};
}
export const fireworksAdaptive = (id: string, options: readonly ModelsDevReasoningOption[]) =>
	options.some((option) => option.type === "effort") || adaptiveFallbacks.has(id);
