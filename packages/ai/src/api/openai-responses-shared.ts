import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseOutputItem,
	ResponseReasoningItem,
	ResponseStreamEvent,
	Tool as ResponseTool,
} from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	TranscriptContext,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import { resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import {
	appendGrammarToolInputJsonDelta,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

type ServiceTier = ResponseCreateParamsStreaming["service_tier"];
export interface OpenAIResponsesStreamOptions {
	onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
	serviceTier?: ServiceTier;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (received: ServiceTier, requested: ServiceTier) => ServiceTier;
	applyServiceTierPricing?: (usage: Usage, serviceTier: ServiceTier) => void;
}
export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	toolSearchResult?: boolean;
}
export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	supportsMidConvoSystemMessages?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	toolOptions?: ConvertResponsesToolsOptions;
	configurationUpdateEffort?: string;
}

const signatureSchema = Type.Object({ v: Type.Literal(1), id: Type.String(), phase: Type.Optional(Type.Unknown()) });
function textSignature(
	signature: string | undefined,
): { id: string; phase?: "commentary" | "final_answer" } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(signature);
			if (Value.Check(signatureSchema, parsed))
				return {
					id: parsed.id,
					...(parsed.phase === "commentary" || parsed.phase === "final_answer" ? { phase: parsed.phase } : {}),
				};
		} catch {}
	}
	return { id: signature };
}
function image(image: ImageContent): Extract<ResponseInputContent, { type: "input_image" }> {
	return { type: "input_image", detail: "auto", image_url: `data:${image.mimeType};base64,${image.data}` };
}
function toolOutput(
	model: Model<Api>,
	blocks: readonly (TextContent | ImageContent)[],
): string | ResponseInputContent[] {
	const text = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const images = blocks.filter((block) => block.type === "image");
	if (!images.length || !model.input.includes("image"))
		return sanitizeSurrogates(text.trim() ? text : images.length ? "(see attached image)" : "(no tool output)");
	return [
		...(text.trim() ? [{ type: "input_text" as const, text: sanitizeSurrogates(text) }] : []),
		...images.map(image),
	];
}
export function convertResponsesTools(
	tools: readonly Tool[],
	options: ConvertResponsesToolsOptions = {},
): ResponseTool[] {
	return tools.map((tool): ResponseTool => {
		const deferred = options.toolSearchResult ? { defer_loading: true } : {};
		const grammar = resolveGrammarConstrainedSampling(tool, options.supportsOpenAIGrammarTools ?? false);
		if (grammar)
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: { type: "grammar", syntax: grammar.format, definition: grammar.definition },
				...deferred,
			};
		const supported = options.supportsStrictMode ?? true;
		const strict =
			resolveJsonSchemaStrictSampling(tool, supported) ?? (options.strict === undefined ? false : options.strict);
		const converted = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true),
			...(supported ? { strict } : {}),
			...deferred,
		};
		// Compatible servers can reject strict, although the SDK declares it required.
		return converted as ResponseTool;
	});
}
export function convertResponsesMessages<A extends Api>(
	model: Model<A>,
	context: TranscriptContext,
	allowedToolCallProviders: ReadonlySet<string>,
	options: ConvertResponsesMessagesOptions = {},
): ResponseInput {
	const transcript = resolveTranscript(context, options.supportsMidConvoSystemMessages);
	const bounded = (part: string) =>
		part
			.replace(/[^a-zA-Z0-9_-]/g, "_")
			.slice(0, 64)
			.replace(/_+$/, "");
	const messages = transformMessages(transcript.messages, model, (id, _target, source) => {
		if (!allowedToolCallProviders.has(model.provider) || !id.includes("|")) return bounded(id);
		const [call = "", item = ""] = id.split("|");
		let replayId =
			source.api !== model.api || source.provider !== model.provider ? `fc_${shortHash(item)}` : bounded(item);
		if (!replayId.startsWith("fc_")) replayId = bounded(`fc_${replayId}`);
		return `${bounded(call)}|${replayId}`;
	});
	const tools = resolveTranscriptTools(
		transcript.messages,
		Boolean(options.supportsAdditionalTools || options.supportsToolSearch),
	);
	const result: ResponseInput = [];
	const configuration = (effort: string) =>
		result.push({
			type: "configuration_update",
			reasoning: {
				effort: effort as NonNullable<ResponseCreateParamsStreaming["reasoning"]>["effort"],
			},
		});
	const supportsDeveloper =
		!model.compat || !("supportsDeveloperRole" in model.compat) || model.compat.supportsDeveloperRole !== false;
	const role = model.reasoning && supportsDeveloper ? "developer" : "system";
	let ordinal = 0;
	for (const [sourceIndex, message] of messages.entries()) {
		const leading = sourceIndex === 0 && message.role === "system";
		switch (message.role) {
			case "system": {
				const additions = !leading && tools.anchorsAdditions ? (message.toolsAdded ?? []) : [];
				if (additions.length && options.supportsAdditionalTools)
					result.push({
						type: "additional_tools",
						role: "developer",
						tools: convertResponsesTools(additions, options.toolOptions),
					});
				else if (additions.length && options.supportsToolSearch) {
					const names = additions.map((tool) => tool.name);
					const call_id = `axi_tool_load_${shortHash(`system:${ordinal}:${names.join(",")}`)}`;
					result.push(
						{
							type: "tool_search_call",
							call_id,
							execution: "client",
							status: "completed",
							arguments: { query: names.join(" "), limit: names.length },
						},
						{
							type: "tool_search_output",
							call_id,
							execution: "client",
							status: "completed",
							tools: convertResponsesTools(additions, { ...options.toolOptions, toolSearchResult: true }),
						},
					);
				}
				if (!leading || options.includeSystemPrompt !== false) {
					const text = leading ? getSystemMessageText(message) : renderSystemMessageUpdate(message);
					if (text.length) result.push({ role, content: sanitizeSurrogates(text) });
				}
				break;
			}
			case "user": {
				const content: ResponseInputContent[] =
					typeof message.content === "string"
						? [{ type: "input_text", text: sanitizeSurrogates(message.content) }]
						: message.content.map((block) =>
								block.type === "image" ? image(block) : { type: "input_text", text: sanitizeSurrogates(block.text) },
							);
				if (!content.length) continue;
				result.push({ role: "user", content });
				break;
			}
			case "assistant": {
				const sameApi = model.provider === message.provider && model.api === message.api;
				const sameModel = sameApi && model.id === message.model;
				const items: ResponseInput = [];
				let texts = 0;
				for (const block of message.content) {
					if (block.type === "thinking") {
						if (block.thinkingSignature) items.push(JSON.parse(block.thinkingSignature));
					} else if (block.type === "text") {
						const signature = textSignature(block.textSignature);
						const fallback = `msg_axi_${ordinal}${texts ? `_${texts}` : ""}`;
						texts++;
						const id = signature?.id
							? signature.id.length > 64
								? `msg_${shortHash(signature.id)}`
								: signature.id
							: fallback;
						items.push({
							type: "message",
							role: "assistant",
							status: "completed",
							id,
							phase: signature?.phase,
							content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
						});
					} else {
						const [call_id = "", rawId] = block.id.split("|");
						const property = options.grammarToolInputProperties?.get(block.name);
						const prefix = property === undefined ? "fc_" : "ctc_";
						const id = (sameApi && !sameModel) || !rawId?.startsWith(prefix) ? undefined : rawId;
						const namespace = sameModel && block.namespace !== undefined ? { namespace: block.namespace } : {};
						items.push(
							property === undefined
								? {
										type: "function_call",
										id,
										call_id,
										name: block.name,
										arguments: JSON.stringify(block.arguments),
										...namespace,
									}
								: {
										type: "custom_tool_call",
										id,
										call_id,
										name: block.name,
										input: sanitizeSurrogates(getGrammarToolInput(block.name, block.arguments, property)),
										...namespace,
									},
						);
					}
				}
				if (!items.length) continue;
				if (options.configurationUpdateEffort !== undefined && sameModel && message.providerThinkingLevel !== undefined)
					configuration(message.providerThinkingLevel);
				result.push(...items);
				break;
			}
			case "toolResult": {
				const type = options.grammarToolInputProperties?.has(message.toolName)
					? "custom_tool_call_output"
					: "function_call_output";
				result.push({
					type,
					call_id: message.toolCallId.split("|")[0] ?? "",
					output: toolOutput(model, message.content),
				});
				break;
			}
		}
		if (!leading) ordinal++;
	}
	if (options.configurationUpdateEffort !== undefined) configuration(options.configurationUpdateEffort);
	return result;
}

