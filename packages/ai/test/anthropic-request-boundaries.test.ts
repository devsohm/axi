import { expect, test } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { anthropicReply, anthropicRequest } from "../src/api/anthropic-request.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
	id: "wire-fixture",
	name: "Wire fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://provider.invalid",
	reasoning: true,
	input: ["text", "image"],
	maxTokens: 1000,
	contextWindow: 10000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const tool: Tool = { name: "read", description: "Read a value", parameters: Type.Object({}) };
function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { ...fauxAssistantMessage(content), api: model.api, provider: model.provider, model: model.id };
}

test.each([false, true])(
	"successful image tool results preserve images and add a caption only when needed, text=%s",
	(withText) => {
		const context = normalizeContext({
			tools: [tool],
			messages: [
				{ role: "user", content: "Run", timestamp: 0 },
				assistant([{ type: "toolCall", id: "picture", name: "read", arguments: {} }]),
				{
					role: "toolResult",
					toolCallId: "picture",
					toolName: "read",
					isError: false,
					timestamp: 1,
					content: [
						...(withText ? [{ type: "text" as const, text: "image result" }] : []),
						{ type: "image", data: "AA==", mimeType: "image/png" },
					],
				},
			],
		});
		const before = structuredClone(context);
		const body = anthropicRequest(model, context, { cacheRetention: "none" }, false, false).body;
		expect(body.messages.at(-1)).toMatchObject({
			role: "user",
			content: [
				{
					type: "tool_result",
					content: [
						{ type: "text", text: withText ? "image result" : "(see attached image)" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
					],
				},
			],
		});
		expect(context).toEqual(before);
	},
);

test.each([false, true])(
	"unsigned reasoning follows allowEmptySignature=%s without retaining empty blocks",
	(allowEmptySignature) => {
		const reply = assistant([
			{ type: "thinking", thinking: "", thinkingSignature: " " },
			{ type: "thinking", thinking: "Reason\ud800", thinkingSignature: "" },
			{ type: "text", text: "answer" },
		]);
		const before = structuredClone(reply);
		expect(anthropicReply({ ...model, compat: { allowEmptySignature } }, reply, false)).toEqual([
			{
				role: "assistant",
				content: [
					allowEmptySignature
						? { type: "thinking", thinking: "Reason", signature: "" }
						: { type: "text", text: "Reason" },
					{ type: "text", text: "answer" },
				],
			},
		]);
		expect(reply).toEqual(before);
	},
);

test("signed and redacted reasoning survives replay without changing its signature", () => {
	const reply = assistant([
		{ type: "thinking", thinking: "signed", thinkingSignature: "signed-proof" },
		{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque-data" },
		{ type: "text", text: "answer" },
	]);
	expect(anthropicReply(model, reply, false)).toEqual([
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "signed", signature: "signed-proof" },
				{ type: "redacted_thinking", data: "opaque-data" },
				{ type: "text", text: "answer" },
			],
		},
	]);
});

test("OAuth tool names are canonicalized in definitions, calls and inline tool changes", () => {
	const lookup: Tool = { ...tool, name: "lookup" };
	const context = normalizeContext({
		tools: [tool, lookup],
		messages: [
			{ role: "user", content: "Run", timestamp: 0 },
			assistant([{ type: "toolCall", id: "call", name: "rEaD", arguments: {} }]),
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "rEaD",
				isError: false,
				content: [{ type: "text", text: "done" }],
				timestamp: 1,
			},
			{
				role: "system",
				content: "Updated tools",
				timestamp: 2,
				toolsRemoved: [tool, lookup],
				toolsAdded: [{ ...tool, description: "Updated read" }],
			},
		],
	});
	const body = anthropicRequest(
		{ ...model, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } },
		context,
		{ cacheRetention: "none" },
		true,
		false,
	).body;
	expect(body.tools).toMatchObject([{ name: "Read" }, { name: "lookup" }, { name: "__axi_deferred_placeholder__" }]);
	expect(body.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "tool_use", name: "Read" }] });
	expect(body.messages.at(-1)).toMatchObject({
		role: "system",
		content: [
			{ type: "text" },
			{ type: "tool_removal", tool: { type: "tool_reference", name: "lookup" } },
			{
				type: "tool_addition",
				tool: { type: "tool_definition", definition: { name: "Read", description: "Updated read" } },
			},
		],
	});
});

