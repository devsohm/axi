import type {
	BetaTool,
	BetaCacheControlEphemeral,
	BetaContentBlockParam,
	BetaMessageParam,
	BetaSystemMessageParam,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { ImageContent, Message, Model, Tool, TranscriptContext } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import { getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import { anthropicCompat, anthropicRetention } from "./anthropic-client.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import type { AnthropicEffort, AnthropicOptions } from "./options.ts";
import { splitErrorToolResultImages, transformMessages } from "./transform-messages.ts";

type Block = BetaContentBlockParam;
type SystemBlock = Exclude<BetaSystemMessageParam["content"], string | undefined>[number];
type RequestBody = MessageCreateParamsStreaming & { temperature?: number };
type Cache = BetaCacheControlEphemeral;
const names = new Map(
	[
		"Read",
		"Write",
		"Edit",
		"Bash",
		"Grep",
		"Glob",
		"AskUserQuestion",
		"EnterPlanMode",
		"ExitPlanMode",
		"KillShell",
		"NotebookEdit",
		"Skill",
		"Task",
		"TaskOutput",
		"TodoWrite",
		"WebFetch",
		"WebSearch",
	].map((name) => [name.toLowerCase(), name]),
);
const deferredToolPlaceholder: BetaTool = {
	name: "__axi_deferred_placeholder__",
	description: "Reserved placeholder. Never available. Never call this.",
	input_schema: { type: "object", properties: {}, required: [] },
	defer_loading: true,
};
export function anthropicToolName(name: string): string {
	return names.get(name.toLowerCase()) ?? name;
}
export function isAnthropicEffort(level: unknown): level is AnthropicEffort {
	return ["low", "medium", "high", "xhigh", "max"].some((value) => value === level);
}
function image(block: ImageContent): Block {
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: block.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
			data: block.data,
		},
	};
}
function resultContent(content: Extract<Message, { role: "toolResult" }>["content"]): string | Block[] {
	if (!content.some((block) => block.type === "image"))
		return sanitizeSurrogates(
			content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		);
	const blocks: Block[] = content.map((block) =>
		block.type === "image" ? image(block) : { type: "text", text: sanitizeSurrogates(block.text) },
	);
	if (!content.some((block) => block.type === "text")) blocks.unshift({ type: "text", text: "(see attached image)" });
	return blocks;
}
const unsupported = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"maxItems",
	"uniqueItems",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
]);
const stringFormats = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);
function rejectsStrict(key: string, value: unknown): boolean {
	return (
		unsupported.has(key) ||
		(key === "minItems" && value !== 0 && value !== 1) ||
		(key === "format" && (typeof value !== "string" || !stringFormats.has(value)))
	);
}
function conversation({
	messages,
	oauth,
	cache,
	emptySignature,
	managedProvider,
	convertTools,
}: {
	messages: Message[];
	oauth: boolean;
	cache?: Cache;
	emptySignature: boolean;
	managedProvider?: string;
	convertTools?: (tools: Tool[]) => BetaTool[];
}): { messages: BetaMessageParam[]; levels: Map<number, AnthropicEffort> } {
	const output: BetaMessageParam[] = [],
		pending: BetaMessageParam[] = [],
		levels = new Map<number, AnthropicEffort>();
	const flush = () => {
		output.push(...pending);
		pending.length = 0;
	};
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		switch (message.role) {
			case "system": {
				const blocks: SystemBlock[] = [],
					text = renderSystemMessageUpdate(message);
				if (text) blocks.push({ type: "text", text: sanitizeSurrogates(text) });
				if (convertTools) {
					const added = message.toolsAdded ?? [],
						redefined = new Set(added.map((tool) => tool.name));
					for (const tool of message.toolsRemoved ?? [])
						if (!redefined.has(tool.name))
							blocks.push({
								type: "tool_removal",
								tool: { type: "tool_reference", name: oauth ? anthropicToolName(tool.name) : tool.name },
							});
					for (const definition of convertTools(added))
						blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
				}
				if (blocks.length) pending.push({ role: "system", content: blocks });
				break;
			}
			case "user": {
				if (typeof message.content === "string") {
					if (message.content.trim()) output.push({ role: "user", content: sanitizeSurrogates(message.content) });
				} else {
					const blocks: Block[] = message.content
						.filter((block) => block.type !== "text" || block.text.trim())
						.map((block) =>
							block.type === "image" ? image(block) : { type: "text", text: sanitizeSurrogates(block.text) },
						);
					if (blocks.length) output.push({ role: "user", content: blocks });
				}
				break;
			}
			case "assistant": {
				const blocks: Block[] = [];
				for (const block of message.content)
					switch (block.type) {
						case "text":
							if (block.text.trim()) blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
							break;
						case "thinking": {
							if (block.redacted) {
								blocks.push({ type: "redacted_thinking", data: block.thinkingSignature! });
								break;
							}
							const signature = block.thinkingSignature?.trim() ? block.thinkingSignature : undefined;
							if (!signature && !block.thinking.trim()) break;
							blocks.push(
								signature || emptySignature
									? { type: "thinking", thinking: sanitizeSurrogates(block.thinking), signature: signature ?? "" }
									: { type: "text", text: sanitizeSurrogates(block.thinking) },
							);
							break;
						}
						case "toolCall":
							blocks.push({
								type: "tool_use",
								id: block.id,
								name: oauth ? anthropicToolName(block.name) : block.name,
								input: block.arguments ?? {},
							});
							break;
					}
				if (!blocks.length) continue;
				flush();
				if (
					managedProvider !== undefined &&
					message.api === "anthropic-messages" &&
					message.provider === managedProvider &&
					isAnthropicEffort(message.providerThinkingLevel)
				)
					levels.set(output.length, message.providerThinkingLevel);
				output.push({ role: "assistant", content: blocks });
				break;
			}
			case "toolResult": {
				const results: Block[] = [],
					images: Block[] = [];
				do {
					const result = messages[index];
					if (result.role !== "toolResult") break;
					const split = splitErrorToolResultImages(result);
					results.push({
						type: "tool_result",
						tool_use_id: result.toolCallId,
						is_error: result.isError,
						content: resultContent(split?.content ?? result.content) as Extract<
							Block,
							{ type: "tool_result" }
						>["content"],
					});
					if (split) images.push({ type: "text", text: split.caption }, ...split.images.map(image));
					index++;
				} while (index < messages.length && messages[index].role === "toolResult");
				index--;
				output.push({ role: "user", content: [...results, ...images] });
				break;
			}
		}
	}
	flush();
	const last = output.at(-1);
	if (cache && last && (last.role === "user" || last.role === "system")) {
		if (typeof last.content === "string") last.content = [{ type: "text", text: last.content, cache_control: cache }];
		else if (Array.isArray(last.content)) {
			const block = last.content.at(-1);
			if (block && ["text", "image", "tool_result", "tool_addition", "tool_removal"].includes(block.type))
				Object.assign(block, { cache_control: cache });
		}
	}
	return { messages: output, levels };
}
function betas(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
	oauth: boolean,
	inline: boolean,
): string[] {
	let override: string | null | undefined;
	for (const headers of [model.headers, options.headers])
		for (const [name, value] of Object.entries(headers ?? {}))
			if (name.toLowerCase() === "anthropic-beta") override = value;
	if (override !== undefined)
		return override === null
			? []
			: [
					...new Set(
						override
							.split(",")
							.map((part) => part.trim())
							.filter(Boolean),
					),
				];
	const output: string[] = [];
	if (oauth) output.push("claude-code-20250219", "oauth-2025-04-20");
	if (getCurrentTools(context.messages).length && !anthropicCompat(model).supportsEagerToolInputStreaming)
		output.push("fine-grained-tool-streaming-2025-05-14");
	if (
		model.reasoning &&
		options.thinkingEnabled === true &&
		(options.interleavedThinking ?? true) &&
		!model.compat?.forceAdaptiveThinking
	)
		output.push("interleaved-thinking-2025-05-14");
	if (model.compat?.allowedFallbackModels?.length) output.push("server-side-fallback-2026-07-01");
	if (model.compat?.supportsMidConvoEffort)
		output.push("mid-conversation-output-config-2026-07-01", "thinking-binding-controls-2026-08-01");
	if (inline) output.push("inline-tools-2026-09-15");
	return [...new Set(output)];
}
export function anthropicRequest(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
	oauth: boolean,
	downgrade: boolean,
): { body: RequestBody; preferred: boolean; level?: AnthropicEffort } {
	const compat = anthropicCompat(model),
		retention = anthropicRetention(options);
	const cache: Cache | undefined =
		retention === "none"
			? undefined
			: { type: "ephemeral", ...(retention === "long" && compat.supportsLongCacheRetention ? { ttl: "1h" } : {}) };
	let preferred = false;
	const definitions = (tools: Tool[], cache?: Cache): BetaTool[] =>
		tools.map((tool, index) => {
			const config = tool.constrainedSampling;
			const strict =
				downgrade && config && config.type === "json_schema" && config.strict === "prefer"
					? undefined
					: resolveJsonSchemaStrictSampling(tool, compat.supportsStrictTools, rejectsStrict);
			if (strict && config && config.type === "json_schema" && config.strict === "prefer") preferred = true;
			const schema = getJsonSchemaToolParameters(tool, strict) as { properties?: unknown; required?: string[] };
			return {
				name: oauth ? anthropicToolName(tool.name) : tool.name,
				description: tool.description,
				input_schema: {
					...(strict ? schema : {}),
					type: "object",
					properties: schema.properties ?? {},
					required: schema.required ?? [],
				} as BetaTool["input_schema"],
				...(compat.supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
				...(strict ? { strict: true } : {}),
				...(cache && index === tools.length - 1 ? { cache_control: cache } : {}),
			};
		});
	const initial = getInitialSystemMessage(context.messages),
		initialTools = initial?.toolsAdded ?? [];
	const transformed = transformMessages(context.messages, model, (id) => id.replace(/[^\w-]/g, "_").slice(0, 64));
	const inline = compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges && initialTools.length > 0;
	const disabled = model.reasoning && options.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
	const managed = model.compat?.supportsMidConvoEffort === true && !disabled;
	const converted = conversation({
		messages: initial ? transformed.slice(1) : transformed,
		oauth,
		cache,
		emptySignature: compat.allowEmptySignature,
		managedProvider: managed ? model.provider : undefined,
		convertTools: inline ? definitions : undefined,
	});
	const level = options.effort ?? "high";
	const messages: BetaMessageParam[] = [];
	for (let index = 0; index < converted.messages.length; index++) {
		const historical = converted.levels.get(index);
		if (managed && historical) messages.push({ role: "system", content: [], output_config: { effort: historical } });
		messages.push(converted.messages[index]);
	}
	if (managed) messages.push({ role: "system", content: [], output_config: { effort: level } });
	const features = betas(model, context, options, oauth, inline);
	const body: RequestBody = {
		model: model.id,
		messages,
		stream: true,
		max_tokens: options.maxTokens ?? model.maxTokens,
		...(features.length ? { betas: features } : {}),
	};
	const system = initial ? getSystemMessageText(initial) : "";
	if (oauth || system) {
		body.system = [];
		if (oauth)
			body.system.push({
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cache ? { cache_control: cache } : {}),
			});
		if (system)
			body.system.push({ type: "text", text: sanitizeSurrogates(system), ...(cache ? { cache_control: cache } : {}) });
	}
	if (
		options.temperature !== undefined &&
		!options.thinkingEnabled &&
		!model.compat?.supportsMidConvoEffort &&
		compat.supportsTemperature
	)
		body.temperature = options.temperature;
	const toolCache = compat.supportsCacheControlOnTools ? cache : undefined;
	if (inline) body.tools = [...definitions(initialTools, toolCache), deferredToolPlaceholder];
	else {
		const tools = getCurrentTools(context.messages);
		if (tools.length) body.tools = definitions(tools, toolCache);
	}
	if (disabled) body.thinking = { type: "disabled" };
	else if (managed) {
		body.thinking = {
			type: "adaptive",
			display: options.thinkingDisplay ?? "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		};
		body.output_config = { effort: "low" };
	} else if (model.reasoning && options.thinkingEnabled) {
		const display = options.thinkingDisplay ?? "summarized";
		if (model.compat?.forceAdaptiveThinking) {
			body.thinking = { type: "adaptive", display };
			if (options.effort) body.output_config = { effort: options.effort };
		} else body.thinking = { type: "enabled", budget_tokens: options.thinkingBudgetTokens || 1024, display };
	}
	if (typeof options.metadata?.user_id === "string") body.metadata = { user_id: options.metadata.user_id };
	if (options.toolChoice)
		body.tool_choice = typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
	if (model.compat?.allowedFallbackModels?.length)
		body.fallbacks = model.compat.allowedFallbackModels.map((fallback) => ({ model: fallback.model }));
	return { body, preferred, level: managed ? level : undefined };
}