type StreamingCall = ToolCall & {
	partialJson?: string;
	customInput?: { property: string; jsonBuffer: GrammarToolInputJsonBuffer };
};
type Slot =
	| { kind: "thinking"; block: ThinkingContent; index: number }
	| { kind: "text"; block: TextContent; index: number }
	| { kind: "toolCall"; block: StreamingCall; index: number };
type Terminal = Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"];
export async function processResponsesStream<A extends Api>(
	events: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<A>,
	options: OpenAIResponsesStreamOptions = {},
): Promise<void> {
	const slots = new Map<number | undefined, Slot>();
	const reasoning = new Map<string, ThinkingContent>();
	let terminal = false;
	const phase = (item: ResponseOutputItem) => {
		if (item.type === "message" && item.phase === "final_answer") output.stopReason = "stop";
	};
	const open = (position: number, item: ResponseOutputItem): Slot | undefined => {
		const index = output.content.length;
		let slot: Slot;
		if (item.type === "reasoning") slot = { kind: "thinking", index, block: { type: "thinking", thinking: "" } };
		else if (item.type === "message") {
			phase(item);
			slot = { kind: "text", index, block: { type: "text", text: "" } };
		} else if (item.type === "function_call" || item.type === "custom_tool_call") {
			const block: StreamingCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
			};
			if (item.type === "function_call") block.partialJson = item.arguments || "";
			else {
				const property = options.grammarToolInputProperties?.get(item.name) ?? "input";
				block.arguments = { [property]: item.input || "" };
				block.customInput = { property, jsonBuffer: { input: "", started: false, closed: false } };
			}
			slot = { kind: "toolCall", index, block };
		} else return undefined;
		output.content.push(slot.block);
		slots.set(position, slot);
		stream.push({
			type: slot.kind === "toolCall" ? "toolcall_start" : slot.kind === "text" ? "text_start" : "thinking_start",
			contentIndex: index,
			partial: output,
		});
		return slot;
	};
	const toolDelta = (slot: Extract<Slot, { kind: "toolCall" }>, delta: string | undefined) => {
		if (delta !== undefined) stream.push({ type: "toolcall_delta", contentIndex: slot.index, delta, partial: output });
	};
	const grammarInput = (block: StreamingCall): string => {
		const value = block.customInput && block.arguments[block.customInput.property];
		return typeof value === "string" ? value : "";
	};
	const grammarDelta = (slot: Extract<Slot, { kind: "toolCall" }>, value: string, close: boolean) => {
		const input = slot.block.customInput;
		if (!input) return;
		const delta = appendGrammarToolInputJsonDelta(input.jsonBuffer, input.property, value, close);
		slot.block.arguments = { [input.property]: value };
		toolDelta(slot, delta);
	};
	const finish = (response: Terminal) => {
		terminal = true;
		for (const item of response.output ?? []) {
			if (item.type !== "reasoning" || !item.encrypted_content) continue;
			const stored = reasoning.get(item.id);
			if (!stored?.thinkingSignature) continue;
			const signature = JSON.parse(stored.thinkingSignature) as ResponseReasoningItem;
			if (!signature.encrypted_content)
				stored.thinkingSignature = JSON.stringify({ ...signature, encrypted_content: item.encrypted_content });
		}
		if (response.id) output.responseId = response.id;
		if (response.usage) {
			const usage = response.usage;
			const read = usage.input_tokens_details?.cached_tokens || 0;
			const details: typeof usage.input_tokens_details & { cache_write_tokens?: number } = usage.input_tokens_details;
			const write = details?.cache_write_tokens || 0;
			output.usage = {
				input: Math.max(0, (usage.input_tokens || 0) - read - write),
				output: usage.output_tokens || 0,
				cacheRead: read,
				cacheWrite: write,
				reasoning: usage.output_tokens_details?.reasoning_tokens || 0,
				totalTokens: usage.total_tokens || 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
		calculateCost(model, output.usage);
		if (options.applyServiceTierPricing) {
			const tier = options.resolveServiceTier
				? options.resolveServiceTier(response.service_tier, options.serviceTier)
				: (response.service_tier ?? options.serviceTier);
			options.applyServiceTierPricing(output.usage, tier);
		}
		const rawReason: unknown = response.incomplete_details?.reason;
		const reason = typeof rawReason === "string" ? rawReason : undefined;
		output.rawStopReason = reason ? `${response.status}.${reason}` : response.status;
		delete output.errorMessage;
		const status: Terminal["status"] | undefined = response.status;
		if (!status) output.stopReason = "stop";
		else
			switch (status) {
				case "completed":
				case "in_progress":
				case "queued":
					output.stopReason = "stop";
					break;
				case "failed":
				case "cancelled":
					output.stopReason = "error";
					break;
				case "incomplete":
					output.stopReason = reason === "max_output_tokens" ? "length" : "error";
					if (output.stopReason === "error")
						output.errorMessage = reason
							? `Response incomplete: ${reason}`
							: "Response incomplete without a provider reason";
					break;
				default: {
					const unhandled: never = status;
					throw new Error(`Unhandled stop reason: ${unhandled}`);
				}
			}
		if (output.stopReason === "stop" && output.content.some((block) => block.type === "toolCall"))
			output.stopReason = "toolUse";
	};
	for await (const event of events) {
		await options.onProviderStreamEvent?.(event, model);
		const slot = slots.get("output_index" in event ? event.output_index : undefined);
		switch (event.type) {
			case "response.created":
				output.responseId = event.response.id;
				break;
			case "response.output_item.added":
				open(event.output_index, event.item);
				break;
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta":
			case "response.reasoning_summary_part.done": {
				if (slot?.kind !== "thinking") break;
				const delta = event.type === "response.reasoning_summary_part.done" ? "\n\n" : event.delta;
				slot.block.thinking += delta;
				stream.push({ type: "thinking_delta", contentIndex: slot.index, delta, partial: output });
				break;
			}
			case "response.output_text.delta":
			case "response.refusal.delta":
				if (slot?.kind === "text") {
					slot.block.text += event.delta;
					stream.push({ type: "text_delta", contentIndex: slot.index, delta: event.delta, partial: output });
				}
				break;
			case "response.function_call_arguments.delta":
				if (slot?.kind === "toolCall" && slot.block.partialJson !== undefined) {
					slot.block.partialJson += event.delta;
					slot.block.arguments = parseStreamingJson(slot.block.partialJson);
					toolDelta(slot, event.delta);
				}
				break;
			case "response.function_call_arguments.done":
				if (slot?.kind === "toolCall" && slot.block.partialJson !== undefined) {
					const before = slot.block.partialJson;
					slot.block.partialJson = event.arguments;
					slot.block.arguments = parseStreamingJson(event.arguments);
					if (event.arguments.startsWith(before) && event.arguments.length > before.length)
						toolDelta(slot, event.arguments.slice(before.length));
				}
				break;
			case "response.custom_tool_call_input.delta":
				if (slot?.kind === "toolCall") grammarDelta(slot, grammarInput(slot.block) + event.delta, false);
				break;
			case "response.custom_tool_call_input.done":
				if (slot?.kind === "toolCall") grammarDelta(slot, event.input, true);
				break;
			case "response.output_item.done": {
				const item = event.item;
				phase(item);
				const current = slots.get(event.output_index) ?? open(event.output_index, item);
				if (current?.kind === "thinking" && item.type === "reasoning") {
					current.block.thinking =
						item.summary?.map((part) => part.text).join("\n\n") ||
						item.content?.map((part) => part.text).join("\n\n") ||
						current.block.thinking;
					current.block.thinkingSignature = JSON.stringify(item);
					reasoning.set(item.id, current.block);
					stream.push({
						type: "thinking_end",
						contentIndex: current.index,
						content: current.block.thinking,
						partial: output,
					});
				} else if (current?.kind === "text" && item.type === "message") {
					current.block.text =
						item.content?.map((part) => (part.type === "output_text" ? part.text : part.refusal)).join("") || "";
					current.block.textSignature = JSON.stringify({
						v: 1,
						id: item.id,
						...(item.phase ? { phase: item.phase } : {}),
					});
					stream.push({ type: "text_end", contentIndex: current.index, content: current.block.text, partial: output });
				} else if (
					current?.kind === "toolCall" &&
					item.type === "function_call" &&
					current.block.partialJson !== undefined
				) {
					Object.assign(current.block, parseToolCallArguments(item.arguments || current.block.partialJson));
					if (item.namespace !== undefined) current.block.namespace = item.namespace;
					delete current.block.partialJson;
					stream.push({ type: "toolcall_end", contentIndex: current.index, toolCall: current.block, partial: output });
				} else if (current?.kind === "toolCall" && item.type === "custom_tool_call" && current.block.customInput) {
					grammarDelta(current, item.input ?? grammarInput(current.block), true);
					if (item.namespace !== undefined) current.block.namespace = item.namespace;
					delete current.block.customInput;
					stream.push({ type: "toolcall_end", contentIndex: current.index, toolCall: current.block, partial: output });
				} else break;
				slots.delete(event.output_index);
				break;
			}
			case "response.completed":
			case "response.incomplete":
				finish(event.response);
				break;
			case "error":
				throw new Error(`Error Code ${event.code}: ${event.message}`);
			case "response.failed":
				terminal = true;
				output.rawStopReason = event.response?.status;
				throw new Error(
					event.response?.error
						? `${event.response.error.code || "unknown"}: ${event.response.error.message || "no message"}`
						: event.response?.incomplete_details?.reason
							? `incomplete: ${event.response.incomplete_details.reason}`
							: "Unknown error (no error details in response)",
				);
		}
	}
	if (!terminal) throw new Error("OpenAI Responses stream ended before a terminal response event");
	if (output.stopReason === "toolUse") {
		for (const block of output.content) {
			if (
				block.type === "toolCall" &&
				(("partialJson" in block && block.partialJson !== undefined) ||
					("customInput" in block && block.customInput !== undefined))
			)
				throw new Error(`OpenAI Responses stream completed with an unfinished tool call: ${block.name} (${block.id})`);
		}
	}
}
