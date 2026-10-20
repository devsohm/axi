import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { CacheRetention, ChatTemplateKwargValue, Model, TranscriptContext } from "../types.ts";
import { resolveTranscriptTools } from "../utils/transcript.ts";
import type { CompletionsCompat } from "./openai-completions-compat.ts";
import { completionsTools, convertMessages } from "./openai-completions-messages.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import type { OpenAICompletionsOptions } from "./options.ts";
import { clampThinkingBudgetToAnswerRoom, resolveSamplingParams, thinkingBudgetForLevel } from "./simple-options.ts";

type CacheControl = { type: "ephemeral"; ttl?: string };
type Primitive = string | number | boolean | null;
function templateValues(
	values: Record<string, ChatTemplateKwargValue>,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions,
	budget: number | undefined,
): Record<string, Primitive> | undefined {
	const output: Record<string, Primitive> = {};
	const requested = options.reasoningEffort;
	for (const [key, value] of Object.entries(values)) {
		if (typeof value !== "object" || value === null) {
			output[key] = value;
			continue;
		}
		if (!requested && value.omitWhenOff) continue;
		let resolved: Primitive | undefined;
		switch (value.$var) {
			case "thinking.enabled":
				resolved = !!requested;
				break;
			case "thinking.budget":
				resolved = budget;
				break;
			case "thinking.effort": {
				const mapped = model.thinkingLevelMap?.[requested ?? "off"];
				resolved = mapped === undefined ? requested : typeof mapped === "string" ? mapped : undefined;
				break;
			}
		}
		if (resolved !== undefined) output[key] = resolved;
	}
	return Object.keys(output).length ? output : undefined;
}
function markCache(message: ChatCompletionMessageParam, control: CacheControl): boolean {
	if (typeof message.content === "string") {
		if (!message.content) return false;
		Object.assign(message, { content: [{ type: "text", text: message.content, cache_control: control }] });
		return true;
	}
	if (Array.isArray(message.content)) {
		for (let index = message.content.length - 1; index >= 0; index--) {
			const part = message.content[index];
			if (part.type === "text") {
				Object.assign(part, { cache_control: control });
				return true;
			}
		}
	}
	return false;
}
export function completionsRequest({
	model,
	context,
	options,
	compat,
	retention,
	grammar,
}: {
	model: Model<"openai-completions">;
	context: TranscriptContext;
	options: OpenAICompletionsOptions;
	compat: CompletionsCompat;
	retention: CacheRetention;
	grammar: ReadonlyMap<string, string>;
}): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
	const messages = convertMessages(model, context, compat, { grammarToolInputProperties: grammar });
	const declared = resolveTranscriptTools(
		context.messages,
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true
			? "additions"
			: "none",
	).requestTools;
	const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key:
			(retention !== "none" && model.baseUrl.includes("api.openai.com")) ||
			(retention === "long" && compat.supportsLongCacheRetention)
				? clampOpenAIPromptCacheKey(options.sessionId)
				: undefined,
		prompt_cache_retention: retention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
	};
	if (compat.supportsUsageInStreaming) body.stream_options = { include_usage: true };
	if (compat.supportsStore) body.store = false;
	if (options.maxTokens) body[compat.maxTokensField] = options.maxTokens;
	if (options.temperature !== undefined) body.temperature = options.temperature;
	if (declared.length) {
		body.tools = completionsTools(declared, compat);
		if (compat.zaiToolStream) Object.assign(body, { tool_stream: true });
	} else if (
		context.messages.some(
			(message) =>
				message.role === "toolResult" ||
				(message.role === "assistant" && message.content.some((block) => block.type === "toolCall")),
		)
	)
		body.tools = [];
	if (compat.cacheControlFormat === "anthropic" && retention !== "none") {
		const control: CacheControl = {
			type: "ephemeral",
			...(retention === "long" && compat.supportsLongCacheRetention ? { ttl: "1h" } : {}),
		};
		const instruction = messages.find((message) => message.role === "system" || message.role === "developer");
		if (instruction) markCache(instruction, control);
		const lastTool = body.tools?.at(-1);
		if (lastTool) Object.assign(lastTool, { cache_control: control });
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (
				(message.role === "user" || message.role === "assistant" || message.role === "tool") &&
				markCache(message, control)
			)
				break;
		}
	}
	if (options.toolChoice) body.tool_choice = options.toolChoice;
	if (compat.vllmPriority !== undefined) Object.assign(body, { priority: compat.vllmPriority });
	const requested = options.reasoningEffort;
	const budget =
		requested && model.reasoning
			? clampThinkingBudgetToAnswerRoom(
					thinkingBudgetForLevel(requested, options.thinkingBudgets),
					body.max_tokens ?? body.max_completion_tokens ?? model.maxTokens,
				)
			: undefined;
	const positiveBudget = budget !== undefined && budget > 0 ? budget : undefined;
	const mapped = model.thinkingLevelMap?.[requested ?? "off"];
	const effort = mapped === undefined ? requested : mapped;
	const setEffort = () => {
		if (typeof effort === "string") Object.assign(body, { reasoning_effort: effort });
	};
	if (model.reasoning) {
		switch (compat.thinkingFormat) {
			case "zai":
				Object.assign(body, {
					thinking: requested ? { type: "enabled", clear_thinking: false } : { type: "disabled" },
				});
				if (requested && compat.supportsReasoningEffort) setEffort();
				break;
			case "qwen":
				Object.assign(body, { enable_thinking: !!requested });
				if (requested && compat.supportsReasoningEffort && typeof (mapped ?? requested) === "string")
					Object.assign(body, { reasoning_effort: mapped ?? requested });
				break;
			case "qwen-chat-template":
				Object.assign(body, { chat_template_kwargs: { enable_thinking: !!requested, preserve_thinking: true } });
				break;
			case "chat-template": {
				const values = templateValues(compat.chatTemplateKwargs, model, options, positiveBudget);
				if (values) Object.assign(body, { chat_template_kwargs: values });
				break;
			}
			case "baseten": {
				const values = templateValues(compat.chatTemplateArgs, model, options, positiveBudget);
				if (values) Object.assign(body, { chat_template_args: values });
				if (compat.supportsReasoningEffort) setEffort();
				break;
			}
			case "deepseek":
				if (requested || mapped !== null)
					Object.assign(body, { thinking: { type: requested ? "enabled" : "disabled" } });
				if (requested && compat.supportsReasoningEffort) Object.assign(body, { reasoning_effort: mapped ?? requested });
				break;
			case "openrouter":
				if (requested || mapped !== null) Object.assign(body, { reasoning: { effort: mapped ?? requested ?? "none" } });
				break;
			case "ant-ling":
				if (requested && typeof mapped === "string") Object.assign(body, { reasoning: { effort: mapped } });
				else if (!requested && compat.supportsReasoningEffort) setEffort();
				break;
			case "together":
				Object.assign(body, { reasoning: { enabled: !!requested } });
				if (requested && compat.supportsReasoningEffort) Object.assign(body, { reasoning_effort: mapped ?? requested });
				break;
			case "string-thinking":
				if (requested || mapped !== null) Object.assign(body, { thinking: mapped ?? requested ?? "none" });
				break;
			case "openai":
				if (compat.supportsReasoningEffort) {
					if (requested) Object.assign(body, { reasoning_effort: mapped ?? requested });
					else setEffort();
				}
				break;
		}
	}
	const budgetField =
		compat.thinkingTokenBudgetField ?? (compat.supportsThinkingTokenBudget ? "thinking_token_budget" : undefined);
	if (budgetField && positiveBudget !== undefined) Object.assign(body, { [budgetField]: positiveBudget });
	if (model.compat?.openRouterRouting) Object.assign(body, { provider: model.compat.openRouterRouting });
	const routing = model.compat?.vercelGatewayRouting;
	if (routing?.only || routing?.order)
		Object.assign(body, {
			providerOptions: {
				gateway: {
					...(routing.only ? { only: routing.only } : {}),
					...(routing.order ? { order: routing.order } : {}),
				},
			},
		});
	Object.assign(body, resolveSamplingParams(model, requested ?? "off", options.samplingParams));
	return body;
}
