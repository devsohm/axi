import { expect, test } from "vitest";
import { Type } from "typebox";
import type { ImageContent, Model } from "../src/types.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { mistralRequest, mistralToolId, mistralWirePayload, type MistralPayload } from "../src/api/mistral-request.ts";

const model: Model<"mistral-conversations"> = {
	id: "fixture",
	name: "Fixture",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "https://fixture.invalid",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 10000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };

test.each([true, false])("Mistral history preserves text and uses image capability %s", (images) => {
	const selected: Model<"mistral-conversations"> = { ...model, input: images ? ["text", "image"] : ["text"] };
	const prior = {
		...fauxAssistantMessage([
			{ type: "text", text: " " },
			{ type: "thinking", thinking: "reason" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "abc123456", name: "inspect", arguments: { path: "a" } },
		]),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	const input = normalizeContext({
		messages: [
			{ role: "system", content: "First instruction", timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "inspect" }, image], timestamp: 1 },
			prior,
			{
				role: "toolResult",
				toolCallId: "abc123456",
				toolName: "inspect",
				isError: false,
				content: [{ type: "text", text: "result" }, image],
				timestamp: 2,
			},
			{ role: "system", content: "Updated instruction", timestamp: 3 },
		],
	});
	const output = mistralWirePayload(mistralRequest(selected, input, {}));
	expect(output.messages).toMatchObject([
		{ role: "system", content: "First instruction" },
		{
			role: "user",
			content: [
				{ type: "text", text: "inspect" },
				images
					? { type: "image_url", image_url: "data:image/png;base64,AA==" }
					: { type: "text", text: "(image omitted: model does not support images)" },
			],
		},
		{
			role: "assistant",
			prefix: false,
			content: [
				{ type: "thinking", thinking: [{ type: "text", text: "reason" }] },
				{ type: "text", text: "answer" },
			],
			tool_calls: [{ id: "abc123456", function: { name: "inspect", arguments: '{"path":"a"}' } }],
		},
		{
			role: "tool",
			name: "inspect",
			tool_call_id: "abc123456",
			content: [
				{ type: "text", text: images ? "result" : "result\n(tool image omitted: model does not support images)" },
				...(images ? [{ type: "image_url", image_url: "data:image/png;base64,AA==" }] : []),
			],
		},
		{ role: "system", content: expect.stringContaining("Updated instruction") },
	]);
	if (!Array.isArray(output.messages)) throw new Error("Missing message history");
	const serialized = JSON.stringify(output.messages);
	expect(serialized.includes("data:image/png;base64,AA==")).toBe(images);
	expect(input.messages[1]?.content).toEqual([{ type: "text", text: "inspect" }, image]);
});

test.each([false, true])("image-only tool output and error decoration remain useful: %s", (isError) => {
	const prior = {
		...fauxAssistantMessage([{ type: "toolCall", id: "abc123456", name: "read", arguments: {} }]),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	const payload = mistralRequest(
		model,
		normalizeContext({
			messages: [
				prior,
				{ role: "toolResult", toolCallId: "abc123456", toolName: "read", content: [image], isError, timestamp: 1 },
			],
		}),
		{},
	);
	const content = JSON.stringify(payload.messages);
	expect(content).toContain(isError ? "[tool error]" : "(see attached image)");
	expect(content).toContain("data:image/png;base64,AA==");
});

test("empty tool results get a readable placeholder and empty assistant turns are omitted", () => {
	const empty = {
		...fauxAssistantMessage([
			{ type: "text", text: " " },
			{ type: "thinking", thinking: " " },
		]),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	const prior = { ...empty, content: [{ type: "toolCall" as const, id: "abc123456", name: "read", arguments: {} }] };
	const payload = mistralRequest(
		model,
		normalizeContext({
			messages: [
				empty,
				prior,
				{ role: "toolResult", toolCallId: "abc123456", toolName: "read", content: [], isError: false, timestamp: 1 },
			],
		}),
		{},
	);
	expect(payload.messages).toHaveLength(2);
	expect(payload.messages[1]).toMatchObject({ role: "tool", content: [{ type: "text", text: "(no tool output)" }] });
});

test("foreign tool IDs are normalized without collisions and results follow the same mapping", () => {
	const ids = ["a-bc123456", "abc123456", "!!!"];
	const prior = fauxAssistantMessage(ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })));
	const payload = mistralRequest(
		model,
		normalizeContext({
			messages: [
				prior,
				...ids.map((id) => ({
					role: "toolResult" as const,
					toolCallId: id,
					toolName: "read",
					isError: false,
					content: [{ type: "text" as const, text: id }],
					timestamp: 1,
				})),
			],
		}),
		{},
	);
	const calls = payload.messages[0]?.toolCalls?.map((call) => call.id);
	if (!calls) throw new Error("Missing tool calls");
	expect(new Set(calls).size).toBe(3);
	for (const id of calls) expect(id).toMatch(/^[A-Za-z0-9]{9}$/);
	expect(payload.messages.slice(1).map((message) => message.toolCallId)).toEqual(calls);
	expect(mistralToolId("abc123456")).toBe("abc123456");
	expect(mistralToolId("!!!")).toMatch(/^[A-Za-z0-9]{9}$/);
});

test.each(["none", "short", "long"] as const)(
	"request controls preserve zero values and apply %s cache retention",
	(cacheRetention) => {
		const context = normalizeContext({
			messages: [],
			tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
		});
		const payload = mistralWirePayload(
			mistralRequest(model, context, {
				temperature: 0,
				maxTokens: 0,
				toolChoice: { type: "function", function: { name: "read" } },
				promptMode: "reasoning",
				reasoningEffort: "low",
				sessionId: "session-7",
				cacheRetention,
			}),
		);
		expect(payload).toMatchObject({
			temperature: 0,
			max_tokens: 0,
			tool_choice: { type: "function", function: { name: "read" } },
			prompt_mode: "reasoning",
			reasoning_effort: "low",
			tools: [{ type: "function", function: { name: "read", strict: false } }],
		});
		expect(payload.prompt_cache_key).toBe(cacheRetention === "none" ? undefined : "session-7");
	},
);

test("wire conversion translates nested response schemas and does not mutate the request", () => {
	const payload: MistralPayload = {
		model: model.id,
		stream: true,
		messages: [{ role: "user", content: "hello" }],
		topP: 0.5,
		randomSeed: 7,
		presencePenalty: 0,
		frequencyPenalty: 0,
		parallelToolCalls: false,
		safePrompt: true,
		responseFormat: {
			type: "json_schema",
			jsonSchema: { name: "answer", schemaDefinition: { type: "object", properties: { value: { type: "string" } } } },
		},
	};
	const before = structuredClone(payload);
	expect(mistralWirePayload(payload)).toMatchObject({
		top_p: 0.5,
		random_seed: 7,
		presence_penalty: 0,
		frequency_penalty: 0,
		parallel_tool_calls: false,
		safe_prompt: true,
		response_format: { json_schema: { schema: { type: "object", properties: { value: { type: "string" } } } } },
	});
	expect(payload).toEqual(before);
});
