import type { Message, Model, TranscriptContext } from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import { getCurrentTools } from "../utils/transcript.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import type { MistralOptions } from "./options.ts";
import { transformMessages } from "./transform-messages.ts";
type Chunk =
	| { type: "text"; text: string }
	| { type: "image_url"; imageUrl: string }
	| { type: "thinking"; thinking: { type: "text"; text: string }[] };
interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | Chunk[];
	toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string }; index: number }[];
	toolCallId?: string;
	name?: string;
	prefix?: boolean;
}
export interface MistralPayload extends Record<string, unknown> {
	model: string;
	stream: boolean;
	messages: ChatMessage[];
}
export function mistralToolId(id: string, attempt = 0): string {
	const stripped = id.replace(/[^a-zA-Z0-9]/g, "");
	if (!attempt && stripped.length === 9) return stripped;
	const seed = stripped || id;
	return shortHash(attempt ? `${seed}:${attempt}` : seed)
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(0, 9);
}
function cleanSymbols(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cleanSymbols);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) result[key] = cleanSymbols(nested);
	return result;
}
function chatMessages(messages: Message[], images: boolean): ChatMessage[] {
	const output: ChatMessage[] = [];
	const image = (block: { mimeType: string; data: string }): Chunk => ({
		type: "image_url",
		imageUrl: `data:${block.mimeType};base64,${block.data}`,
	});
	for (const [index, message] of messages.entries()) {
		if (message.role === "system") {
			const text = index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message);
			if (text.length) output.push({ role: "system", content: sanitizeSurrogates(text) });
		} else if (message.role === "user") {
			if (typeof message.content === "string")
				output.push({ role: "user", content: sanitizeSurrogates(message.content) });
			else {
				const content: Chunk[] = message.content
					.filter((block) => block.type === "text" || images)
					.map((block) =>
						block.type === "text" ? { type: "text", text: sanitizeSurrogates(block.text) } : image(block),
					);
				if (content.length) output.push({ role: "user", content });
				else if (message.content.some((block) => block.type === "image") && !images)
					output.push({ role: "user", content: "(image omitted: model does not support images)" });
			}
		} else if (message.role === "assistant") {
			const content: Chunk[] = [],
				toolCalls: NonNullable<ChatMessage["toolCalls"]> = [];
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text.trim()) content.push({ type: "text", text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					if (block.thinking.trim())
						content.push({ type: "thinking", thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }] });
				} else
					toolCalls.push({
						id: block.id,
						type: "function",
						function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
						index: 0,
					});
			}
			if (content.length || toolCalls.length)
				output.push({
					role: "assistant",
					prefix: false,
					...(content.length ? { content } : {}),
					...(toolCalls.length ? { toolCalls } : {}),
				});
		} else {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => sanitizeSurrogates(block.text))
				.join("\n")
				.trim();
			const hasImages = message.content.some((block) => block.type === "image");
			const prefix = message.isError ? "[tool error] " : "";
			const description = text
				? text + (hasImages && !images ? "\n[tool image omitted: model does not support images]" : "")
				: hasImages
					? images
						? "(see attached image)"
						: "(image omitted: model does not support images)"
					: "(no tool output)";
			const content: Chunk[] = [{ type: "text", text: prefix + description }];
			if (images) content.push(...message.content.filter((block) => block.type === "image").map(image));
			output.push({ role: "tool", toolCallId: message.toolCallId, name: message.toolName, content });
		}
	}
	return output;
}
export function mistralRequest(
	model: Model<"mistral-conversations">,
	context: TranscriptContext,
	options: MistralOptions,
): MistralPayload {
	const ids = new Map<string, string>(),
		owners = new Map<string, string>();
	const normalize = (id: string) => {
		const previous = ids.get(id);
		if (previous) return previous;
		for (let attempt = 0; ; attempt++) {
			const next = mistralToolId(id, attempt),
				owner = owners.get(next);
			if (!owner || owner === id) {
				ids.set(id, next);
				owners.set(next, id);
				return next;
			}
		}
	};
	const tools = getCurrentTools(context.messages);
	const payload: MistralPayload = {
		model: model.id,
		stream: true,
		messages: chatMessages(transformMessages(context.messages, model, normalize), model.input.includes("image")),
	};
	if (tools.length)
		payload.tools = tools.map((tool) => {
			const strict = resolveJsonSchemaStrictSampling(tool, true);
			return {
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: cleanSymbols(getJsonSchemaToolParameters(tool, strict)),
					strict: strict ?? false,
				},
			};
		});
	if (options.temperature !== undefined) payload.temperature = options.temperature;
	if (options.maxTokens !== undefined) payload.maxTokens = options.maxTokens;
	if (options.toolChoice)
		payload.toolChoice =
			typeof options.toolChoice === "string"
				? options.toolChoice
				: { type: "function", function: { name: options.toolChoice.function.name } };
	if (options.promptMode) payload.promptMode = options.promptMode;
	if (options.reasoningEffort) payload.reasoningEffort = options.reasoningEffort;
	if (options.sessionId && options.cacheRetention !== "none") payload.promptCacheKey = options.sessionId;
	return payload;
}
function rename(
	input: Record<string, unknown>,
	pairs: readonly (readonly [string, string])[],
): Record<string, unknown> {
	const output = { ...input };
	for (const [from, to] of pairs)
		if (from in output) {
			output[to] = output[from];
			delete output[from];
		}
	return output;
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function mistralWirePayload(payload: MistralPayload): Record<string, unknown> {
	const result = rename(payload, [
		["topP", "top_p"],
		["maxTokens", "max_tokens"],
		["randomSeed", "random_seed"],
		["responseFormat", "response_format"],
		["toolChoice", "tool_choice"],
		["presencePenalty", "presence_penalty"],
		["frequencyPenalty", "frequency_penalty"],
		["parallelToolCalls", "parallel_tool_calls"],
		["reasoningEffort", "reasoning_effort"],
		["promptMode", "prompt_mode"],
		["promptCacheKey", "prompt_cache_key"],
		["safePrompt", "safe_prompt"],
	]);
	result.messages = payload.messages.map((message) => ({
		...rename({ ...message }, [
			["toolCalls", "tool_calls"],
			["toolCallId", "tool_call_id"],
		]),
		...(Array.isArray(message.content)
			? {
					content: message.content.map((chunk) =>
						rename({ ...chunk }, [
							["imageUrl", "image_url"],
							["documentUrl", "document_url"],
							["documentName", "document_name"],
							["fileId", "file_id"],
							["referenceIds", "reference_ids"],
							["inputAudio", "input_audio"],
						]),
					),
				}
			: {}),
	}));
	if (record(result.response_format)) {
		const format = rename(result.response_format, [["jsonSchema", "json_schema"]]);
		if (record(format.json_schema)) format.json_schema = rename(format.json_schema, [["schemaDefinition", "schema"]]);
		result.response_format = format;
	}
	return result;
}
