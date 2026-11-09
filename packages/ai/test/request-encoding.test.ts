import { expect, test } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "../src/providers/faux.ts";
import { bedrockRequest } from "../src/api/bedrock-request.ts";
import { completionsCompat, type CompletionsCompat } from "../src/api/openai-completions-compat.ts";
import { completionsRequest } from "../src/api/openai-completions-request.ts";
import type { Model, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "fixture",
	id: "reasoning",
	name: "Reasoning",
	baseUrl: "https://api.example/v1",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 20000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	thinkingLevelMap: { high: "custom", off: null },
};
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
const templates = {
	literal: "value",
	enabled: { $var: "thinking.enabled" },
	effort: { $var: "thinking.effort" },
	budget: { $var: "thinking.budget" },
	optional: { $var: "thinking.enabled", omitWhenOff: true },
} satisfies CompletionsCompat["chatTemplateKwargs"];

test("completion encodings enable and disable each supported thinking format without leaking unset fields", () => {
	for (const [format, enabled, disabled] of [
		[
			"zai",
			{ thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "custom" },
			{ thinking: { type: "disabled" } },
		],
		["qwen", { enable_thinking: true, reasoning_effort: "custom" }, { enable_thinking: false }],
		[
			"qwen-chat-template",
			{ chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } },
			{ chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } },
		],
		[
			"chat-template",
			{ chat_template_kwargs: { literal: "value", enabled: true, effort: "custom", budget: 2048, optional: true } },
			{ chat_template_kwargs: { literal: "value", enabled: false } },
		],
		[
			"baseten",
			{
				chat_template_args: { literal: "value", enabled: true, effort: "custom", budget: 2048, optional: true },
				reasoning_effort: "custom",
			},
			{ chat_template_args: { literal: "value", enabled: false } },
		],
		["deepseek", { thinking: { type: "enabled" }, reasoning_effort: "custom" }, {}],
		["openrouter", { reasoning: { effort: "custom" } }, {}],
		["ant-ling", { reasoning: { effort: "custom" } }, {}],
		["together", { reasoning: { enabled: true }, reasoning_effort: "custom" }, { reasoning: { enabled: false } }],
		["string-thinking", { thinking: "custom" }, {}],
		["openai", { reasoning_effort: "custom" }, {}],
	] satisfies [CompletionsCompat["thinkingFormat"], object, object][]) {
		const compat = {
			...completionsCompat(model),
			thinkingFormat: format,
			supportsReasoningEffort: true,
			chatTemplateKwargs: templates,
			chatTemplateArgs: templates,
		};
		const request = (on: boolean) =>
			completionsRequest({
				model,
				context,
				compat,
				options: on ? { reasoningEffort: "high", thinkingBudgets: { high: 2048 } } : {},
				retention: "none",
				grammar: new Map(),
			});
		expect(request(true)).toMatchObject(enabled);
		const off = request(false);
		expect(off).toMatchObject(disabled);
		for (const key of [
			"thinking",
			"reasoning",
			"reasoning_effort",
			"enable_thinking",
			"chat_template_kwargs",
			"chat_template_args",
		])
			if (!Object.hasOwn(disabled, key)) expect(off).not.toHaveProperty(key);
	}
});

test("cache markers attach to the instruction, last tool and last text block without mutating the transcript", () => {
	const transcript = normalizeContext({
		systemPrompt: "Instructions",
		tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Read this" },
					{ type: "image", data: "AQID", mimeType: "image/png" },
				],
				timestamp: 1,
			},
		],
	});
	const before = structuredClone(transcript.messages);
	const compat = {
		...completionsCompat(model),
		cacheControlFormat: "anthropic",
		supportsLongCacheRetention: true,
		promptCacheKeyMode: "enabled",
		vllmPriority: 2,
		zaiToolStream: true,
	} satisfies CompletionsCompat;
	const request = completionsRequest({
		model,
		context: transcript,
		options: { sessionId: "session", maxTokens: 512, temperature: 0, toolChoice: "auto" },
		compat,
		retention: "long",
		grammar: new Map(),
	});
	const cache = { type: "ephemeral", ttl: "1h" };
	expect(request).toMatchObject({
		prompt_cache_key: "session",
		prompt_cache_retention: "24h",
		max_completion_tokens: 512,
		temperature: 0,
		tool_choice: "auto",
		priority: 2,
		tool_stream: true,
	});
	expect(request.messages[0]).toMatchObject({
		content: [{ type: "text", text: "Instructions", cache_control: cache }],
	});
	expect(request.messages.at(-1)).toMatchObject({
		content: [{ type: "text", text: "Read this", cache_control: cache }, { type: "image_url" }],
	});
	expect(request.tools?.at(-1)).toMatchObject({ cache_control: cache });
	expect(transcript.messages).toEqual(before);
});

