import type OpenAI from "openai";
import type {
	ChatCompletionMessageParam,
	ChatCompletionAssistantMessageParam,
	ChatCompletionContentPart,
} from "openai/resources/chat/completions.js";
import type { JsonValue, Model, Tool, TranscriptContext } from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import { resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import {
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import type { CompletionsCompat } from "./openai-completions-compat.ts";
import { transformMessages } from "./transform-messages.ts";

export interface ConvertCompletionsMessagesOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}
type DetailBase = Record<string, JsonValue> & { id?: string | null; format?: string; index?: number };
export type ReasoningDetail = DetailBase &
	(
		| { type: "reasoning.text"; text: string; signature?: string | null }
		| { type: "reasoning.summary"; summary: string }
		| { type: "reasoning.encrypted"; data: string }
	);
export function isReasoningDetail(value: unknown): value is ReasoningDetail {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	if (entry.id != null && typeof entry.id !== "string") return false;
	if (entry.format !== undefined && typeof entry.format !== "string") return false;
	if (entry.index !== undefined && typeof entry.index !== "number") return false;
	switch (entry.type) {
		case "reasoning.text":
			return typeof entry.text === "string" && (entry.signature == null || typeof entry.signature === "string");
		case "reasoning.summary":
			return typeof entry.summary === "string";
		case "reasoning.encrypted":
			return typeof entry.data === "string";
		default:
			return false;
	}
}
function signatureDetails(signature?: string): ReasoningDetail[] | undefined {
	if (!signature) return undefined;
	try {
		const parsed: unknown = JSON.parse(signature);
		return Array.isArray(parsed) && parsed.length && parsed.every(isReasoningDetail) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
function legacyDetail(signature?: string): ReasoningDetail | undefined {
	if (!signature) return undefined;
	try {
		const parsed: unknown = JSON.parse(signature);
		return isReasoningDetail(parsed) && parsed.type === "reasoning.encrypted" && parsed.id && parsed.data
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}
function toolId(id: string, provider: string): string {
	const separator = id.indexOf("|");
	if (separator < 0) return provider === "openai" ? id.slice(0, 40) : id;
	const call = id.slice(0, separator).replace(/[^\w-]/g, "_");
	const item = id.slice(separator + 1).replace(/[^\w-]/g, "_");
	const combined = item ? `${call}_${item}` : call;
	return combined.length <= 40 ? combined : `${call.slice(0, 31)}_${shortHash(id).slice(0, 8)}`;
}
export function completionsTools(
	tools: Tool[],
	compat: CompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		if (grammar)
			return {
				type: "custom",
				custom: {
					name: tool.name,
					description: tool.description,
					format: { type: "grammar", grammar: { syntax: grammar.format, definition: grammar.definition } },
				},
			};
		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict) as Record<string, unknown>,
				...(compat.supportsStrictMode ? { strict: strict ?? false } : {}),
			},
		};
	});
}
export function convertMessages(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	compat: CompletionsCompat,
	options?: ConvertCompletionsMessagesOptions,
): ChatCompletionMessageParam[] {
	const transcript = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const tools = resolveTranscriptTools(
		transcript.messages,
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true
			? "additions"
			: "none",
	);
	const input = transformMessages(transcript.messages, model, (id) => toolId(id, model.provider));
	const output: ChatCompletionMessageParam[] = [];
	let previous = "";
	let systemIndex = 0;
	const bridge = () => output.push({ role: "assistant", content: "I have processed the tool results." });
	for (let index = 0; index < input.length; index++) {
		const message = input[index];
		if (compat.requiresAssistantAfterToolResult && previous === "toolResult" && message.role === "user") bridge();
		switch (message.role) {
			case "system": {
				if (systemIndex++ >= tools.foldedSystemMessages && message.toolsAdded?.length)
					output.push({
						role: "system",
						tools: completionsTools(message.toolsAdded, compat),
					} as unknown as ChatCompletionMessageParam);
				const text = index ? renderSystemMessageUpdate(message) : getSystemMessageText(message);
				if (text)
					output.push({
						role: model.reasoning && compat.supportsDeveloperRole ? "developer" : "system",
						content: sanitizeSurrogates(text),
					});
				break;
			}
			case "user": {
				if (typeof message.content === "string")
					output.push({ role: "user", content: sanitizeSurrogates(message.content) });
				else {
					const content: ChatCompletionContentPart[] = [];
					for (const block of message.content) {
						if (block.type === "image")
							content.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
						else if (block.text.length) content.push({ type: "text", text: sanitizeSurrogates(block.text) });
					}
					if (!content.length) continue;
					output.push({ role: "user", content });
				}
				break;
			}
			case "assistant": {
				const answer: ChatCompletionAssistantMessageParam & {
					reasoning_details?: ReasoningDetail[];
					reasoning_content?: string;
					reasoning?: string;
					reasoning_text?: string;
				} = {
					role: "assistant",
					content: compat.requiresAssistantAfterToolResult ? "" : null,
				};
				const text = message.content
					.filter((block) => block.type === "text")
					.filter((block) => block.text.trim())
					.map((block) => ({ type: "text" as const, text: sanitizeSurrogates(block.text) }));
				const thinking = message.content.filter((block) => block.type === "thinking");
				const calls = message.content.filter((block) => block.type === "toolCall");
				const signed = thinking
					.map((block) => signatureDetails(block.thinkingSignature))
					.find((value) => value !== undefined);
				const legacy = calls.map((call) => legacyDetail(call.thoughtSignature)).filter((value) => value !== undefined);
				const details = signed ?? (legacy.length ? legacy : undefined);
				const nonempty = thinking.filter((block) => block.thinking.trim());
				const joined = text.map((part) => part.text).join("");
				if (nonempty.length && compat.requiresThinkingAsText) {
					answer.content = [
						{ type: "text", text: nonempty.map((block) => sanitizeSurrogates(block.thinking)).join("\n\n") },
						...text,
					];
				} else {
					if (joined) answer.content = joined;
					if (nonempty.length && !details) {
						let field = nonempty[0].thinkingSignature;
						if (model.provider === "opencode-go" && field === "reasoning") field = "reasoning_content";
						if (field === "reasoning" || field === "reasoning_content" || field === "reasoning_text")
							answer[field] = nonempty.map((block) => block.thinking).join("\n");
					}
				}
				if (calls.length)
					answer.tool_calls = calls.map((call) => {
						const property = options?.grammarToolInputProperties?.get(call.name);
						return property === undefined
							? {
									type: "function",
									id: call.id,
									function: { name: call.name, arguments: JSON.stringify(call.arguments) },
								}
							: {
									type: "custom",
									id: call.id,
									custom: {
										name: call.name,
										input: sanitizeSurrogates(getGrammarToolInput(call.name, call.arguments, property)),
									},
								};
					});
				if (details) answer.reasoning_details = details;
				if (compat.requiresReasoningContentOnAssistantMessages && model.reasoning) answer.reasoning_content ??= "";
				if (!answer.content?.length && !answer.tool_calls) continue;
				output.push(answer);
				break;
			}
			case "toolResult": {
				const images: ChatCompletionContentPart[] = [];
				do {
					const result = input[index];
					if (result.role !== "toolResult") break;
					const text = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					const hasImage = result.content.some((block) => block.type === "image");
					output.push({
						role: "tool",
						tool_call_id: result.toolCallId,
						content: sanitizeSurrogates(text.trim() ? text : hasImage ? "(see attached image)" : "(no tool output)"),
						...(compat.requiresToolResultName && result.toolName ? { name: result.toolName } : {}),
					});
					if (model.input.includes("image"))
						for (const block of result.content)
							if (block.type === "image")
								images.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
					index++;
				} while (index < input.length && input[index].role === "toolResult");
				index--;
				if (images.length) {
					if (compat.requiresAssistantAfterToolResult) bridge();
					output.push({
						role: "user",
						content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images],
					});
				}
				previous = images.length ? "user" : "toolResult";
				continue;
			}
		}
		previous = message.role;
	}
	return output;
}
