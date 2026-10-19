import type { Model, OpenAICompletionsCompat } from "../types.ts";

type OptionalControls =
	| "cacheControlFormat"
	| "thinkingTokenBudgetField"
	| "vllmPriority"
	| "supportsThinkingTokenBudget"
	| "supportsMidConvoSystemMessages"
	| "supportsMidConvoToolAdditions";
export type CompletionsCompat = Required<Omit<OpenAICompletionsCompat, OptionalControls>> &
	Pick<OpenAICompletionsCompat, OptionalControls>;

export function completionsCompat(model: Model<"openai-completions">): CompletionsCompat {
	const { provider, baseUrl: url } = model;
	const zai = ["zai", "zai-coding-cn"].includes(provider) || /api\.z\.ai|open\.bigmodel\.cn/.test(url);
	const together = provider === "together" || /api\.together\.(ai|xyz)/.test(url);
	const moonshot = ["moonshotai", "moonshotai-cn"].includes(provider) || url.includes("api.moonshot.");
	const router = provider === "openrouter" || url.includes("openrouter.ai");
	const workers = provider === "cloudflare-workers-ai" || url.includes("api.cloudflare.com");
	const gateway = provider === "cloudflare-ai-gateway" || url.includes("gateway.ai.cloudflare.com");
	const nvidia = provider === "nvidia" || url.includes("integrate.api.nvidia.com");
	const ling = provider === "ant-ling" || url.includes("api.ant-ling.com");
	const cerebras = provider === "cerebras" || url.includes("cerebras.ai");
	const deepseek = provider === "deepseek" || url.toLowerCase().includes("deepseek.com");
	const xai = provider === "xai" || url.includes("api.x.ai");
	const chutes = url.includes("chutes.ai");
	const custom =
		nvidia ||
		cerebras ||
		xai ||
		together ||
		chutes ||
		deepseek ||
		zai ||
		moonshot ||
		provider === "opencode" ||
		url.includes("opencode.ai") ||
		workers ||
		gateway ||
		ling;
	const defaults: CompletionsCompat = {
		supportsStore: !custom,
		supportsDeveloperRole: router ? /^(anthropic|openai)\//.test(model.id) : !custom,
		supportsReasoningEffort: !(xai || zai || moonshot || together || gateway || nvidia || ling),
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField:
			chutes || deepseek || moonshot || gateway || together || nvidia || ling || zai
				? "max_tokens"
				: "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: deepseek,
		thinkingFormat: deepseek
			? "deepseek"
			: zai
				? "zai"
				: together
					? "together"
					: ling
						? "ant-ling"
						: router
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		supportsThinkingTokenBudget: false,
		supportsStrictMode: false,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		cacheControlFormat: provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined,
		sendSessionAffinityHeaders: router,
		sessionAffinityFormat: router ? "openrouter" : "openai",
		supportsLongCacheRetention: !(together || workers || gateway || nvidia || ling),
	};
	return {
		...defaults,
		...Object.fromEntries(Object.entries(model.compat ?? {}).filter(([, value]) => value != null)),
	};
}
