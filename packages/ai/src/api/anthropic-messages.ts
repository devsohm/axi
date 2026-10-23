import Anthropic from "@anthropic-ai/sdk";
import type {
	BetaInputTransformation,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { calculateCost } from "../models.ts";
import type {
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { applyOpenRouterReportedCost, isOpenRouterModel } from "../utils/openrouter-cost.ts";
import { parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getCurrentTools, resolveTranscript } from "../utils/transcript.ts";
import { anthropicClient, anthropicCompat, anthropicFederation, assertAnthropicAuth } from "./anthropic-client.ts";
import { anthropicRequest } from "./anthropic-request.ts";
import { anthropicEvents } from "./anthropic-sse.ts";
import type { AnthropicEffort, AnthropicOptions } from "./options.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.ts";

export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./options.ts";

type WireUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
	output_tokens_details?: { thinking_tokens?: number | null } | null;
};
type StreamingBlock = (TextContent | ThinkingContent | (ToolCall & { partialJson?: string })) & { index?: number };
function updateUsage(usage: Usage, raw: WireUsage, initial: boolean): void {
	for (const [field, value] of [
		["input", raw.input_tokens],
		["output", raw.output_tokens],
		["cacheRead", raw.cache_read_input_tokens],
		["cacheWrite", raw.cache_creation_input_tokens],
		["cacheWrite1h", raw.cache_creation?.ephemeral_1h_input_tokens],
	] as const)
		if (initial || value != null) usage[field] = value || 0;
	if (!initial && raw.output_tokens_details?.thinking_tokens != null)
		usage.reasoning = raw.output_tokens_details.thinking_tokens;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function mayDowngrade(error: unknown): boolean {
	return (
		error instanceof Anthropic.APIError &&
		error.status === 400 &&
		error.type === "invalid_request_error" &&
		[
			"The compiled grammar is too large",
			"Too many strict tools (",
			"Schemas contains too many parameters with union types (",
		].some((message) => error.message.includes(message))
	);
}
export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (model, context, options = {}) => {
	const events = new AssistantMessageEventStream();
	const transcript = resolveTranscript(context, anthropicCompat(model).supportsMidConvoSystemMessages);
	const tools = getCurrentTools(transcript.messages);
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
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
	void (async () => {
		try {
			const { client, oauth } = anthropicClient(model, transcript, options);
			const requestOptions = {
				maxRetries: 0,
				...(options.signal ? { signal: options.signal } : {}),
				...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			};
			let downgraded = false,
				response: Response;
			for (;;) {
				options.signal?.throwIfAborted();
				const request = anthropicRequest(model, transcript, options, oauth, downgraded);
				if (request.level) output.providerThinkingLevel = request.level;
				const replacement = await options.onPayload?.(request.body, model);
				const body =
					replacement === undefined
						? request.body
						: { ...(replacement as MessageCreateParamsStreaming), stream: true as const };
				try {
					response = await retryProviderRequest(() => client.beta.messages.create(body, requestOptions).asResponse(), {
						maxRetries: options.maxRetries,
						maxRetryDelayMs: options.maxRetryDelayMs,
						signal: options.signal,
					});
					break;
				} catch (error) {
					if (options.signal?.aborted || downgraded || !request.preferred || !mayDowngrade(error)) throw error;
					downgraded = true;
					appendAssistantMessageDiagnostic(output, {
						type: "anthropic_strict_tools_fallback",
						timestamp: Date.now(),
						error: { message: error instanceof Error ? error.message : String(error) },
						details: { reason: "strict_tool_limits_exceeded" },
					});
				}
			}
			await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			events.push({ type: "start", partial: output });
			const blocks = output.content as StreamingBlock[];
			let pricingModel = model;
			let transformations: BetaInputTransformation[] | undefined;
			for await (const event of anthropicEvents(response, options.signal)) {
				await options.onProviderStreamEvent?.(event, model);
				switch (event.type) {
					case "message_start": {
						output.responseId = event.message.id;
						if (Array.isArray(event.message.input_transformations))
							transformations = event.message.input_transformations;
						const served = event.message.model;
						if (served !== model.id) output.responseModel = served;
						const rates =
							served === model.id
								? undefined
								: model.compat?.allowedFallbackModels?.find(
										(fallback) => fallback.provider === model.provider && fallback.model === served,
									)?.cost;
						pricingModel = rates ? { ...model, id: served, cost: rates } : model;
						updateUsage(output.usage, event.message.usage, true);
						calculateCost(pricingModel, output.usage);
						break;
					}
					case "content_block_start": {
						const incoming = event.content_block;
						let block: StreamingBlock;
						switch (incoming.type) {
							case "fallback":
								if (output.content.length)
									throw new Error("Anthropic performed an unsupported mid-output model fallback");
								continue;
							case "text":
								block = { type: "text", text: incoming.text ?? "" };
								break;
							case "thinking":
								block = {
									type: "thinking",
									thinking: incoming.thinking ?? "",
									thinkingSignature: incoming.signature ?? "",
								};
								break;
							case "redacted_thinking":
								block = {
									type: "thinking",
									thinking: "[Reasoning redacted]",
									thinkingSignature: incoming.data,
									redacted: true,
								};
								break;
							case "tool_use":
								block = {
									type: "toolCall",
									id: incoming.id,
									name: oauth
										? (tools.find((tool) => tool.name.toLowerCase() === incoming.name.toLowerCase())?.name ??
											incoming.name)
										: incoming.name,
									arguments: (incoming.input as ToolCall["arguments"]) ?? {},
									partialJson: "",
								};
								break;
							default:
								continue;
						}
						const position = output.content.length;
						block.index = event.index;
						output.content.push(block);
						const type =
							block.type === "toolCall"
								? "toolcall_start"
								: block.type === "thinking"
									? "thinking_start"
									: "text_start";
						events.push({ type, contentIndex: position, partial: output });
						break;
					}
					case "content_block_delta": {
						const contentIndex = blocks.findIndex((block) => block.index === event.index);
						const block = blocks[contentIndex],
							delta = event.delta;
						if (!block) break;
						if (delta.type === "text_delta" && block.type === "text") {
							block.text += delta.text;
							events.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
						} else if (delta.type === "thinking_delta" && block.type === "thinking") {
							block.thinking += delta.thinking;
							events.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
						} else if (delta.type === "signature_delta" && block.type === "thinking")
							block.thinkingSignature = (block.thinkingSignature || "") + delta.signature;
						else if (delta.type === "input_json_delta" && block.type === "toolCall") {
							block.partialJson = (block.partialJson ?? "") + delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							events.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: output });
						}
						break;
					}
					case "content_block_stop": {
						const contentIndex = blocks.findIndex((block) => block.index === event.index);
						const block = blocks[contentIndex];
						if (!block) break;
						delete block.index;
						if (block.type === "text")
							events.push({ type: "text_end", contentIndex, content: block.text, partial: output });
						else if (block.type === "thinking")
							events.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
						else if (block.type === "toolCall") {
							Object.assign(block, parseToolCallArguments(block.partialJson));
							delete block.partialJson;
							events.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
						}
						break;
					}
					case "message_delta": {
						if (Array.isArray(event.input_transformations)) transformations = event.input_transformations;
						const reason = event.delta.stop_reason;
						if (reason) {
							output.rawStopReason = reason;
							switch (reason as string) {
								case "end_turn":
								case "pause_turn":
								case "stop_sequence":
									output.stopReason = "stop";
									break;
								case "tool_use":
									output.stopReason = "toolUse";
									break;
								case "max_tokens":
									output.stopReason = "length";
									break;
								case "refusal":
									output.stopReason = "error";
									output.errorMessage =
										event.delta.stop_details?.explanation || "The model refused to complete the request";
									break;
								case "sensitive":
									output.stopReason = "error";
									output.errorMessage = "Provider stopped with: sensitive";
									break;
								default:
									throw new Error(`Unhandled stop reason: ${reason}`);
							}
						}
						if (event.usage) updateUsage(output.usage, event.usage, false);
						calculateCost(pricingModel, output.usage);
						if (isOpenRouterModel(model)) applyOpenRouterReportedCost(output.usage, event.usage);
						break;
					}
				}
			}
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") throw new Error("Anthropic stream ended without a stop reason");
			if (output.stopReason === "aborted" || output.stopReason === "error")
				throw new Error(output.errorMessage || "An unknown error occurred");
			if (transformations?.length)
				appendAssistantMessageDiagnostic(output, {
					type: "anthropic_input_transformations",
					timestamp: Date.now(),
					details: {
						transformations: transformations.map((item) => ({
							type: item.type ?? undefined,
							path: item.path ?? undefined,
							reason: item.reason ?? undefined,
						})),
					},
				});
			events.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			for (const block of output.content) {
				Reflect.deleteProperty(block, "index");
				Reflect.deleteProperty(block, "partialJson");
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			events.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			events.end();
		}
	})();
	return events;
};
function effortFor(model: Model<"anthropic-messages">, level: SimpleStreamOptions["reasoning"]): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;
	return level === "minimal" || level === "low" ? "low" : level === "medium" ? "medium" : "high";
}
export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model,
	context,
	options = {},
) => {
	if (!anthropicFederation(model, options)) assertAnthropicAuth(model, options);
	const base: AnthropicOptions = {
		...buildBaseOptions(model, context, options, options.apiKey),
		toolChoice: options.toolChoice,
	};
	if (!options.reasoning) return stream(model, context, { ...base, thinkingEnabled: false });
	if (model.compat?.forceAdaptiveThinking)
		return stream(model, context, { ...base, thinkingEnabled: true, effort: effortFor(model, options.reasoning) });
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
	});
};
