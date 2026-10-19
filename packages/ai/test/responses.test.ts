import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { appendGrammarToolInputJsonDelta, makeStrictJsonSchema } from "../src/api/constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "../src/api/openai-prompt-cache.ts";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses.ts";
import { stream, streamSimple } from "../src/api/openai-responses.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "../src/api/openai-responses-shared.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Model, Tool, TranscriptContext } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://provider.invalid/v1",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 100_000,
	maxTokens: 5000,
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
function sse(events: object[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
	});
}
const complete = {
	type: "response.completed",
	response: {
		id: "response-1",
		status: "completed",
		service_tier: "flex",
		usage: {
			input_tokens: 100,
			output_tokens: 20,
			total_tokens: 120,
			input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
			output_tokens_details: { reasoning_tokens: 4 },
		},
	},
};
const textItem = {
	type: "message",
	id: "message-1",
	role: "assistant",
	status: "completed",
	phase: "final_answer",
	content: [{ type: "output_text", text: "answer", annotations: [] }],
};
function answer(): Response {
	return sse([
		{ type: "response.created", response: { id: "response-1" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...textItem, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, delta: "answer" },
		{ type: "response.output_item.done", output_index: 0, item: textItem },
		complete,
	]);
}
function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}
describe("Responses requests", () => {
	it("backfills the current reasoning signature", async () => {
		const output = assistant([]);
		const reasoning = { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "Before" }] };
		await processResponsesStream(
			(async function* () {
				yield { type: "response.output_item.done", output_index: 0, item: reasoning } as ResponseStreamEvent;
				const block = output.content[0];
				if (block?.type !== "thinking") throw new Error("Expected reasoning output");
				block.thinkingSignature = JSON.stringify({
					...reasoning,
					summary: [{ type: "summary_text", text: "After" }],
				});
				yield {
					type: "response.completed",
					response: {
						status: "completed",
						output: [{ ...reasoning, encrypted_content: "opaque" }],
					},
				} as ResponseStreamEvent;
			})(),
			output,
			new AssistantMessageEventStream(),
			model,
		);
		expect(output.content[0]).toMatchObject({
			thinkingSignature:
				'{"type":"reasoning","id":"rs-1","summary":[{"type":"summary_text","text":"After"}],"encrypted_content":"opaque"}',
		});
	});
	it.each([null, ""])("treats an empty provider status as a completed response: %j", async (status) => {
		const result = await stream(model, context, {
			apiKey: "test-key",
			fetch: async () => sse([{ type: "response.completed", response: { id: "empty-status", status } }]),
		}).result();
		expect({ reason: result.stopReason, raw: result.rawStopReason, error: result.errorMessage }).toEqual({
			reason: "stop",
			raw: status,
			error: undefined,
		});
	});
	it("retains a supplied cache-write field without adding a second coercion policy", async () => {
		const result = await stream(model, context, {
			apiKey: "test-key",
			fetch: async () =>
				sse([
					{
						type: "response.completed",
						response: {
							status: "completed",
							usage: { input_tokens: 10, input_tokens_details: { cache_write_tokens: "3" } },
						},
					},
				]),
		}).result();
		expect({ input: result.usage.input, cacheWrite: result.usage.cacheWrite, reason: result.stopReason }).toEqual({
			input: 7,
			cacheWrite: "3",
			reason: "stop",
		});
	});
	it("does not resolve a pricing tier without a pricing callback", async () => {
		let resolutions = 0;
		const output = { ...assistant([]), stopReason: "pending" as const };
		await processResponsesStream(
			(async function* () {
				yield complete as unknown as ResponseStreamEvent;
			})(),
			output,
			new AssistantMessageEventStream(),
			model,
			{
				resolveServiceTier() {
					resolutions++;
					return "flex";
				},
			},
		);
		expect({ resolutions, reason: output.stopReason }).toEqual({ resolutions: 0, reason: "stop" });
	});
	it("reads fallback pricing after the response callback", async () => {
		const options: OpenAIResponsesOptions = {
			apiKey: "test-key",
			serviceTier: "default",
			onResponse() {
				options.serviceTier = "flex";
			},
			fetch: async () =>
				sse([
					{
						type: "response.completed",
						response: {
							id: "result",
							status: "completed",
							usage: { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000 },
						},
					},
				]),
		};
		const result = await stream(model, context, options).result();
		expect(result.usage.cost).toEqual({ input: 0.0005, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.0015 });
	});
	it("retains the selected request timeout across retries", async () => {
		let reads = 0,
			calls = 0;
		const result = await stream(model, context, {
			apiKey: "test-key",
			get timeoutMs() {
				reads++;
				return 1000;
			},
			maxRetries: 1,
			fetch: async () => {
				if (++calls === 1)
					return Response.json({ error: { message: "Retry" } }, { status: 429, headers: { "retry-after-ms": "0" } });
				return answer();
			},
		}).result();
		expect({ reads, calls, reason: result.stopReason }).toEqual({ reads: 2, calls: 2, reason: "stop" });
	});
	it("streams an answer, reports callbacks in order, and separates cached input costs", async () => {
		const observed: string[] = [];
		let body = "";
		const result = stream(model, context, {
			apiKey: "test-key",
			maxTokens: 1,
			temperature: 0,
			sessionId: "session-1",
			cacheRetention: "long",
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
			onResponse: async (response, receivedModel) => {
				await Promise.resolve();
				observed.push("response");
				expect(response.status).toBe(200);
				expect(response.headers["x-request-id"]).toBe("request-1");
				expect(receivedModel).toBe(model);
			},
			onProviderStreamEvent: async (event) => {
				await Promise.resolve();
				if (event && typeof event === "object" && "type" in event) observed.push(String(event.type));
			},
		});
		const kinds: string[] = [];
		for await (const event of result) kinds.push(event.type);
		expect(kinds).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(observed).toEqual([
			"response",
			"response.created",
			"response.output_item.added",
			"response.output_text.delta",
			"response.output_item.done",
			"response.completed",
		]);
		expect(JSON.parse(body)).toMatchObject({
			model: "test-model",
			max_output_tokens: 16,
			temperature: 0,
			prompt_cache_key: "session-1",
			prompt_cache_retention: "24h",
			store: false,
		});
		const message = await result.result();
		expect(message).toMatchObject({
			stopReason: "stop",
			responseId: "response-1",
			rawStopReason: "completed",
			content: [{ type: "text", text: "answer", textSignature: '{"v":1,"id":"message-1","phase":"final_answer"}' }],
			usage: { input: 60, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 4, totalTokens: 120 },
		});
		expect(message.usage.cost.input).toBeCloseTo(0.00003, 12);
		expect(message.usage.cost.output).toBeCloseTo(0.00002, 12);
		expect(message.usage.cost.cacheRead).toBeCloseTo(0.0000075, 12);
		expect(message.usage.cost.cacheWrite).toBeCloseTo(0.00000625, 12);
		expect(message.usage.cost.total).toBeCloseTo(0.00006375, 12);
	});
	it("lets request sampling override model and thinking defaults", async () => {
		let payload: unknown;
		await streamSimple(
			{
				...model,
				samplingParams: { temperature: 0.7, top_p: 0.9 },
				samplingParamsByThinkingLevel: { high: { top_p: 0.6 } },
			},
			context,
			{
				apiKey: "test-key",
				reasoning: "high",
				samplingParams: { top_p: 0.2 },
				onPayload: (value) => {
					payload = value;
				},
				fetch: async () => answer(),
			},
		).result();
		expect(payload).toMatchObject({ temperature: 0.7, top_p: 0.2, reasoning: { effort: "high", summary: "auto" } });
	});
	it("uses payload replacements and respects callback failures", async () => {
		let body = "";
		const result = await stream(model, context, {
			apiKey: "test-key",
			onPayload: () => ({ model: "replacement", stream: true, input: [] }),
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
			onResponse: () => {
				throw new Error("observer failed");
			},
		}).result();
		expect(JSON.parse(body)).toEqual({ model: "replacement", stream: true, input: [] });
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "observer failed", content: [] });
	});
	it("retries one throttled SDK request with its own retry policy", async () => {
		let attempts = 0;
		const result = await stream(model, context, {
			apiKey: "test-key",
			maxRetries: 1,
			fetch: async () =>
				++attempts === 1
					? new Response('{"error":{"message":"wait"}}', { status: 429, headers: { "retry-after-ms": "0" } })
					: answer(),
		}).result();
		expect({ attempts, stopReason: result.stopReason }).toEqual({ attempts: 2, stopReason: "stop" });
	});
	it("disables affinity and sets explicit no-cache behavior when requested", async () => {
		let body = "",
			session: string | null = "",
			client: string | null = "";
		await stream({ ...model, compat: { supportsExplicitPromptCacheMode: true } }, context, {
			apiKey: "test-key",
			cacheRetention: "none",
			sessionId: "discard",
			fetch: async (_url, init) => {
				body = String(init?.body);
				const headers = new Headers(init?.headers);
				session = headers.get("session_id");
				client = headers.get("x-client-request-id");
				return answer();
			},
		}).result();
		expect({ session, client, body: JSON.parse(body) }).toMatchObject({
			session: null,
			client: null,
			body: { prompt_cache_options: { mode: "explicit" } },
		});
		expect(JSON.parse(body)).not.toHaveProperty("prompt_cache_key");
	});
	it("reports early EOF and strips streaming buffers from unfinished calls", async () => {
		const result = await stream(model, context, {
			apiKey: "test-key",
			fetch: async () =>
				sse([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "edit", arguments: "" },
					},
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"file' },
				]),
		}).result();
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI Responses stream ended before a terminal response event",
			content: [{ type: "toolCall", id: "call_1|fc_1", name: "edit", arguments: { path: "file" } }],
		});
		expect(Object.keys(result.content[0] ?? {})).toEqual(["type", "id", "name", "arguments"]);
	});
	it("retains terminal content-filter reasons as errors", async () => {
		const result = await stream(model, context, {
			apiKey: "test-key",
			fetch: async () =>
				sse([
					{
						type: "response.incomplete",
						response: { id: "filtered", status: "incomplete", incomplete_details: { reason: "content_filter" } },
					},
				]),
		}).result();
		expect(result).toMatchObject({
			stopReason: "error",
			rawStopReason: "incomplete.content_filter",
			errorMessage: "Response incomplete: content_filter",
		});
	});
	it.each([[7], [true], [{}], [[]]])("ignores non-string incomplete reasons: %j", async (reason) => {
		const result = await stream(model, context, {
			apiKey: "test-key",
			fetch: async () =>
				sse([
					{
						type: "response.incomplete",
						response: { id: "unfinished", status: "incomplete", incomplete_details: { reason } },
					},
				]),
		}).result();
		expect({ reason: result.stopReason, raw: result.rawStopReason, error: result.errorMessage }).toEqual({
			reason: "error",
			raw: "incomplete",
			error: "Response incomplete without a provider reason",
		});
	});
});
describe("tool declarations and replay", () => {
	it("replays opaque reasoning items without requiring a summary", () => {
		const history = normalizeContext({
			messages: [
				assistant([
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: '{"type":"reasoning","id":"rs_1","encrypted_content":"opaque"}',
					},
				]),
			],
		});
		expect(convertResponsesMessages(model, history, new Set(["openai"]))).toEqual([
			{ type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
		]);
	});
	it("preserves non-strict tool schema identity", () => {
		const parameters = { type: "object", properties: {}, description: "before" };
		const [tool] = convertResponsesTools([{ name: "read", description: "Read", parameters }]);
		if (tool?.type !== "function") throw new Error("Expected a function tool");
		parameters.description = "after";
		expect(tool.parameters).toBe(parameters);
		expect(tool.parameters).toMatchObject({ type: "object", properties: {}, description: "after" });
	});
	it("strictifies nested optional fields without altering the original schema", () => {
		const schema = Type.Object({
			path: Type.String(),
			options: Type.Object({ dryRun: Type.Optional(Type.Boolean()) }),
		});
		expect(makeStrictJsonSchema(schema)).toMatchObject({
			required: ["path", "options"],
			additionalProperties: false,
			properties: {
				options: {
					required: ["dryRun"],
					additionalProperties: false,
					properties: { dryRun: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
				},
			},
		});
		expect(schema.properties.options).not.toHaveProperty("additionalProperties");
	});
	it("escapes grammar input as append-only JSON and rejects edits after closing", () => {
		const buffer = { input: "", started: false, closed: false };
		const a = appendGrammarToolInputJsonDelta(buffer, "source", 'x"', false);
		const b = appendGrammarToolInputJsonDelta(buffer, "source", 'x"\n\ty', true);
		expect(JSON.parse(`${a}${b}`)).toEqual({ source: 'x"\n\ty' });
		expect(() => appendGrammarToolInputJsonDelta(buffer, "source", "other", true)).toThrow(
			'grammar tool input for property "source" changed after it was closed',
		);
	});
	it("keeps multimodal tool output in the original call's result", () => {
		const history = normalizeContext({
			messages: [
				assistant([{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: {} }]),
				{
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "read",
					isError: false,
					timestamp: 3,
					content: [
						{ type: "text", text: "image" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
				},
			],
		});
		expect(convertResponsesMessages(model, history, new Set(["openai"]))).toEqual([
			{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}" },
			{
				type: "function_call_output",
				call_id: "call_1",
				output: [
					{ type: "input_text", text: "image" },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGVsbG8=" },
				],
			},
		]);
	});
	it("repairs unanswered calls before a held system update and later user input", () => {
		const tool: Tool = { name: "read", description: "Read", parameters: Type.Object({}) };
		const history: TranscriptContext = normalizeContext({
			messages: [
				assistant([{ type: "toolCall", id: "call_1", name: tool.name, arguments: {} }]),
				{ role: "system", content: "new rules", timestamp: 3 },
				{ role: "user", content: "next", timestamp: 4 },
			],
		});
		const messages = transformMessages(history.messages, model);
		expect(messages.map((message) => message.role)).toEqual(["assistant", "toolResult", "system", "user"]);
		expect(messages[1]).toMatchObject({
			toolCallId: "call_1",
			isError: true,
			content: [{ type: "text", text: "No result provided" }],
		});
	});
	it("clamps cache identifiers by Unicode characters", () => {
		expect(clampOpenAIPromptCacheKey("🙂".repeat(63) + "ab")).toBe("🙂".repeat(63) + "a");
	});
});
