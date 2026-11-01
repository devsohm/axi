import { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type { Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { resolveAzureConfig, resolveDeploymentName } from "./azure-openai-config.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { getResponsesToolSupport, convertResponsesMessages, convertResponsesTools } from "./openai-responses-shared.ts";
import type { AzureOpenAIResponsesOptions } from "./options.ts";
import { createResponsesRequest } from "./responses-request.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

export type { AzureOpenAIResponsesOptions } from "./options.ts";

const toolProviders = new Set(["openai", "openai-codex", "opencode", "azure"]);
function request(
	model: Model<"azure-openai-responses">,
	transcript: TranscriptContext,
	options: AzureOpenAIResponsesOptions,
	grammar: ReadonlyMap<string, string>,
	deployment: string,
): ResponseCreateParamsStreaming {
	const additions = model.compat?.supportsAdditionalTools ?? false,
		search = model.compat?.supportsToolSearch ?? false;
	const toolOptions = {
		supportsStrictMode: model.compat?.supportsStrictMode ?? true,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
	};
	const body: ResponseCreateParamsStreaming = {
		model: deployment,
		stream: true,
		store: false,
		prompt_cache_key: clampOpenAIPromptCacheKey(options.sessionId),
		input: convertResponsesMessages(model, transcript, toolProviders, {
			grammarToolInputProperties: grammar,
			supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
			supportsAdditionalTools: additions,
			supportsToolSearch: search,
			toolOptions,
		}),
	};
	if (options.maxTokens) body.max_output_tokens = Math.max(16, options.maxTokens);
	if (options.temperature !== undefined) body.temperature = options.temperature;
	const tools = resolveTranscriptTools(
		transcript.messages,
		getResponsesToolSupport({
			supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
			supportsAdditionalTools: additions,
			supportsToolSearch: search,
		}),
	).requestTools;
	if (tools.length) body.tools = convertResponsesTools(tools, toolOptions);
	if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
	const level = options.reasoningEffort ?? (options.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		if (level) {
			const effort = options.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: level;
			body.reasoning = {
				effort: effort as NonNullable<ResponseCreateParamsStreaming["reasoning"]>["effort"],
				summary: options.reasoningSummary || "auto",
			};
			body.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null)
			body.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<
					ResponseCreateParamsStreaming["reasoning"]
				>["effort"],
			};
	}
	Object.assign(body, resolveSamplingParams(model, level ?? "off", options.samplingParams));
	return body;
}
export const stream: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model,
	context,
	options = {},
) => {
	const transcript = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);
	return createResponsesRequest({
		model,
		options,
		label: "Azure OpenAI",
		errorPrefix: "Azure OpenAI API error",
		prepare: () => {
			const deployment = resolveDeploymentName(model, options);
			const apiKey = options.apiKey;
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const headers = { ...getIdentityHeaders(model, options.identity), ...model.headers };
			if (options.headers) Object.assign(headers, options.headers);
			const config = resolveAzureConfig(model, options);
			const client = new AzureOpenAI({
				apiKey,
				apiVersion: config.apiVersion,
				baseURL: config.baseUrl,
				dangerouslyAllowBrowser: true,
				fetch: options.fetch,
				defaultHeaders: headers,
			});
			const grammar = createGrammarToolInputProperties(
				getDeclaredTools(transcript.messages),
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			return {
				client,
				body: request(model, transcript, options, grammar, deployment),
				parsing: { grammarToolInputProperties: grammar },
			};
		},
	});
};
export const streamSimple: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model,
	context,
	options,
) => {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	};
	const level = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return stream(model, context, {
		...base,
		reasoningEffort: level === "off" ? undefined : level,
	});
};
