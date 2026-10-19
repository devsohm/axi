import { calculateCost } from "../models.ts";
import type { AssistantMessage, Model, StreamOptions, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type { MistralChunk } from "./mistral-http.ts";
import { mistralToolId } from "./mistral-request.ts";
function cachedTokens(usage: Record<string, unknown>, prompt: number): number {
	const fields = usage as {
		promptTokensDetails?: { cachedTokens?: unknown } | null;
		prompt_tokens_details?: { cached_tokens?: unknown } | null;
		promptTokenDetails?: { cachedTokens?: unknown } | null;
		prompt_token_details?: { cached_tokens?: unknown } | null;
		numCachedTokens?: unknown;
		num_cached_tokens?: unknown;
	};
	const cached =
		fields.promptTokensDetails?.cachedTokens ??
		fields.prompt_tokens_details?.cached_tokens ??
		fields.promptTokenDetails?.cachedTokens ??
		fields.prompt_token_details?.cached_tokens ??
		fields.numCachedTokens ??
		fields.num_cached_tokens ??
		0;
	return Math.min(prompt, Math.max(0, typeof cached === "number" && Number.isFinite(cached) ? cached : 0));
}
export async function consumeMistral(
	source: AsyncIterable<MistralChunk>,
	model: Model<"mistral-conversations">,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	observer: StreamOptions["onProviderStreamEvent"],
): Promise<void> {
	let current: TextContent | ThinkingContent | undefined;
	type StreamingCall = ToolCall & { partialArgs?: string };
	const blocks: (TextContent | ThinkingContent | StreamingCall)[] = output.content;
	const tools = new Map<string | number, number>();
	const index = () => output.content.length - 1;
	const endBlock = () => {
		if (current?.type === "text")
			events.push({ type: "text_end", contentIndex: index(), content: current.text, partial: output });
		else if (current?.type === "thinking")
			events.push({ type: "thinking_end", contentIndex: index(), content: current.thinking, partial: output });
		current = undefined;
	};
	const append = (type: "text" | "thinking", text: string) => {
		const delta = sanitizeSurrogates(text);
		if (!delta) return;
		if (current?.type !== type) {
			endBlock();
			current = type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
			output.content.push(current);
			events.push({
				type: type === "text" ? "text_start" : "thinking_start",
				contentIndex: index(),
				partial: output,
			});
		}
		if (current.type === "text") {
			current.text += delta;
			events.push({ type: "text_delta", contentIndex: index(), delta, partial: output });
		} else {
			current.thinking += delta;
			events.push({ type: "thinking_delta", contentIndex: index(), delta, partial: output });
		}
	};
	for await (const chunk of source) {
		await observer?.(chunk, model);
		output.responseId ||= chunk.id;
		if (chunk.usage) {
			const prompt = chunk.usage.prompt_tokens || 0,
				cached = cachedTokens(chunk.usage, prompt);
			Object.assign(output.usage, {
				input: Math.max(0, prompt - cached),
				output: chunk.usage.completion_tokens || 0,
				cacheRead: cached,
				cacheWrite: 0,
			});
			output.usage.totalTokens =
				chunk.usage.total_tokens ||
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			calculateCost(model, output.usage);
		}
		const choice = chunk.choices[0];
		if (!choice) continue;
		const reason = choice.finish_reason;
		if (reason) {
			output.rawStopReason = reason;
			output.stopReason =
				reason === "stop"
					? "stop"
					: reason === "length" || reason === "model_length"
						? "length"
						: reason === "tool_calls"
							? "toolUse"
							: "error";
			if (output.stopReason === "error")
				output.errorMessage = `Provider stopped with: ${reason}${reason === "error" ? " (server error)" : ""}`;
		}
		const delta = choice.delta;
		if (typeof delta.content === "string") append("text", delta.content);
		else
			for (const item of delta.content ?? []) {
				if (item.type === "thinking")
					append(
						"thinking",
						(item.thinking ?? [])
							.map((part) => part.text ?? "")
							.filter(Boolean)
							.join(""),
					);
				else if (item.type === "text") append("text", item.text ?? "");
			}
		for (const call of delta.tool_calls ?? []) {
			endBlock();
			const id = call.id && call.id !== "null" ? call.id : mistralToolId(`toolcall:${call.index ?? 0}`),
				key = call.index ?? id;
			const position = tools.get(key);
			let block = position === undefined ? undefined : blocks[position];
			if (block?.type !== "toolCall") {
				block = { type: "toolCall", id, name: call.function.name, arguments: {}, partialArgs: "" };
				blocks.push(block);
				tools.set(key, index());
				events.push({ type: "toolcall_start", contentIndex: index(), partial: output });
			}
			const text =
				typeof call.function.arguments === "string"
					? call.function.arguments
					: JSON.stringify(call.function.arguments || {});
			block.partialArgs = (block.partialArgs || "") + text;
			block.arguments = parseStreamingJson<ToolCall["arguments"]>(block.partialArgs);
			events.push({
				type: "toolcall_delta",
				contentIndex: tools.get(key)!,
				delta: text,
				partial: output,
			});
		}
	}
	endBlock();
	for (const position of tools.values()) {
		const block = blocks[position];
		if (block.type !== "toolCall") continue;
		Object.assign(block, parseToolCallArguments(block.partialArgs));
		delete block.partialArgs;
		events.push({
			type: "toolcall_end",
			contentIndex: position,
			toolCall: block,
			partial: output,
		});
	}
}