test.each([
	{ keyword: "minimum", value: Type.Number({ minimum: 1 }) },
	{ keyword: "maximum", value: Type.Number({ maximum: 9 }) },
	{ keyword: "exclusiveMinimum", value: Type.Number({ exclusiveMinimum: 1 }) },
	{ keyword: "exclusiveMaximum", value: Type.Number({ exclusiveMaximum: 9 }) },
	{ keyword: "multipleOf", value: Type.Number({ multipleOf: 2 }) },
	{ keyword: "maxItems", value: Type.Array(Type.Number(), { maxItems: 3 }) },
	{ keyword: "minItems", value: Type.Array(Type.Number(), { minItems: 2 }) },
	{ keyword: "uniqueItems", value: Type.Array(Type.Number(), { uniqueItems: true }) },
	{ keyword: "minProperties", value: Type.Object({ key: Type.String() }, { minProperties: 1 }) },
	{ keyword: "maxProperties", value: Type.Object({ key: Type.String() }, { maxProperties: 1 }) },
	{ keyword: "format", value: Type.String({ format: "uri-reference" }) },
])("unsupported strict $keyword falls back only when strict sampling is preferred", ({ keyword, value }) => {
	const constrained: Tool = {
		...tool,
		parameters: Type.Object({ value }),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
	};
	const context = normalizeContext({
		tools: [constrained],
		messages: [{ role: "user", content: "Run", timestamp: 0 }],
	});
	const before = structuredClone(context);
	const compatible = { ...model, compat: { supportsStrictTools: true } };
	const result = anthropicRequest(compatible, context, { cacheRetention: "none" }, false, false);
	expect(result.preferred).toBe(false);
	expect(result.body.tools?.[0]).not.toHaveProperty("strict");
	const required = normalizeContext({
		tools: [{ ...constrained, constrainedSampling: { type: "json_schema", strict: "require" } }],
		messages: [{ role: "user", content: "Run", timestamp: 0 }],
	});
	expect(() => anthropicRequest(compatible, required, { cacheRetention: "none" }, false, false)).toThrow(keyword);
	expect(context).toEqual(before);
});

test("supported string formats and zero-or-one minimum arrays retain strict sampling", () => {
	for (const value of [
		Type.String({ format: "email" }),
		Type.String({ format: "uuid" }),
		Type.Array(Type.String(), { minItems: 0 }),
		Type.Array(Type.String(), { minItems: 1 }),
	]) {
		const context = normalizeContext({
			tools: [
				{
					...tool,
					parameters: Type.Object({ value }),
					constrainedSampling: { type: "json_schema", strict: "require" },
				},
			],
			messages: [{ role: "user", content: "Run", timestamp: 0 }],
		});
		expect(
			anthropicRequest(
				{ ...model, compat: { supportsStrictTools: true } },
				context,
				{ cacheRetention: "none" },
				false,
				false,
			).body.tools?.[0],
		).toMatchObject({ strict: true });
	}
});

test.each([null, " custom-one, custom-two,custom-one , "])(
	"beta headers explicitly replace automatic features: %j",
	(header) => {
		const context = normalizeContext({ tools: [tool], messages: [{ role: "user", content: "Run", timestamp: 0 }] });
		const body = anthropicRequest(
			{ ...model, headers: { "anthropic-beta": "model-default" } },
			context,
			{ headers: { "Anthropic-Beta": header }, cacheRetention: "none" },
			true,
			false,
		).body;
		expect(body.betas).toEqual(header === null ? undefined : ["custom-one", "custom-two"]);
	},
);
