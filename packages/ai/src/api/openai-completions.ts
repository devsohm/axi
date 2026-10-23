import OpenAI from "openai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { applyOpenRouterReportedCost, isOpenRouterModel } from "../utils/openrouter-cost.ts";
import { parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getDeclaredTools, resolveTranscript } from "../utils/transcript.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import {
	appendGrammarToolInputJsonDelta,
	createGrammarToolInputProperties,
	type GrammarToolInputJsonBuffer,
} from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { completionsCompat } from "./openai-completions-compat.ts";
import { isReasoningDetail, type ReasoningDetail } from "./openai-completions-messages.ts";
import { completionsRequest } from "./openai-completions-request.ts";
import type { OpenAICompletionsOptions } from "./options.ts";
import { buildBaseOptions } from "./simple-options.ts";

export { type ConvertCompletionsMessagesOptions, convertMessages } from "./openai-completions-messages.ts";
export type { OpenAICompletionsOptions } from "./options.ts";

type RawUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	cached_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
};
type StreamingTool = ToolCall & {
	partialArgs?: string;
	customInput?: { property: string; jsonBuffer: GrammarToolInputJsonBuffer };
	streamIndex?: number;
};
function apiKey(model: Model<"openai-completions">, options: OpenAICompletionsOptions): string {
	const key = options.apiKey;
	if (key) return key;
	for (const [name, value] of Object.entries(options.headers ?? {}))
		if (["authorization", "cf-aig-authorization"].includes(name.toLowerCase()) && value?.trim()) return "unused";
	throw new Error(`No API key for provider: ${model.provider}`);
}
function readUsage(raw: RawUsage, model: Model<"openai-completions">): AssistantMessage["usage"] {
	const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0;
	const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens || 0;
	const input = Math.max(0, (raw.prompt_tokens || 0) - cacheRead - cacheWrite);
	const output = raw.completion_tokens || 0;
	const usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: raw.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	if (isOpenRouterModel(model)) applyOpenRouterReportedCost(usage, raw);
	return usage;
}
function mergeDetail(details: ReasoningDetail[], incoming: ReasoningDetail): void {
	const previous = details.at(-1);
	if (
		(previous?.type === "reasoning.text" && incoming.type === "reasoning.text") ||
		(previous?.type === "reasoning.summary" && incoming.type === "reasoning.summary")
	) {
		if (previous.type === "reasoning.text" && incoming.type === "reasoning.text") {
			previous.text += incoming.text;
			previous.signature ||= incoming.signature;
		} else if (previous.type === "reasoning.summary" && incoming.type === "reasoning.summary")
			previous.summary += incoming.summary;
		previous.id ??= incoming.id;
		previous.index ??= incoming.index;
		previous.format ||= incoming.format;
	} else details.push({ ...incoming });
}
export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model,
	context,
	options = {},
) => {
	const events = new AssistantMessageEventStream();
	const compat = completionsCompat(model);
	const transcript = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const output: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		content: [],
		stopReason: "pending",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	let details: ReasoningDetail[] | undefined;
	const saveDetails = (block: ThinkingContent) => {
		if (details) block.thinkingSignature = JSON.stringify(details);
	};
	void (async () => {
		try {
			const key = apiKey(model, options);
			const grammar = createGrammarToolInputProperties(
				getDeclaredTools(transcript.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const retention =
				options.cacheRetention ??
				(getProviderEnvValue("AXI_CACHE_RETENTION", options.env) === "long" ? "long" : "short");
			const headers: ProviderHeaders = { ...getIdentityHeaders(model, options.identity), ...model.headers };
			if (model.provider === "github-copilot")
				Object.assign(
					headers,
					buildCopilotDynamicHeaders({
						messages: transcript.messages,
						hasImages: hasCopilotVisionInput(transcript.messages),
					}),
				);
			if (options.sessionId && retention !== "none" && compat.sendSessionAffinityHeaders) {
				if (compat.sessionAffinityFormat === "openrouter") headers["x-session-id"] = options.sessionId;
				else {
					if (compat.sessionAffinityFormat === "openai") headers.session_id = options.sessionId;
					headers["x-client-request-id"] = headers["x-session-affinity"] = options.sessionId;
				}
			}
			Object.assign(headers, options.headers);
			const client = new OpenAI({
				apiKey: key,
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
				fetch: options.fetch,
				defaultHeaders: headers,
			});
			const body = completionsRequest({ model, context: transcript, options, compat, retention, grammar });
			const replacement = await options.onPayload?.(body, model);
			const params =
				replacement === undefined ? body : (replacement as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);
			const requestOptions = {
				...(options.signal ? { signal: options.signal } : {}),
				...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data, response } = await retryProviderRequest(
				() => client.chat.completions.create(params, requestOptions).withResponse(),
				{ maxRetries: options.maxRetries, maxRetryDelayMs: options.maxRetryDelayMs, signal: options.signal },
			);
			await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			events.push({ type: "start", partial: output });
			let text: TextContent | undefined, thinking: ThinkingContent | undefined;
			let finished = false;
			const byIndex = new Map<number, StreamingTool>(),
				byId = new Map<string, StreamingTool>();
			const blocks: (TextContent | ThinkingContent | StreamingTool)[] = output.content;
			const position = (block: AssistantMessage["content"][number]) => output.content.indexOf(block);
			const customText = (block: StreamingTool): string => {
				const value = block.customInput && block.arguments[block.customInput.property];
				return typeof value === "string" ? value : "";
			};
			const customDelta = (block: StreamingTool, value: string, close: boolean): string | undefined => {
				const input = block.customInput;
				if (!input) return undefined;
				const delta = appendGrammarToolInputJsonDelta(input.jsonBuffer, input.property, value, close);
				block.arguments = { [input.property]: value };
				return delta;
			};
			const thinkingBlock = (signature: string): ThinkingContent => {
				if (!thinking) {
					thinking = { type: "thinking", thinking: "", thinkingSignature: signature };
					output.content.push(thinking);
					events.push({ type: "thinking_start", contentIndex: position(thinking), partial: output });
				}
				return thinking;
			};
			for await (const chunk of data) {
				await options.onProviderStreamEvent?.(chunk, model);
				if (!chunk || typeof chunk !== "object") continue;
				output.responseId ||= chunk.id;
				if (typeof chunk.model === "string" && chunk.model && chunk.model !== model.id)
					output.responseModel ||= chunk.model;
				if (chunk.usage) output.usage = readUsage(chunk.usage, model);
				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;
				if (!chunk.usage && "usage" in choice && choice.usage && typeof choice.usage === "object")
					output.usage = readUsage(choice.usage, model);
				if (choice.finish_reason) {
					finished = true;
					output.rawStopReason = choice.finish_reason;
					switch (choice.finish_reason as string) {
						case "stop":
						case "end":
							output.stopReason = "stop";
							break;
						case "length":
							output.stopReason = "length";
							break;
						case "tool_calls":
						case "function_call":
							output.stopReason = "toolUse";
							break;
						default:
							output.stopReason = "error";
							output.errorMessage = `Provider finish_reason: ${choice.finish_reason}`;
					}
				}
				const delta = choice.delta;
				if (!delta) continue;
				for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
					if (!(field in delta)) continue;
					const value = (delta as Record<string, unknown>)[field];
					if (typeof value !== "string" || !value.length) continue;
					const block = thinkingBlock(
						model.provider === "opencode-go" && field === "reasoning" ? "reasoning_content" : field,
					);
					block.thinking += value;
					events.push({ type: "thinking_delta", contentIndex: position(block), delta: value, partial: output });
					break;
				}
				if ("reasoning_details" in delta && Array.isArray(delta.reasoning_details)) {
					for (const item of delta.reasoning_details)
						if (isReasoningDetail(item)) {
							thinkingBlock("");
							details ??= [];
							mergeDetail(details, item);
						}
				}
				if (delta.content?.length) {
					if (!text) {
						text = { type: "text", text: "" };
						output.content.push(text);
						events.push({ type: "text_start", contentIndex: position(text), partial: output });
					}
					text.text += delta.content;
					events.push({ type: "text_delta", contentIndex: position(text), delta: delta.content, partial: output });
				}
				for (const call of delta.tool_calls ?? []) {
					const index = typeof call.index === "number" ? call.index : undefined;
					const name = call.function?.name ?? call.custom?.name ?? "";
					let block =
						(index === undefined ? undefined : byIndex.get(index)) ?? (call.id ? byId.get(call.id) : undefined);
					if (!block) {
						const property = call.custom && !call.function ? (grammar.get(name) ?? "input") : undefined;
						block = {
							type: "toolCall",
							id: call.id || "",
							name,
							arguments: property === undefined ? {} : { [property]: "" },
							partialArgs: property === undefined ? "" : undefined,
							customInput:
								property === undefined
									? undefined
									: { property, jsonBuffer: { input: "", started: false, closed: false } },
							streamIndex: index,
						};
						if (index !== undefined) byIndex.set(index, block);
						if (call.id) byId.set(call.id, block);
						blocks.push(block);
						events.push({ type: "toolcall_start", contentIndex: position(block), partial: output });
					}
					if (index !== undefined && block.streamIndex === undefined) {
						block.streamIndex = index;
						byIndex.set(index, block);
					}
					if (call.id) {
						byId.set(call.id, block);
						block.id ||= call.id;
					}
					block.name ||= name;
					if (call.custom && !call.function && !block.customInput) {
						const property = grammar.get(block.name) ?? "input";
						block.customInput = {
							property,
							jsonBuffer: { input: "", started: false, closed: false },
						};
						block.arguments = { [property]: "" };
						delete block.partialArgs;
					}
					let argumentDelta = "";
					if (call.function?.arguments) {
						argumentDelta = call.function.arguments;
						block.partialArgs = (block.partialArgs ?? "") + argumentDelta;
						block.arguments = parseStreamingJson(block.partialArgs);
					} else if (call.custom?.input) {
						argumentDelta = customDelta(block, customText(block) + call.custom.input, false) ?? "";
					}
					events.push({
						type: "toolcall_delta",
						contentIndex: position(block),
						delta: argumentDelta,
						partial: output,
					});
				}
			}
			for (const block of blocks) {
				const contentIndex = position(block);
				if (block.type === "text")
					events.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				else if (block.type === "thinking") {
					saveDetails(block);
					events.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				} else if (block.type === "toolCall") {
					if (!block.customInput) Object.assign(block, parseToolCallArguments(block.partialArgs));
					else {
						const ending = customDelta(block, customText(block), true);
						if (ending !== undefined)
							events.push({ type: "toolcall_delta", contentIndex, delta: ending, partial: output });
					}
					delete block.partialArgs;
					delete block.customInput;
					delete block.streamIndex;
					events.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
				}
			}
			if (options.signal?.aborted || output.stopReason === "aborted") throw new Error("Request was aborted");
			if (!finished && !compat.supportsFinishReason)
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			if (output.stopReason === "error")
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			if ((compat.supportsFinishReason && !finished) || output.stopReason === "pending")
				throw new Error("Stream ended without finish_reason");
			events.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "thinking") saveDetails(block);
				for (const field of ["index", "partialArgs", "customInput", "streamIndex"])
					Reflect.deleteProperty(block, field);
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			if (typeof error === "object" && error !== null && "error" in error) {
				const body = error.error;
				if (typeof body === "object" && body !== null && "metadata" in body) {
					const metadata = body.metadata;
					if (
						typeof metadata === "object" &&
						metadata !== null &&
						"raw" in metadata &&
						metadata.raw &&
						!output.errorMessage.includes(String(metadata.raw))
					)
						output.errorMessage += `\n${metadata.raw}`;
				}
			}
			events.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			events.end();
		}
	})();
	return events;
};
export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model,
	context,
	options = {},
) => {
	apiKey(model, options);
	const base = {
		...buildBaseOptions(model, context, options, options.apiKey),
		toolChoice: options.toolChoice,
	};
	const level = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return stream(model, context, {
		...base,
		reasoningEffort: level === "off" ? undefined : level,
		thinkingBudgets: options.thinkingBudgets,
	});
};