const bedrock: Model<"bedrock-converse-stream"> = {
	...model,
	api: "bedrock-converse-stream",
	provider: "bedrock",
	id: "anthropic.claude-sonnet-4-6",
	name: "Claude",
	thinkingLevelMap: undefined,
	compat: {},
};
test("Bedrock converts images, tool arguments and signed reasoning while preserving the input transcript", () => {
	const assistant = {
		...fauxAssistantMessage(
			[
				fauxThinking("unsigned"),
				{ type: "thinking", thinking: "signed", thinkingSignature: "signature" },
				{ type: "thinking", thinking: "hidden", redacted: true, thinkingSignature: "AQID" },
				fauxToolCall("inspect", { "": "discard", nested: [{ count: 1 }, true, null] }, { id: "call:id" }),
			],
			{ stopReason: "toolUse" },
		),
		api: bedrock.api,
		provider: bedrock.provider,
		model: bedrock.id,
	};
	const tool: ToolResultMessage = {
		role: "toolResult",
		toolName: "inspect",
		toolCallId: "call:id",
		content: [{ type: "image", data: "AQID", mimeType: "image/jpg" }],
		isError: false,
		timestamp: 3,
	};
	const transcript = normalizeContext({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: " \n " },
					{ type: "image", data: "AQID", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			assistant,
			tool,
		],
	});
	const request = bedrockRequest(bedrock, transcript, { cacheRetention: "none" });
	expect(request.messages?.[0]?.content).toEqual([
		{ image: { format: "png", source: { bytes: new Uint8Array([1, 2, 3]) } } },
	]);
	expect(request.messages?.[1]?.content).toEqual([
		{ text: "unsigned" },
		{ reasoningContent: { reasoningText: { text: "signed", signature: "signature" } } },
		{ reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
		{ toolUse: { toolUseId: "call:id", name: "inspect", input: { nested: [{ count: 1 }, true, null] } } },
	]);
	expect(request.messages?.[2]?.content).toEqual([
		{
			toolResult: {
				toolUseId: "call:id",
				status: "success",
				content: [{ image: { format: "jpeg", source: { bytes: new Uint8Array([1, 2, 3]) } } }],
			},
		},
	]);
	expect(assistant.content.at(-1)).toMatchObject({ arguments: { "": "discard" } });
	for (const mimeType of ["image/svg+xml", "text/plain"])
		expect(() =>
			bedrockRequest(
				bedrock,
				normalizeContext({
					messages: [{ role: "user", content: [{ type: "image", data: "AQID", mimeType }], timestamp: 0 }],
				}),
				{},
			),
		).toThrow(/Unknown image type/);
});

test("Bedrock keeps empty text placeholders, native tool choices and model-specific reasoning controls", () => {
	const empty = normalizeContext({
		tools: [{ name: "read", description: "Read", parameters: Type.Object({}) }],
		messages: [{ role: "user", content: "\n ", timestamp: 0 }],
	});
	for (const [choice, expected] of [
		["auto", { auto: {} }],
		["any", { any: {} }],
		[{ type: "tool", name: "read" }, { tool: { name: "read" } }],
	] satisfies ["auto" | "any" | { type: "tool"; name: string }, object][])
		expect(bedrockRequest(bedrock, empty, { toolChoice: choice }).toolConfig?.toolChoice).toEqual(expected);
	expect(bedrockRequest(bedrock, empty, { toolChoice: "none" }).toolConfig).toBeUndefined();
	expect(bedrockRequest(bedrock, empty, {}).messages?.[0]?.content?.[0]).toEqual({ text: "<empty>" });
	const ordinary = { ...bedrock, id: "openai.gpt-oss-120b", name: "GPT OSS" };
	expect(bedrockRequest(ordinary, context, { reasoning: "max" }).additionalModelRequestFields).toEqual({
		reasoning_effort: "high",
	});
	expect(
		bedrockRequest({ ...ordinary, id: "openai.gpt-5", name: "GPT 5", thinkingLevelMap: { minimal: "low" } }, context, {
			reasoning: "minimal",
		}).additionalModelRequestFields,
	).toEqual({ reasoning: { effort: "low" } });
	expect(
		bedrockRequest({ ...ordinary, id: "other", name: "Other" }, context, { reasoning: "high" })
			.additionalModelRequestFields,
	).toBeUndefined();
});
