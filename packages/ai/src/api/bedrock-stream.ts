import {
	BedrockRuntimeServiceException,
	CacheTTL,
	type ConverseStreamMetadataEvent,
	type ConverseStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { calculateCost } from "../models.ts";
import type { AssistantMessage, JsonObject, Model, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import type { BedrockOptions } from "./options.ts";
type StreamingBlock = (TextContent | ThinkingContent | ToolCall) & {
	index?: number;
	partialJson?: string;
	redactedChunks?: Uint8Array[];
};
function bounded(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200 ? value.trim() : undefined;
}
function failure(output: AssistantMessage, error: unknown, requestId?: string): void {
	const normalized = normalizeProviderError(error);
	const core =
		!normalized.messageCarriesBody && normalized.status !== undefined && normalized.body !== undefined
			? `${normalized.status}: ${normalized.body}`
			: normalized.message;
	const prefixes: Record<string, string> = {
		InternalServerException: "Internal server error",
		ModelStreamErrorException: "Model stream error",
		ValidationException: "Validation error",
		ThrottlingException: "Throttling error",
		ServiceUnavailableException: "Service unavailable",
	};
	output.errorMessage = `${error instanceof BedrockRuntimeServiceException ? `${prefixes[error.name] ?? error.name}: ` : ""}${core}${/data retention mode/i.test(core) ? " See https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html for supported data retention modes." : ""}`;
	if (output.stopReason !== "error") return;
	const metadata = error !== null && typeof error === "object" && "$metadata" in error ? error.$metadata : undefined;
	const details: JsonObject = {};
	if (metadata && typeof metadata === "object") {
		if ("httpStatusCode" in metadata && typeof metadata.httpStatusCode === "number")
			details.status = metadata.httpStatusCode;
		if ("requestId" in metadata) requestId = bounded(metadata.requestId) ?? requestId;
	}
	if (requestId !== undefined) details.requestId = requestId;
	const code = error instanceof Error && error.name.endsWith("Exception") ? bounded(error.name) : undefined;
	if (code !== undefined) details.errorCode = code;
	if (Object.keys(details).length)
		appendAssistantMessageDiagnostic(output, { type: "bedrock_response_failure", timestamp: Date.now(), details });
}
function usage(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	const source = event.usage;
	if (!source) return;
	Object.assign(output.usage, {
		input: source.inputTokens || 0,
		output: source.outputTokens || 0,
		cacheRead: source.cacheReadInputTokens || 0,
		cacheWrite: source.cacheWriteInputTokens || 0,
		cacheWrite1h: source.cacheDetails?.reduce(
			(sum, detail) => sum + (detail.ttl === CacheTTL.ONE_HOUR ? (detail.inputTokens ?? 0) : 0),
			0,
		),
		totalTokens: source.totalTokens || (source.inputTokens || 0) + (source.outputTokens || 0),
	});
	calculateCost(model, output.usage);
}
function flush(block: StreamingBlock): void {
	if (block.type !== "thinking" || !block.redactedChunks) return;
	let binary = "";
	for (const bytes of block.redactedChunks)
		for (let offset = 0; offset < bytes.length; offset += 0x8000)
			binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	block.thinkingSignature = btoa(binary);
	delete block.redactedChunks;
}
function finishBlock(block: StreamingBlock): void {
	delete block.index;
	delete block.partialJson;
	flush(block);
}
export function bedrockStream(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
	setup: () => Promise<{ response: ConverseStreamCommandOutput; observed: boolean }>,
): AssistantMessageEventStream {
	const events = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
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
		const blocks: StreamingBlock[] = output.content;
		let requestId: string | undefined;
		const add = (index: number | undefined, block: StreamingBlock): StreamingBlock => {
			block.index = index;
			blocks.push(block);
			const contentIndex = output.content.length - 1;
			events.push({
				type: block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start",
				contentIndex,
				partial: output,
			});
			return block;
		};
		try {
			const { response, observed } = await setup();
			requestId = bounded(response.$metadata.requestId);
			if (!observed && response.$metadata.httpStatusCode !== undefined)
				await options.onResponse?.(
					{
						status: response.$metadata.httpStatusCode,
						headers: response.$metadata.requestId ? { "x-amzn-requestid": response.$metadata.requestId } : {},
					},
					model,
				);
			for await (const item of response.stream!) {
				await options.onProviderStreamEvent?.(item, model);
				if (item.messageStart) {
					if (item.messageStart.role !== "assistant")
						throw new Error("Unexpected assistant message start but got user message start instead");
					events.push({ type: "start", partial: output });
				} else if (item.contentBlockStart) {
					const tool = item.contentBlockStart.start?.toolUse;
					if (tool)
						add(item.contentBlockStart.contentBlockIndex, {
							type: "toolCall",
							id: tool.toolUseId || "",
							name: tool.name || "",
							arguments: {},
							partialJson: "",
						});
				} else if (item.contentBlockDelta) {
					const { delta, contentBlockIndex } = item.contentBlockDelta;
					let block = blocks.find((block) => block.index === contentBlockIndex);
					if (delta?.text !== undefined) {
						block ??= add(contentBlockIndex, { type: "text", text: "" });
						if (block.type === "text") {
							block.text += delta.text;
							events.push({
								type: "text_delta",
								contentIndex: blocks.indexOf(block),
								delta: delta.text,
								partial: output,
							});
						}
					} else if (delta?.toolUse && block?.type === "toolCall") {
						block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
						block.arguments = parseStreamingJson(block.partialJson);
						events.push({
							type: "toolcall_delta",
							contentIndex: blocks.indexOf(block),
							delta: delta.toolUse.input || "",
							partial: output,
						});
					} else if (delta?.reasoningContent) {
						block ??= add(contentBlockIndex, { type: "thinking", thinking: "", thinkingSignature: "" });
						const contentIndex = blocks.indexOf(block),
							reasoning = delta.reasoningContent;
						if (block.type !== "thinking") continue;
						if (reasoning.text) {
							block.thinking += reasoning.text;
							events.push({ type: "thinking_delta", contentIndex, delta: reasoning.text, partial: output });
						}
						if (reasoning.signature && !block.redacted)
							block.thinkingSignature = (block.thinkingSignature || "") + reasoning.signature;
						if (reasoning.redactedContent?.length) {
							if (!block.redacted) {
								block.redacted = true;
								block.thinkingSignature = "";
								block.thinking += "[Reasoning redacted]";
								events.push({ type: "thinking_delta", contentIndex, delta: "[Reasoning redacted]", partial: output });
							}
							block.redactedChunks ??= [];
							block.redactedChunks.push(reasoning.redactedContent);
						}
					}
				} else if (item.contentBlockStop) {
					const target = item.contentBlockStop.contentBlockIndex;
					const contentIndex = blocks.findIndex((block) => block.index === target);
					const block = blocks[contentIndex];
					if (!block) continue;
					delete block.index;
					if (block.type === "text")
						events.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					else if (block.type === "thinking") {
						flush(block);
						events.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
					} else {
						Object.assign(block, parseToolCallArguments(block.partialJson));
						delete block.partialJson;
						events.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
					}
				} else if (item.messageStop) {
					const reason = item.messageStop.stopReason;
					output.rawStopReason = reason;
					output.stopReason =
						reason === "end_turn" || reason === "stop_sequence"
							? "stop"
							: reason === "max_tokens" || reason === "model_context_window_exceeded"
								? "length"
								: reason === "tool_use"
									? "toolUse"
									: "error";
					if (output.stopReason === "error" && reason) output.errorMessage = `Provider stopped with: ${reason}`;
				} else if (item.metadata) usage(item.metadata, model, output);
				else
					for (const key of [
						"internalServerException",
						"modelStreamErrorException",
						"validationException",
						"throttlingException",
						"serviceUnavailableException",
					] as const)
						if (item[key]) throw item[key];
			}
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") throw new Error("Bedrock stream ended without a stop reason");
			if (output.stopReason === "error" || output.stopReason === "aborted")
				throw new Error(output.errorMessage || "An unknown error occurred");
			for (const block of blocks) finishBlock(block);
			events.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			for (const block of blocks) finishBlock(block);
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			failure(output, error, requestId);
			events.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			events.end();
		}
	})();
	return events;
}
