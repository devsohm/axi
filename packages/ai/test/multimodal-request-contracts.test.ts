import { expect, test } from "vitest";
import { Type } from "typebox";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { bedrockRequest } from "../src/api/bedrock-request.ts";
import { convertMessages } from "../src/api/google-shared.ts";
import { mistralRequest } from "../src/api/mistral-request.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = {
	api: "anthropic-messages",
	id: "test",
	provider: "selected",
	name: "Selected",
	baseUrl: "https://offline.invalid",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 10000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<"anthropic-messages">;

test.each(["bedrock", "google"] as const)(
	"%s translates foreign tool IDs and retains successful image results",
	(provider) => {
		const context = normalizeContext({
			messages: [
				fauxAssistantMessage([{ type: "toolCall", id: "a.b c/d", name: "inspect", arguments: {} }], {
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "a.b c/d",
					toolName: "inspect",
					isError: false,
					content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
					timestamp: 1,
				},
			],
		});
		if (provider === "bedrock") {
			const result = bedrockRequest({ ...model, api: "bedrock-converse-stream" }, context, {});
			expect(result.messages).toMatchObject([
				{ role: "assistant", content: [{ toolUse: { toolUseId: "a_b_c_d", name: "inspect", input: {} } }] },
				{
					role: "user",
					content: [
						{
							toolResult: {
								toolUseId: "a_b_c_d",
								status: "success",
								content: [{ image: { format: "png", source: { bytes: Uint8Array.of(1, 2, 3) } } }],
							},
						},
					],
				},
			]);
		} else {
			expect(convertMessages({ ...model, api: "google-generative-ai", id: "gemini-3-pro" }, context)).toEqual([
				{ role: "model", parts: [{ functionCall: { id: "a_b_c_d", name: "inspect", args: {} } }] },
				{
					role: "user",
					parts: [
						{
							functionResponse: {
								id: "a_b_c_d",
								name: "inspect",
								response: { output: "(see attached image)" },
								parts: [{ inlineData: { data: "AQID", mimeType: "image/png" } }],
							},
						},
					],
				},
			]);
		}
	},
);

test.each([false, true])("Mistral image-only user messages honor image support %s", (images) => {
	const result = mistralRequest(
		{ ...model, api: "mistral-conversations", input: images ? ["text", "image"] : ["text"] },
		normalizeContext({
			messages: [{ role: "user", content: [{ type: "image", data: "AQID", mimeType: "image/png" }], timestamp: 1 }],
		}),
		{},
	);
	expect(result.messages).toEqual([
		{
			role: "user",
			content: images
				? [{ type: "image_url", imageUrl: "data:image/png;base64,AQID" }]
				: [{ type: "text", text: "(image omitted: model does not support images)" }],
		},
	]);
});

test.each([
	{ key: "sk-ant-oat01-fixture", incoming: "INSPECT", expected: "inspect" },
	{ key: "sk-ant-oat01-fixture", incoming: "unknown", expected: "unknown" },
	{ key: "offline-key", incoming: "INSPECT", expected: "INSPECT" },
])("Anthropic preserves declared casing for OAuth calls named $incoming", async ({ key, incoming, expected }) => {
	const events = [
		{ type: "message_start", message: { id: "answer", model: "test", usage: { input_tokens: 1, output_tokens: 0 } } },
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "call", name: incoming, input: {} },
		},
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"file.txt"}' } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const result = await anthropic(
		{ ...model, api: "anthropic-messages" },
		normalizeContext({
			tools: [{ name: "inspect", description: "Inspect a file", parameters: Type.Object({ path: Type.String() }) }],
			messages: [{ role: "user", content: "Inspect file.txt", timestamp: 0 }],
		}),
		{
			apiKey: key,
			fetch: async () =>
				new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				}),
		},
	).result();
	expect(result).toMatchObject({
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "call", name: expected, arguments: { path: "file.txt" } }],
	});
});
