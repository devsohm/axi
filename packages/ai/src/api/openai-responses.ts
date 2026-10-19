import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Model,
	OpenAIResponsesCompat,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { getUserAgent } from "../utils/user-agent.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools } from "./openai-responses-shared.ts";
import type { OpenAIResponsesOptions } from "./options.ts";
import { createResponsesRequest } from "./responses-request.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

export type { OpenAIResponsesOptions } from "./options.ts";

const toolProviders = new Set(["openai", "openai-codex", "opencode"]);
function clientKey(provider: string, options: OpenAIResponsesOptions | undefined): string {
	const apiKey = options?.apiKey;
	if (apiKey) return apiKey;
	for (const [name, value] of Object.entries(options?.headers ?? {}))
		if ((name.toLowerCase() === "authorization" || name.toLowerCase() === "cf-aig-authorization") && value?.trim())
			return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}
function compatibility(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat:
			model.compat?.sessionAffinityFormat ??
			(model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai"),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsMidConvoEffort: model.compat?.supportsMidConvoEffort ?? false,
	};
}
function pricing(
	usage: Usage,
	tier: ResponseCreateParamsStreaming["service_tier"],
	model: Model<"openai-responses">,
): void {
	const factor =
		tier === "flex" ? 0.5 : tier === "priority" || tier === "fast" ? (model.id === "gpt-5.5" ? 2.5 : 2) : 1;
	usage.cost.input *= factor;
	usage.cost.output *= factor;
	usage.cost.cacheRead *= factor;
	usage.cost.cacheWrite *= factor;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
function request(
	model: Model<"openai-responses">,
	transcript: TranscriptContext,
	options: OpenAIResponsesOptions,
	compat: Required<OpenAIResponsesCompat>,
	grammar: ReadonlyMap<string, string>,
	configurationUpdateEffort: string | undefined,
): ResponseCreateParamsStreaming {
	const retention =
		options.cacheRetention ?? (getProviderEnvValue("AXI_CACHE_RETENTION", options.env) === "long" ? "long" : "short");
	const toolOptions = {
		supportsStrictMode: compat.supportsStrictMode,
		supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
	};
	const input = convertResponsesMessages(model, transcript, toolProviders, {
		grammarToolInputProperties: grammar,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions,
		configurationUpdateEffort,
	});
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input,
		stream: true,
		store: false,
		prompt_cache_key: retention === "none" ? undefined : clampOpenAIPromptCacheKey(options.sessionId),
		prompt_cache_retention:
			retention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
				? "24h"
				: undefined,
		prompt_cache_options: !compat.supportsExplicitPromptCacheMode
			? undefined
			: retention === "none"
				? { mode: "explicit" }
				: retention === "long" && compat.supportsLongCacheRetention
					? { ttl: "30m" }
					: undefined,
	};
	if (options.maxTokens && compat.supportsMaxOutputTokens) params.max_output_tokens = Math.max(16, options.maxTokens);
	if (options.temperature !== undefined) params.temperature = options.temperature;
	if (options.serviceTier !== undefined) params.service_tier = options.serviceTier;
	const tools = resolveTranscriptTools(
		transcript.messages,
		compat.supportsAdditionalTools || compat.supportsToolSearch,
	).requestTools;
	if (tools.length) params.tools = convertResponsesTools(tools, toolOptions);
	if (options.toolChoice !== undefined) params.tool_choice = options.toolChoice;
	const level = options.reasoningEffort ?? (options.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		if (level) {
			const effort =
				configurationUpdateEffort !== undefined
					? "medium"
					: options.reasoningEffort
						? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
						: level;
			params.reasoning = {
				effort: effort as NonNullable<ResponseCreateParamsStreaming["reasoning"]>["effort"],
				summary: options.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<
					ResponseCreateParamsStreaming["reasoning"]
				>["effort"],
			};
		}
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}
	Object.assign(params, resolveSamplingParams(model, level ?? "off", options.samplingParams));
	return params;
}
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (model, context, options = {}) => {
	const compat = compatibility(model);
	const transcript = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const effort =
		compat.supportsMidConvoEffort && options.reasoningEffort
			? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
			: undefined;
	return createResponsesRequest({
		model,
		options,
		label: "OpenAI",
		providerThinkingLevel: effort,
		errorPrefix: `${model.provider === "openai" ? "OpenAI" : model.provider} API error`,
		prepare: () => {
			const apiKey = clientKey(model.provider, options);
			const headers: ProviderHeaders = { "User-Agent": getUserAgent(), ...model.headers };
			if (model.provider === "github-copilot")
				Object.assign(
					headers,
					buildCopilotDynamicHeaders({
						messages: transcript.messages,
						hasImages: hasCopilotVisionInput(transcript.messages),
					}),
				);
			const session = options.cacheRetention === "none" ? undefined : options.sessionId;
			if (session) {
				if (compat.sessionAffinityFormat === "openrouter") headers["x-session-id"] = session;
				else {
					if (compat.sessionAffinityFormat === "openai") headers.session_id = session;
					headers["x-client-request-id"] = session;
				}
			}
			Object.assign(headers, options.headers);
			const client = new OpenAI({
				apiKey,
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
				fetch: options.fetch,
				defaultHeaders: headers,
			});
			const grammar = createGrammarToolInputProperties(
				getDeclaredTools(transcript.messages),
				compat.supportsOpenAIGrammarTools,
			);
			return {
				client,
				body: request(model, transcript, options, compat, grammar, effort),
				get parsing() {
					return {
						grammarToolInputProperties: grammar,
						serviceTier: options.serviceTier,
						applyServiceTierPricing: (usage: Usage, tier: ResponseCreateParamsStreaming["service_tier"]) =>
							pricing(usage, tier, model),
					};
				},
			};
		},
	});
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (model, context, options) => {
	clientKey(model.provider, options);
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	};
	const level = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return stream(model, context, {
		...base,
		reasoningEffort: level === "off" ? undefined : level,
	});
};
