import type {
	ContentBlock,
	ConverseStreamCommandInput,
	ImageBlock,
	Message,
	SystemContentBlock,
	ToolConfiguration,
	ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type {
	CacheRetention,
	ImageContent,
	JsonValue,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	TextContent,
	TranscriptContext,
} from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { getCurrentTools, getInitialSystemMessage, withoutInitialSystemMessage } from "../utils/transcript.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import type { BedrockOptions } from "./options.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	clampReasoning,
	thinkingBudgetForLevel,
} from "./simple-options.ts";
import { splitErrorToolResultImages, transformMessages } from "./transform-messages.ts";
type BedrockModel = Model<"bedrock-converse-stream">;
function names(model: BedrockModel): string[] {
	return [model.id, model.name].flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}
function claude(model: BedrockModel): boolean {
	return [model.id, model.name].some((value) => /anthropic[./]claude/i.test(value)) || /claude/i.test(model.name);
}
const modernClaude = (model: BedrockModel) =>
	names(model).some((value) => /opus-4-[78]|(?:opus|sonnet|haiku|fable)-5/.test(value));
function adaptive(model: BedrockModel): boolean {
	return modernClaude(model) || names(model).some((value) => /(?:opus|sonnet)-4-6/.test(value));
}
function cacheSupported(model: BedrockModel, env?: ProviderEnv): boolean {
	const candidates = names(model);
	return candidates.some((value) => value.includes("claude"))
		? candidates.some((value) => /(?:fable|opus|sonnet|haiku)-5|-4-|claude-3-7-sonnet|claude-3-5-haiku/.test(value))
		: getProviderEnvValue("AWS_BEDROCK_FORCE_CACHE", env) === "1";
}
function cachePoint(retention: CacheRetention): { cachePoint: { type: "default"; ttl?: "1h" } } {
	return { cachePoint: { type: "default", ...(retention === "long" ? { ttl: "1h" } : {}) } };
}
function image(block: ImageContent): ImageBlock {
	const mime = block.mimeType === "image/jpg" ? "image/jpeg" : block.mimeType;
	const format = mime.slice(6);
	if (!mime.startsWith("image/") || (format !== "jpeg" && format !== "png" && format !== "gif" && format !== "webp"))
		throw new Error(`Unknown image type: ${block.mimeType}`);
	return { format, source: { bytes: Uint8Array.from(atob(block.data), (char) => char.charCodeAt(0)) } };
}
function textBlock(text: string): { text: string } | undefined {
	const clean = sanitizeSurrogates(text);
	return clean.trim() ? { text: clean } : undefined;
}
function toolContent(blocks: (ImageContent | TextContent)[]): ToolResultContentBlock[] {
	const result: ToolResultContentBlock[] = [];
	for (const block of blocks) {
		if (block.type === "image") result.push({ image: image(block) });
		else {
			const text = textBlock(block.text);
			if (text) result.push(text);
		}
	}
	return result.length ? result : [{ text: "<empty>" }];
}
function document(value: JsonValue): DocumentType {
	if (Array.isArray(value)) return value.map(document);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key.length)
				.map(([key, value]) => [key, document(value)]),
		);
	return value;
}
function messages(
	model: BedrockModel,
	context: TranscriptContext,
	cached: boolean,
	retention: CacheRetention,
): Message[] {
	const transcript = transformMessages(withoutInitialSystemMessage(context.messages), model, (id) =>
			id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
		),
		result: Message[] = [];
	for (let i = 0; i < transcript.length; i++) {
		const message = transcript[i];
		if (message.role === "user") {
			const content: ContentBlock[] = [];
			if (typeof message.content === "string") content.push(textBlock(message.content) ?? { text: "<empty>" });
			else
				for (const block of message.content) {
					if (block.type === "image") content.push({ image: image(block) });
					else if (block.type === "text") {
						const text = textBlock(block.text);
						if (text) content.push(text);
					}
				}
			result.push({ role: "user", content: content.length ? content : [{ text: "<empty>" }] });
		} else if (message.role === "assistant") {
			const content: ContentBlock[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					const text = textBlock(block.text);
					if (text) content.push(text);
				} else if (block.type === "toolCall")
					content.push({ toolUse: { toolUseId: block.id, name: block.name, input: document(block.arguments) } });
				else if (block.type === "thinking") {
					if (block.redacted) {
						if (block.thinkingSignature)
							try {
								const bytes = Uint8Array.from(atob(block.thinkingSignature), (char) => char.charCodeAt(0));
								if (bytes.length) content.push({ reasoningContent: { redactedContent: bytes } });
							} catch {}
					} else {
						const text = textBlock(block.thinking);
						if (!text) continue;
						if (claude(model) && !block.thinkingSignature?.trim()) content.push(text);
						else
							content.push({
								reasoningContent: {
									reasoningText: { text: text.text, ...(claude(model) ? { signature: block.thinkingSignature } : {}) },
								},
							});
					}
				}
			}
			if (content.length) result.push({ role: "assistant", content });
		} else if (message.role === "toolResult") {
			const content: ContentBlock[] = [],
				trailing: ContentBlock[] = [];
			for (; i < transcript.length; i++) {
				const tool = transcript[i];
				if (tool.role !== "toolResult") break;
				const split = claude(model) ? splitErrorToolResultImages(tool) : undefined;
				content.push({
					toolResult: {
						toolUseId: tool.toolCallId,
						status: tool.isError ? "error" : "success",
						content: toolContent(split?.content ?? tool.content),
					},
				});
				if (split) trailing.push({ text: split.caption }, ...split.images.map((block) => ({ image: image(block) })));
			}
			i--;
			result.push({ role: "user", content: [...content, ...trailing] });
		}
	}
	const last = result.at(-1);
	if (cached && last?.role === "user") last.content?.push(cachePoint(retention));
	return result;
}
function additionalFields(
	model: BedrockModel,
	options: BedrockOptions,
): ConverseStreamCommandInput["additionalModelRequestFields"] {
	const level = options.reasoning;
	if (!level || !model.reasoning) return undefined;
	if (claude(model)) {
		const region =
			options.region ||
			getProviderEnvValue("AWS_REGION", options.env) ||
			getProviderEnvValue("AWS_DEFAULT_REGION", options.env);
		const gov =
			region?.toLowerCase().startsWith("us-gov-") || /^(?:us-gov\.|arn:aws-us-gov:)/.test(model.id.toLowerCase());
		const thinking: Record<string, DocumentType> = {};
		if (!gov) thinking.display = options.thinkingDisplay ?? "summarized";
		if (adaptive(model)) {
			const mapped = model.thinkingLevelMap?.[level];
			const effort =
				level === "xhigh" && modernClaude(model)
					? "xhigh"
					: typeof mapped === "string"
						? mapped
						: level === "minimal"
							? "low"
							: level === "low" || level === "medium"
								? level
								: "high";
			const binding = !gov && modernClaude(model);
			thinking.type = "adaptive";
			const result: Record<string, DocumentType> = { thinking, output_config: { effort } };
			if (binding) {
				thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
				result.anthropic_beta = ["thinking-binding-controls-2026-08-01"];
			}
			return result;
		}
		thinking.type = "enabled";
		thinking.budget_tokens = thinkingBudgetForLevel(level, options.thinkingBudgets);
		const result: Record<string, DocumentType> = { thinking };
		if (options.interleavedThinking ?? true) result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		return result;
	}
	const candidates = names(model),
		effort = level === "minimal" ? "low" : level;
	if (candidates.some((value) => value.includes("gpt-oss")))
		return { reasoning_effort: effort === "xhigh" || effort === "max" ? "high" : effort };
	if (candidates.some((value) => value.includes("gpt-"))) {
		const mapped = model.thinkingLevelMap?.[level];
		return { reasoning: { effort: typeof mapped === "string" ? mapped : effort } };
	}
	return undefined;
}
export function bedrockRequest(
	model: BedrockModel,
	context: TranscriptContext,
	options: BedrockOptions,
): ConverseStreamCommandInput {
	const retention =
		options.cacheRetention || (getProviderEnvValue("AXI_CACHE_RETENTION", options.env) === "long" ? "long" : "short");
	const cached = retention !== "none" && cacheSupported(model, options.env),
		initial = getInitialSystemMessage(context.messages);
	const prompt = initial ? getSystemMessageText(initial) : undefined;
	const system: SystemContentBlock[] | undefined = prompt
		? [{ text: sanitizeSurrogates(prompt) }, ...(cached ? [cachePoint(retention)] : [])]
		: undefined;
	const tools = getCurrentTools(context.messages);
	let toolConfig: ToolConfiguration | undefined;
	if (tools.length && options.toolChoice !== "none") {
		const choice = options.toolChoice;
		toolConfig = {
			tools: tools.map((tool) => {
				const strict = resolveJsonSchemaStrictSampling(tool, model.compat?.supportsStrictMode ?? false);
				return {
					toolSpec: {
						name: tool.name,
						description: tool.description,
						inputSchema: { json: getJsonSchemaToolParameters(tool, strict) as unknown as DocumentType },
						...(strict === true ? { strict: true } : {}),
					},
				};
			}),
			toolChoice:
				choice === "auto"
					? { auto: {} }
					: choice === "any"
						? { any: {} }
						: choice?.type === "tool"
							? { tool: { name: choice.name } }
							: undefined,
		};
	}
	const maxTokens = options.maxTokens ?? (claude(model) ? model.maxTokens : undefined);
	return {
		modelId: model.id,
		messages: messages(model, context, cached, retention),
		system,
		inferenceConfig: {
			...(maxTokens !== undefined ? { maxTokens } : {}),
			...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		},
		toolConfig,
		additionalModelRequestFields: additionalFields(model, options),
		...(options.requestMetadata !== undefined ? { requestMetadata: options.requestMetadata } : {}),
	};
}
export function bedrockSimpleOptions(
	model: BedrockModel,
	context: TranscriptContext,
	options: SimpleStreamOptions,
): BedrockOptions {
	const base = { ...buildBaseOptions(model, context, options), toolChoice: options.toolChoice };
	if (!options.reasoning) return { ...base, reasoning: undefined };
	if (!claude(model) || adaptive(model))
		return { ...base, reasoning: options.reasoning, thinkingBudgets: options.thinkingBudgets };
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
	return {
		...base,
		maxTokens,
		reasoning: options.reasoning,
		thinkingBudgets: {
			...options.thinkingBudgets,
			[clampReasoning(options.reasoning)!]: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
		},
	};
}
