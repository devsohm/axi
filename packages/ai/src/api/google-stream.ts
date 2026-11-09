import type { GenerateContentResponse } from "@google/genai";
import { calculateCost } from "../models.ts";
import type { AssistantMessage, Model, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { isThinkingPart, mapStopReason, retainThoughtSignature } from "./google-shared.ts";
import type { GoogleOptions } from "./options.ts";
export function googleStream(
	model: Model<"google-generative-ai" | "google-vertex">,
	options: GoogleOptions,
	setup: () => Promise<AsyncIterable<GenerateContentResponse>>,
	nextToolId: (name: string | undefined) => string,
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
		let current: TextContent | ThinkingContent | undefined;
		const index = () => output.content.length - 1;
		const endBlock = () => {
			if (current?.type === "text")
				events.push({ type: "text_end", contentIndex: index(), content: current.text, partial: output });
			else if (current?.type === "thinking")
				events.push({ type: "thinking_end", contentIndex: index(), content: current.thinking, partial: output });
			current = undefined;
		};
		try {
			const source = await setup();
			events.push({ type: "start", partial: output });
			for await (const chunk of source) {
				await options.onProviderStreamEvent?.(chunk, model);
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (part.text !== undefined) {
						const kind = isThinkingPart(part) ? "thinking" : "text";
						if (current?.type !== kind) {
							endBlock();
							current =
								kind === "thinking"
									? { type: "thinking", thinking: "", thinkingSignature: undefined }
									: { type: "text", text: "" };
							output.content.push(current);
							events.push({
								type: kind === "thinking" ? "thinking_start" : "text_start",
								contentIndex: index(),
								partial: output,
							});
						}
						if (current.type === "thinking") {
							current.thinking += part.text;
							current.thinkingSignature = retainThoughtSignature(current.thinkingSignature, part.thoughtSignature);
							events.push({ type: "thinking_delta", contentIndex: index(), delta: part.text, partial: output });
						} else {
							current.text += part.text;
							current.textSignature = retainThoughtSignature(current.textSignature, part.thoughtSignature);
							events.push({ type: "text_delta", contentIndex: index(), delta: part.text, partial: output });
						}
					}
					if (part.functionCall) {
						endBlock();
						const call = part.functionCall;
						const id =
							call.id && !output.content.some((block) => block.type === "toolCall" && block.id === call.id)
								? call.id
								: nextToolId(call.name);
						const toolCall: ToolCall = {
							type: "toolCall",
							id,
							name: call.name || "",
							arguments: (call.args ?? {}) as ToolCall["arguments"],
							...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
						};
						output.content.push(toolCall);
						events.push({ type: "toolcall_start", contentIndex: index(), partial: output });
						events.push({
							type: "toolcall_delta",
							contentIndex: index(),
							delta: JSON.stringify(toolCall.arguments),
							partial: output,
						});
						events.push({ type: "toolcall_end", contentIndex: index(), toolCall, partial: output });
					}
				}
				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.stopReason === "stop" && output.content.some((block) => block.type === "toolCall"))
						output.stopReason = "toolUse";
				}
				const usage = chunk.usageMetadata;
				if (usage) {
					output.usage = {
						input: (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0),
						output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
						cacheRead: usage.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: usage.thoughtsTokenCount || 0,
						totalTokens: usage.totalTokenCount || 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					calculateCost(model, output.usage);
				}
			}
			endBlock();
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending")
				throw new Error(
					`${model.api === "google-vertex" ? "Google Vertex" : "Google"} stream ended without a finish reason`,
				);
			if (output.stopReason === "error" || output.stopReason === "aborted")
				throw new Error(
					output.rawStopReason ? `Provider stopped with: ${output.rawStopReason}` : "An unknown error occurred",
				);
			events.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			events.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			events.end();
		}
	})();
	return events;
}
