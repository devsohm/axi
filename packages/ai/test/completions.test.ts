import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { openAICompletionsApi } from "../src/api/openai-completions.lazy.ts";
import { stream, streamSimple } from "../src/api/openai-completions.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test",
	api: "openai-completions",
	provider: "local",
	baseUrl: "https://provider.invalid/v1",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 100_000,
	maxTokens: 5000,
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const tool: Tool = { name: "lookup", description: "Lookup", parameters: Type.Object({ query: Type.String() }) };
function chunk(delta: object, reason: string | null = null): object {
	return { id: "response-1", model: "resolved-model", choices: [{ index: 0, delta, finish_reason: reason }] };
}
function response(chunks: object[]): Response {
	return new Response(chunks.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
	});
}
function answer(): Response {
	return response([chunk({ content: "answer" }, "stop")]);
}

describe("Chat Completions", () => {
	it.each([
		{ details: undefined, top: 31, expected: 31 },
		{ details: {}, top: 31, expected: 31 },
		{ details: { reasoning_tokens: 0 }, top: 31, expected: 31 },
		{ details: { reasoning_tokens: 13 }, top: 31, expected: 13 },
		{ details: undefined, top: undefined, expected: 0 },
	])(
		"reasoning accounting preserves nested-field precedence and provider fallbacks: $details $top",
		async ({ details, top, expected }) => {
			const result = await stream({ ...model, provider: "github-copilot" }, context, {
				apiKey: "offline",
				fetch: async () =>
					response([
						{
							...chunk({ content: "answer" }, "stop"),
							usage: {
								prompt_tokens: 9,
								completion_tokens: 47,
								completion_tokens_details: details,
								reasoning_tokens: top,
							},
						},
					]),
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.usage).toMatchObject({ input: 9, output: 47, reasoning: expected, totalTokens: 56 });
		},
	);

	it.each([
		{ usage: { prompt_tokens: 7, cached_tokens: 4 }, input: 3, cacheRead: 4 },
		{ usage: { prompt_tokens: 7, cached_tokens: 4, prompt_cache_hit_tokens: 5 }, input: 2, cacheRead: 5 },
		{
			usage: { prompt_tokens: 7, prompt_cache_hit_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
			input: 7,
			cacheRead: 0,
		},
		{ usage: { cached_tokens: 10 }, input: 0, cacheRead: 10 },
	])("cache accounting preserves provider field precedence: $usage", async ({ usage, input, cacheRead }) => {
		const result = await stream(model, context, {
			apiKey: "offline",
			fetch: async () => response([{ ...chunk({ content: "answer" }, "stop"), usage }]),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage).toMatchObject({
			input,
			output: 0,
			cacheRead,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: input + cacheRead,
		});
	});

	it("streamed reasoning fragments retain their metadata and join adjacent text and summaries", async () => {
		const result = await stream(model, context, {
			apiKey: "offline",
			fetch: async () =>
				response([
					chunk({ reasoning_details: [{ type: "reasoning.text", text: "a", signature: "", id: null, index: 0 }] }),
					chunk({
						reasoning_details: [
							{ type: "reasoning.text", text: "b", signature: "signed", id: "text", index: 1, format: "wire" },
						],
					}),
					chunk({
						reasoning_details: [
							{ type: "reasoning.text", text: "c", signature: "replacement", id: "other", format: "other" },
						],
					}),
					chunk({ reasoning_details: [{ type: "reasoning.summary", summary: "first " }] }),
					chunk({
						reasoning_details: [
							{ type: "reasoning.summary", summary: "second", id: "summary", index: 2, format: "summary-wire" },
						],
					}),
					chunk({ reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }] }),
					chunk({ content: "answer" }, "stop"),
				]),
		}).result();
		expect(result.stopReason).toBe("stop");
		const thinking = result.content.find((item) => item.type === "thinking");
		if (thinking?.type !== "thinking") throw new Error("Missing reasoning block");
		expect(JSON.parse(thinking.thinkingSignature ?? "null")).toEqual([
			{ type: "reasoning.text", text: "abc", signature: "signed", id: "text", index: 0, format: "wire" },
			{ type: "reasoning.summary", summary: "first second", id: "summary", index: 2, format: "summary-wire" },
			{ type: "reasoning.encrypted", data: "opaque" },
		]);
	});
	it.each([undefined, false, true])("uses the explicit empty-tool compatibility option %s", async (setting) => {
		let body = "";
		const history = normalizeContext({
			messages: [
				...context.messages,
				{
					...fauxAssistantMessage([{ type: "toolCall", id: "done", name: "lookup", arguments: {} }]),
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "done",
					toolName: "lookup",
					content: [{ type: "text", text: "found" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [],
		});
		const selected = { ...model, compat: { requiresToolsWithToolHistory: setting } };
		const result = await stream(selected, history, {
			apiKey: "offline",
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		if (setting === true) expect(JSON.parse(body)).toHaveProperty("tools", []);
		else expect(JSON.parse(body)).not.toHaveProperty("tools");
	});
	it("uses compatibility settings exposed through class getters", async () => {
		const compat = new (class {
			get supportsStore() {
				return false;
			}
			get supportsDeveloperRole() {
				return false;
			}
			get supportsReasoningEffort() {
				return false;
			}
			get maxTokensField(): "max_tokens" {
				return "max_tokens";
			}
		})();
		let body = "";
		const result = await stream(
			{ ...model, compat },
			normalizeContext({ systemPrompt: "Instructions", messages: context.messages }),
			{
				apiKey: "test",
				maxTokens: 128,
				reasoningEffort: "high",
				fetch: async (_input, init) => {
					body = String(init?.body);
					return answer();
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(body)).toEqual({
			model: model.id,
			messages: [
				{ role: "system", content: "Instructions" },
				{ role: "user", content: "hello" },
			],
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 128,
		});
	});
	it("publishes tool argument previews without private parser state", async () => {
		const frames = [
			chunk({ tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: '{"query":"a"}' } }] }),
			chunk({}, "tool_calls"),
		];
		let next = 0;
		const source = stream(model, context, {
			apiKey: "offline",
			fetch: async () =>
				new Response(
					new ReadableStream({
						async pull(controller) {
							await new Promise((resolve) => setImmediate(resolve));
							if (next === frames.length) controller.close();
							else controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frames[next++])}\n\n`));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		const snapshots = [];
		for await (const event of source)
			if (event.type === "toolcall_delta" || event.type === "toolcall_end")
				snapshots.push(structuredClone(event.partial.content[0]));
		expect(snapshots).toStrictEqual([
			{
				type: "toolCall",
				id: "call-1",
				name: "lookup",
				arguments: { query: "a" },
			},
			{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "a" } },
		]);
	});
	it("retains the selected timeout across chat retries", async () => {
		let reads = 0,
			calls = 0;
		const result = await stream(model, context, {
			apiKey: "test",
			maxRetries: 1,
			get timeoutMs() {
				reads++;
				return 1000;
			},
			fetch: async () => {
				if (++calls === 1)
					return Response.json({ error: { message: "Retry" } }, { status: 429, headers: { "retry-after-ms": "0" } });
				return answer();
			},
		}).result();
		expect({ reads, calls, reason: result.stopReason }).toEqual({ reads: 2, calls: 2, reason: "stop" });
	});
	it("streams interleaved calls, preserves response metadata and accounts for all token categories", async () => {
		const callbacks: string[] = [],
			deltas: Array<{ index: number; delta: string }> = [];
		const events = stream(model, context, {
			apiKey: "test",
			fetch: async () =>
				response([
					chunk({ reasoning_content: "think", reasoning: "duplicate", content: "answer" }),
					chunk({
						tool_calls: [
							{ index: 0, id: "a", function: { name: "lookup", arguments: '{"query":' } },
							{ index: 1, id: "b", function: { name: "lookup", arguments: '{"query":"b"}' } },
						],
					}),
					chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, "tool_calls"),
					{
						id: "response-1",
						choices: [],
						usage: {
							prompt_tokens: 100,
							completion_tokens: 20,
							prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
							completion_tokens_details: { reasoning_tokens: 5 },
						},
					},
				]),
			onResponse: (value) => {
				callbacks.push(value.headers["x-request-id"]);
			},
			onProviderStreamEvent: () => {
				callbacks.push("chunk");
			},
		});
		for await (const event of events)
			if (event.type === "toolcall_delta") deltas.push({ index: event.contentIndex, delta: event.delta });
		const result = await events.result();
		expect(callbacks).toEqual(["request-1", "chunk", "chunk", "chunk", "chunk"]);
		expect(deltas).toEqual([
			{ index: 2, delta: '{"query":' },
			{ index: 3, delta: '{"query":"b"}' },
			{ index: 2, delta: '"a"}' },
		]);
		expect(result).toMatchObject({
			responseId: "response-1",
			responseModel: "resolved-model",
			stopReason: "toolUse",
			rawStopReason: "tool_calls",
			content: [
				{ type: "thinking", thinking: "think", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "a", name: "lookup", arguments: { query: "a" } },
				{ type: "toolCall", id: "b", name: "lookup", arguments: { query: "b" } },
			],
			usage: { input: 60, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 5, totalTokens: 120 },
		});
		expect(result.usage.cost.total).toBeCloseTo(0.000325, 12);
	});
	it("preserves encrypted and merged reasoning metadata when the answer is replayed", async () => {
		const selected = { ...model, provider: "openrouter" };
		const first = await stream(selected, context, {
			apiKey: "test",
			fetch: async () =>
				response([
					chunk({ reasoning: "reason", reasoning_details: [{ type: "reasoning.text", text: "one" }] }),
					chunk(
						{
							reasoning_details: [
								{ type: "reasoning.text", text: "two", signature: "signed" },
								{ type: "reasoning.encrypted", id: "r", data: "opaque" },
							],
							content: "answer",
						},
						"stop",
					),
				]),
		}).result();
		let body = "";
		await stream(selected, normalizeContext({ messages: [first] }), {
			apiKey: "test",
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
		}).result();
		expect(JSON.parse(body).messages).toEqual([
			{
				role: "assistant",
				content: "answer",
				reasoning_details: [
					{ type: "reasoning.text", text: "onetwo", signature: "signed" },
					{ type: "reasoning.encrypted", id: "r", data: "opaque" },
				],
			},
		]);
	});
	it("sends thinking budgets and lets request sampling override model defaults", async () => {
		let body = "";
		const result = await streamSimple(
			{
				...model,
				compat: {
					thinkingFormat: "chat-template",
					thinkingTokenBudgetField: "thinking_budget",
					chatTemplateKwargs: { enabled: { $var: "thinking.enabled" }, budget: { $var: "thinking.budget" } },
				},
				samplingParams: { temperature: 0.8, top_p: 0.9 },
				samplingParamsByThinkingLevel: { high: { top_p: 0.6 } },
			},
			context,
			{
				apiKey: "test",
				reasoning: "high",
				maxTokens: 2000,
				thinkingBudgets: { high: 5000 },
				samplingParams: { top_p: 0.2 },
				fetch: async (_url, init) => {
					body = String(init?.body);
					return answer();
				},
			},
		).result();
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
		expect(JSON.parse(body)).toMatchObject({
			max_completion_tokens: 2000,
			thinking_budget: 976,
			chat_template_kwargs: { enabled: true, budget: 976 },
			top_p: 0.2,
			temperature: 0.8,
		});
	});
	it("declares grammar tools and streams their raw input as one JSON string argument", async () => {
		let body = "";
		const deltas: string[] = [];
		const source = stream(
			{ ...model, compat: { supportsOpenAIGrammarTools: true } },
			normalizeContext({
				messages: context.messages,
				tools: [{ ...tool, constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } } }],
			}),
			{
				apiKey: "test",
				fetch: async (_url, init) => {
					body = String(init?.body);
					return response([
						chunk({ tool_calls: [{ index: 0, id: "a", custom: { name: "lookup", input: 'a"' } }] }),
						chunk({ tool_calls: [{ index: 0, custom: { input: "b\n" } }] }, "tool_calls"),
					]);
				},
			},
		);
		for await (const event of source) if (event.type === "toolcall_delta") deltas.push(event.delta);
		expect(JSON.parse(deltas.join(""))).toEqual({ query: 'a"b\n' });
		expect((await source.result()).content).toEqual([
			{ type: "toolCall", id: "a", name: "lookup", arguments: { query: 'a"b\n' } },
		]);
		expect(JSON.parse(body).tools).toEqual([
			{
				type: "custom",
				custom: {
					name: "lookup",
					description: "Lookup",
					format: { type: "grammar", grammar: { syntax: "regex", definition: ".*" } },
				},
			},
		]);
	});
	it("records malformed final tool arguments instead of returning a repaired executable call", async () => {
		const result = await stream(model, context, {
			apiKey: "test",
			fetch: async () =>
				response([
					chunk(
						{ tool_calls: [{ index: 0, id: "a", function: { name: "lookup", arguments: '{"query":' } }] },
						"tool_calls",
					),
				]),
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			id: "a",
			arguments: {},
			argumentsError: expect.stringContaining('Received arguments:\n{"query":'),
		});
	});
	it("requires a finish reason unless the endpoint explicitly does not send one", async () => {
		const fetch: typeof globalThis.fetch = async () => response([chunk({ content: "answer" })]);
		const strict = await stream(model, context, { apiKey: "test", fetch }).result();
		const permissive = await stream({ ...model, compat: { supportsFinishReason: false } }, context, {
			apiKey: "test",
			fetch,
		}).result();
		expect(strict).toMatchObject({
			stopReason: "error",
			errorMessage: "Stream ended without finish_reason",
			content: [{ type: "text", text: "answer" }],
		});
		expect(permissive).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "answer" }] });
	});
	it("accepts explicit authorization headers and preserves header precedence", async () => {
		let headers = new Headers();
		const result = await stream(
			{
				...model,
				headers: { "x-session-id": "model" },
				compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
			},
			context,
			{
				headers: { Authorization: "Bearer custom", "x-session-id": "request" },
				sessionId: "generated",
				fetch: async (_url, init) => {
					headers = new Headers(init?.headers);
					return answer();
				},
			},
		).result();
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
		expect(headers.get("authorization")).toBe("Bearer custom");
		expect(headers.get("x-session-id")).toBe("request");
		expect(headers.get("user-agent")).toMatch(/^axi\//);
	});
	it("returns asynchronous errors in stream and throws missing auth before simple-stream setup", async () => {
		const failed = await stream(model, context).result();
		expect(failed).toMatchObject({ stopReason: "error", errorMessage: "No API key for provider: local" });
		expect(() => streamSimple(model, context)).toThrow("No API key for provider: local");
	});
	it("honors cancellation during raw-event delivery", async () => {
		const controller = new AbortController();
		const result = await stream(model, context, {
			apiKey: "test",
			signal: controller.signal,
			fetch: async () => answer(),
			onProviderStreamEvent: () => controller.abort(),
		}).result();
		expect(result).toMatchObject({ stopReason: "aborted", errorMessage: expect.stringMatching(/abort/i) });
	});
	it("fails a provider-requested retry above the configured delay without issuing another request", async () => {
		let calls = 0;
		const result = await stream(model, context, {
			apiKey: "test",
			maxRetries: 2,
			maxRetryDelayMs: 100,
			fetch: async () => {
				calls++;
				return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { "retry-after": "10" } });
			},
		}).result();
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("Server requested 10s retry delay (max: 1s)"),
		});
		expect(calls).toBe(1);
	});
	it("reaches a real local endpoint through the lazy provider and shared Models runtime", async () => {
		const requests: unknown[] = [];
		const server = createServer(async (request, reply) => {
			let body = "";
			for await (const data of request) body += data.toString();
			requests.push({ path: request.url, body: JSON.parse(body) });
			reply.writeHead(200, { "content-type": "text/event-stream" });
			reply.end(`data: ${JSON.stringify(chunk({ content: "local answer" }, "stop"))}\n\ndata: [DONE]\n\n`);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const selected = { ...model, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
			const models = createModels();
			models.setProvider(
				createProvider({
					id: "local",
					name: "Local",
					baseUrl: selected.baseUrl,
					models: [selected],
					api: openAICompletionsApi(),
					auth: { apiKey: envApiKeyAuth("Local key", ["LOCAL_KEY"]) },
				}),
			);
			const result: AssistantMessage = await models.completeSimple(
				selected,
				{ messages: context.messages },
				{ apiKey: "test" },
			);
			expect(result.content).toEqual([{ type: "text", text: "local answer" }]);
			expect(requests).toEqual([
				{
					path: "/v1/chat/completions",
					body: expect.objectContaining({
						model: "test-model",
						stream: true,
						messages: [{ role: "user", content: "hello" }],
					}),
				},
			]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});

it("reads billed totals from OpenRouter streams without applying them to other providers", async () => {
	for (const provider of ["openrouter", "local"]) {
		const result = await stream({ ...model, provider }, context, {
			apiKey: "offline",
			fetch: async () =>
				response([
					{
						...chunk({ content: "ok" }, "stop"),
						usage: {
							prompt_tokens: 12,
							completion_tokens: 3,
							cost: 0.42,
							is_byok: false,
						},
					},
				]),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.cost.totalFromProvider).toBe(provider === "openrouter");
		expect(result.usage.cost.total).toBeCloseTo(provider === "openrouter" ? 0.42 : 0.000048);
	}
});

it.each([
	["local", "reasoning", "reasoning"],
	["local", "reasoning_content", "reasoning_content"],
	["local", "reasoning_text", "reasoning_text"],
	["opencode-go", "reasoning", "reasoning_content"],
])("replays %s thinking through its %s wire field", async (provider, signature, field) => {
	let body = "";
	const selected = { ...model, provider };
	const history = {
		...fauxAssistantMessage([
			{ type: "thinking", thinking: "first", thinkingSignature: signature },
			{ type: "thinking", thinking: "second", thinkingSignature: signature },
			{ type: "text", text: "answer" },
		]),
		api: model.api,
		provider,
		model: model.id,
	};
	await stream(selected, normalizeContext({ messages: [history] }), {
		apiKey: "offline",
		fetch: async (_url, init) => {
			body = String(init?.body);
			return answer();
		},
	}).result();
	expect(JSON.parse(body).messages).toEqual([{ role: "assistant", content: "answer", [field]: "first\nsecond" }]);
});

it("replays thinking as text for endpoints that require it", async () => {
	let body = "";
	const history = {
		...fauxAssistantMessage([
			{ type: "thinking", thinking: "first" },
			{ type: "thinking", thinking: "second" },
			{ type: "text", text: "answer" },
		]),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	await stream({ ...model, compat: { requiresThinkingAsText: true } }, normalizeContext({ messages: [history] }), {
		apiKey: "offline",
		fetch: async (_url, init) => {
			body = String(init?.body);
			return answer();
		},
	}).result();
	expect(JSON.parse(body).messages).toEqual([
		{
			role: "assistant",
			content: [
				{ type: "text", text: "first\n\nsecond" },
				{ type: "text", text: "answer" },
			],
		},
	]);
});

it.each([
	"{",
	"[null]",
	'[{"type":"reasoning.text","text":"t","id":3}]',
	'[{"type":"reasoning.text","text":"t","format":3}]',
	'[{"type":"reasoning.text","text":"t","index":"0"}]',
	'[{"type":"unknown","text":"t"}]',
])("does not forward malformed saved reasoning metadata %s", async (signature) => {
	let body = "";
	const history = {
		...fauxAssistantMessage([
			{ type: "thinking", thinking: "private", thinkingSignature: signature },
			{ type: "text", text: "answer" },
		]),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	await stream(model, normalizeContext({ messages: [history] }), {
		apiKey: "offline",
		fetch: async (_url, init) => {
			body = String(init?.body);
			return answer();
		},
	}).result();
	expect(JSON.parse(body).messages).toEqual([{ role: "assistant", content: "answer" }]);
});

it("preserves a saved summary and legacy encrypted tool reasoning when replaying a conversation", async () => {
	const encrypted = { type: "reasoning.encrypted", id: "reason-1", data: "opaque" };
	const summary = { type: "reasoning.summary", summary: "short summary", index: 0 };
	for (const signature of [JSON.stringify(encrypted), "not JSON"]) {
		let body = "";
		const history = {
			...fauxAssistantMessage([
				{ type: "toolCall", id: "call", name: "lookup", arguments: {}, thoughtSignature: signature },
			]),
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse" as const,
		};
		await stream(model, normalizeContext({ messages: [history] }), {
			apiKey: "offline",
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
		}).result();
		expect(JSON.parse(body).messages[0].reasoning_details).toEqual(signature === "not JSON" ? undefined : [encrypted]);
	}
	let body = "";
	const history = {
		...fauxAssistantMessage([
			{ type: "thinking", thinking: "hidden", thinkingSignature: JSON.stringify([summary]) },
			{ type: "text", text: "answer" },
		]),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	await stream(model, normalizeContext({ messages: [history] }), {
		apiKey: "offline",
		fetch: async (_url, init) => {
			body = String(init?.body);
			return answer();
		},
	}).result();
	expect(JSON.parse(body).messages).toEqual([{ role: "assistant", content: "answer", reasoning_details: [summary] }]);
});

it.each([
	["ordinary".repeat(8), "ordinary".repeat(5)],
	["call?one|item#two", "call_one_item_two"],
	["call?one|", "call_one"],
])("normalizes a foreign tool ID %s and preserves its result association", async (id, expected) => {
	let body = "";
	const history = fauxAssistantMessage([{ type: "toolCall", id, name: "lookup", arguments: {} }]);
	await stream(
		{ ...model, provider: "openai" },
		normalizeContext({
			messages: [
				history,
				{
					role: "toolResult",
					toolCallId: id,
					toolName: "lookup",
					content: [{ type: "text", text: "found" }],
					isError: false,
					timestamp: 2,
				},
			],
		}),
		{
			apiKey: "offline",
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
		},
	).result();
	expect(JSON.parse(body).messages).toMatchObject([
		{ role: "assistant", tool_calls: [{ id: expected, function: { name: "lookup", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: expected, content: "found" },
	]);
});

it("separates tool-result images with an assistant bridge when the endpoint requires it", async () => {
	let body = "";
	const history = {
		...fauxAssistantMessage([{ type: "toolCall", id: "lookup", name: "lookup", arguments: {} }]),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	await stream(
		{ ...model, compat: { requiresAssistantAfterToolResult: true } },
		normalizeContext({
			messages: [
				history,
				{
					role: "toolResult",
					toolCallId: "lookup",
					toolName: "lookup",
					content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "describe it", timestamp: 3 },
			],
		}),
		{
			apiKey: "offline",
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
		},
	).result();
	expect(JSON.parse(body).messages).toEqual([
		{
			role: "assistant",
			content: "",
			tool_calls: [{ type: "function", id: "lookup", function: { name: "lookup", arguments: "{}" } }],
		},
		{ role: "tool", tool_call_id: "lookup", content: "(see attached image)" },
		{ role: "assistant", content: "I have processed the tool results." },
		{
			role: "user",
			content: [
				{ type: "text", text: "Attached image(s) from tool result:" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
			],
		},
		{ role: "user", content: "describe it" },
	]);
});
