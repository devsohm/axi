import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAiBindingFetch } from "../src/api/cloudflare-ai-binding.ts";
import type { MistralOptions } from "../src/api/mistral-conversations.ts";
import { stream, streamSimple } from "../src/api/mistral-conversations.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"mistral-conversations"> = {
	api: "mistral-conversations",
	provider: "mistral",
	id: "test",
	name: "Test",
	baseUrl: "https://provider.invalid",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 100000,
	maxTokens: 8192,
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
function response(chunks: object[]): Response {
	return new Response(
		chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n",
	);
}
const stop = { choices: [{ finish_reason: "stop", delta: {} }] };
describe("Mistral transport", () => {
	it("copies schema fields with ordinary assignment before sending the request", async () => {
		const parameters = Type.Object(
			Object.fromEntries([
				["__proto__", Type.String()],
				["normal", Type.Number()],
			]),
		);
		let body: Record<string, unknown> | undefined;
		const result = await stream(
			model,
			normalizeContext({ ...context, tools: [{ name: "inspect", description: "Inspect input", parameters }] }),
			{
				apiKey: "offline",
				fetch: async (_url, init) => {
					body = JSON.parse(String(init?.body));
					return response([stop]);
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(body?.tools).toEqual([
			{
				type: "function",
				function: {
					name: "inspect",
					description: "Inspect input",
					parameters: { type: "object", properties: { normal: { type: "number" } }, required: ["__proto__", "normal"] },
					strict: false,
				},
			},
		]);
		expect(Object.hasOwn(parameters.properties, "__proto__")).toBe(true);
	});
	it("publishes partial tool arguments until the tool finishes", async () => {
		const chunks = [
			{
				choices: [
					{ delta: { tool_calls: [{ id: "abc123456", index: 0, function: { name: "read", arguments: '{"path":' } }] } },
				],
			},
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "", arguments: '"a"}' } }] } }] },
			{ choices: [{ finish_reason: "tool_calls", delta: {} }] },
		];
		let next = 0;
		const snapshots = [];
		const source = stream(model, context, {
			apiKey: "offline",
			fetch: async () =>
				new Response(
					new ReadableStream({
						async pull(controller) {
							await new Promise((resolve) => setImmediate(resolve));
							if (next === chunks.length) controller.close();
							else controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunks[next++])}\n\n`));
						},
					}),
				),
		});
		for await (const event of source)
			if (event.type === "toolcall_delta" || event.type === "toolcall_end")
				snapshots.push(structuredClone(event.partial.content[0]));
		expect(snapshots).toEqual([
			{ type: "toolCall", id: "abc123456", name: "read", arguments: {}, partialArgs: '{"path":' },
			{ type: "toolCall", id: "abc123456", name: "read", arguments: { path: "a" }, partialArgs: '{"path":"a"}' },
			{ type: "toolCall", id: "abc123456", name: "read", arguments: { path: "a" } },
		]);
	});
	it("keeps the selected credential when the payload callback changes its options", async () => {
		let authorization: string | null = null;
		const options: MistralOptions = {
			apiKey: "selected-key",
			onPayload() {
				options.apiKey = "later-key";
			},
			fetch: async (_url, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return response([stop]);
			},
		};
		const result = await stream(model, context, options).result();
		expect({ authorization, reason: result.stopReason }).toEqual({
			authorization: "Bearer selected-key",
			reason: "stop",
		});
	});
	it("delivers completed tool arguments before reporting a missing terminal frame", async () => {
		const source = stream(model, context, {
			apiKey: "offline",
			fetch: async () =>
				response([
					{
						choices: [
							{
								delta: {
									tool_calls: [{ id: "abc123456", index: 0, function: { name: "read", arguments: '{"path":"a"}' } }],
								},
							},
						],
					},
				]),
		});
		const order: string[] = [];
		for await (const event of source) order.push(event.type);
		expect(order).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "error"]);
		expect(await source.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Mistral stream ended without a finish reason",
			content: [{ type: "toolCall", arguments: { path: "a" } }],
		});
	});
	it("keeps empty deltas out of thinking and finalizes fragmented tool arguments", async () => {
		const raw: unknown[] = [],
			events: string[] = [];
		const chunks = [
			{ id: "first", choices: [{ delta: { content: [{ type: "thinking", thinking: [{ text: "first" }] }] } }] },
			{ choices: [{ delta: { content: "" } }] },
			{
				choices: [
					{
						delta: {
							content: [
								{ type: "text", text: "" },
								{ type: "thinking", thinking: [{ text: " second" }] },
								{ type: "text", text: "answer" },
							],
						},
					},
				],
			},
			{
				choices: [
					{ delta: { tool_calls: [{ id: "abc123456", index: 0, function: { name: "read", arguments: '{"path":' } }] } },
				],
			},
			{
				choices: [
					{
						finish_reason: "tool_calls",
						delta: { tool_calls: [{ index: 0, function: { name: "", arguments: '"a"}' } }] },
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, num_cached_tokens: 3 },
			},
		];
		const source = stream(model, context, {
			apiKey: "offline",
			fetch: async () => response(chunks),
			onProviderStreamEvent: (chunk) => {
				raw.push(chunk);
			},
		});
		for await (const event of source) events.push(event.type);
		const result = await source.result();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "first second" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "abc123456", name: "read", arguments: { path: "a" } },
		]);
		expect(result).toMatchObject({
			responseId: "first",
			stopReason: "toolUse",
			usage: { input: 7, output: 4, cacheRead: 3, totalTokens: 14 },
		});
		expect(raw).toEqual(chunks);
		expect(events).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
	});
	it("builds strict schemas, reasoning defaults and request replacements before snake-case encoding", async () => {
		let body: Record<string, unknown> | undefined, headers: Headers | undefined;
		await streamSimple(
			{ ...model, thinkingLevelMap: { off: "none", high: "high" }, headers: { "X-Affinity": "model-affinity" } },
			normalizeContext({
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
				tools: [
					{
						name: "read",
						description: "Read",
						parameters: Type.Object({ path: Type.String() }),
						constrainedSampling: { type: "json_schema", strict: "require" },
					},
				],
			}),
			{
				apiKey: "offline",
				sessionId: "session",
				headers: { "x-affinity": null, authorization: null },
				onPayload: (value) => ({
					...(value as object),
					responseFormat: { type: "json_schema", jsonSchema: { name: "result", schemaDefinition: { type: "object" } } },
				}),
				fetch: async (_url, init) => {
					body = JSON.parse(String(init?.body));
					headers = new Headers(init?.headers);
					return response([stop]);
				},
			},
		).result();
		expect(body).toMatchObject({
			reasoning_effort: "none",
			prompt_cache_key: "session",
			tools: [{ function: { strict: true, parameters: { additionalProperties: false, required: ["path"] } } }],
			response_format: { json_schema: { name: "result", schema: { type: "object" } } },
		});
		expect(body).not.toHaveProperty("responseFormat");
		expect(headers?.has("authorization")).toBe(false);
		expect(headers?.has("x-affinity")).toBe(false);
	});
	it("decodes UTF-8 split into bytes and preserves invalid terminal details", async () => {
		const wire = new TextEncoder().encode(
			`data: ${JSON.stringify({ choices: [{ finish_reason: "error", delta: { content: "héllo 🌍" } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`,
		);
		const result = await stream(model, context, {
			apiKey: "offline",
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
							controller.close();
						},
					}),
				),
		}).result();
		expect(result).toMatchObject({
			stopReason: "error",
			rawStopReason: "error",
			errorMessage: "Provider stopped with: error (server error)",
			content: [{ type: "text", text: "héllo 🌍" }],
		});
	});
	it("bounds HTTP error bodies and rejects early EOF", async () => {
		const result = await stream(model, context, {
			apiKey: "offline",
			fetch: async () => new Response("x".repeat(5000), { status: 403 }),
		}).result();
		expect(result.errorMessage).toBe(`Mistral API error (403): ${"x".repeat(4000)}... [truncated 1000 chars]`);
		expect(
			await stream(model, context, {
				apiKey: "offline",
				fetch: async () => response([{ choices: [{ delta: { content: "partial" } }] }]),
			}).result(),
		).toMatchObject({
			stopReason: "error",
			errorMessage: "Mistral stream ended without a finish reason",
			content: [{ type: "text", text: "partial" }],
		});
	});
	it("cancels blocked stream readers when the caller aborts", async () => {
		const abort = new AbortController();
		let cancelled = false;
		const source = stream(model, context, {
			apiKey: "offline",
			signal: abort.signal,
			fetch: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		for await (const event of source) {
			if (event.type === "start") abort.abort();
		}
		expect((await source.result()).stopReason).toBe("aborted");
		expect(cancelled).toBe(true);
	});
	it("limits waiting for headers without timing out an active stream", async () => {
		const timedOut = await stream(model, context, {
			apiKey: "offline",
			timeoutMs: 5,
			fetch: async (_url, init) =>
				new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
				),
		}).result();
		expect(timedOut.errorMessage).toBe("Mistral response headers timed out after 5ms");
		const active = await stream(model, context, {
			apiKey: "offline",
			timeoutMs: 5,
			fetch: async () =>
				new Response(
					new ReadableStream({
						async start(controller) {
							await new Promise((resolve) => setTimeout(resolve, 15));
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(stop)}\n\n`));
							controller.close();
						},
					}),
				),
		}).result();
		expect(active.stopReason).toBe("stop");
	});
	it("binds Workers fetch eagerly and preserves request and response identity", async () => {
		const request = new Request("https://workers-binding.ai/test", { method: "PUT", body: "data" }),
			answer = new Response("answer");
		const binding = {
			aiGatewayLogId: "one",
			async fetch(input: Request | string | URL) {
				expect(this.aiGatewayLogId).toBe("one");
				expect(input).toBe(request);
				return answer;
			},
		};
		const fetch = createAiBindingFetch(binding);
		binding.fetch = async () => {
			throw new Error("replaced");
		};
		expect(await fetch(request)).toBe(answer);
	});
});
