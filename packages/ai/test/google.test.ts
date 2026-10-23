import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
const sdk = vi.hoisted(() => ({
	clients: [] as Record<string, unknown>[],
	requests: [] as unknown[],
	chunks: [] as object[],
	request: vi.fn(),
}));
vi.mock("@google/genai", async (importOriginal) => {
	const original = await importOriginal<typeof import("@google/genai")>();
	return {
		...original,
		GoogleGenAI: class {
			constructor(config: Record<string, unknown>) {
				sdk.clients.push(config);
			}
			models = {
				generateContentStream: async (params: unknown) => {
					sdk.requests.push(params);
					await sdk.request();
					return (async function* () {
						yield* sdk.chunks;
					})();
				},
			};
		},
	};
});
import * as google from "../src/api/google-generative-ai.ts";
import * as vertex from "../src/api/google-vertex.ts";
import { googleGenerativeAIApi } from "../src/api/google-generative-ai.lazy.ts";
import { convertMessages, convertTools, mapStopReasonString } from "../src/api/google-shared.ts";
import { formatUserAgent } from "../src/utils/identity.ts";
const model: Model<"google-generative-ai"> = {
	api: "google-generative-ai",
	id: "gemini-3-flash-preview",
	provider: "google",
	name: "Test",
	baseUrl: "https://provider.invalid/v1beta",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 100_000,
	maxTokens: 4096,
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 },
};
const vertexModel: Model<"google-vertex"> = {
	...model,
	api: "google-vertex",
	provider: "vertex",
	baseUrl: "https://{location}-aiplatform.googleapis.com",
};
const context = normalizeContext({
	systemPrompt: "Be precise",
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
});
beforeEach(() => {
	sdk.clients.length = sdk.requests.length = 0;
	sdk.request.mockReset();
	sdk.chunks = [
		{
			responseId: "first",
			candidates: [{ content: { parts: [{ thought: true, text: "plan", thoughtSignature: "c2ln" }] } }],
		},
		{
			responseId: "second",
			candidates: [
				{
					content: {
						parts: [
							{ thought: true, text: " more" },
							{ text: "answer", thoughtSignature: "dGV4dA==" },
						],
					},
					finishReason: "STOP",
				},
			],
			usageMetadata: {
				promptTokenCount: 100,
				cachedContentTokenCount: 20,
				candidatesTokenCount: 30,
				thoughtsTokenCount: 5,
				totalTokenCount: 135,
			},
		},
	];
});
afterEach(() => vi.useRealTimers());
describe("Google adapters", () => {
	it("rejects an unsupported continuation finish reason while retaining partial output", async () => {
		sdk.chunks = [{ candidates: [{ content: { parts: [{ text: "partial answer" }] }, finishReason: "CONTINUATION" }] }];
		const result = await google.stream(model, context, { apiKey: "test" }).result();
		expect(result).toMatchObject({
			stopReason: "error",
			rawStopReason: "CONTINUATION",
			content: [{ type: "text", text: "partial answer" }],
			errorMessage: "Unhandled stop reason: CONTINUATION",
		});
		expect(mapStopReasonString("CONTINUATION")).toBe("error");
	});
	it("uses ordinary property assignment for legacy schemas without changing JSON-schema declarations", () => {
		const parameters = Type.Object(
			Object.fromEntries([
				["__proto__", Type.String()],
				["normal", Type.Number()],
			]),
		);
		const tool = { name: "inspect", description: "Inspect input", parameters };
		const legacy = convertTools([tool], true)?.[0]?.functionDeclarations[0]?.parameters;
		expect(JSON.parse(JSON.stringify(legacy))).toEqual({
			type: "object",
			properties: { normal: { type: "number" } },
			required: ["__proto__", "normal"],
		});
		expect(Object.hasOwn(parameters.properties, "__proto__")).toBe(true);
		expect(convertTools([tool])?.[0]?.functionDeclarations[0]?.parametersJsonSchema).toEqual(parameters);
	});
	it("streams signed thinking and text through the lazy adapter with billed usage", async () => {
		const events: string[] = [],
			raw: unknown[] = [];
		const stream = googleGenerativeAIApi().stream(model, context, {
			apiKey: "test",
			onProviderStreamEvent: async (chunk) => {
				raw.push(chunk);
			},
		});
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "plan more", thinkingSignature: "c2ln" },
			{ type: "text", text: "answer", textSignature: "dGV4dA==" },
		]);
		expect(events).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(result.responseId).toBe("first");
		expect(result.usage).toMatchObject({
			input: 80,
			output: 35,
			cacheRead: 20,
			cacheWrite: 0,
			reasoning: 5,
			totalTokens: 135,
			cost: { cacheWrite: 0 },
		});
		expect(result.usage.cost.input).toBeCloseTo(0.00016, 12);
		expect(result.usage.cost.output).toBeCloseTo(0.00028, 12);
		expect(result.usage.cost.cacheRead).toBeCloseTo(0.00001, 12);
		expect(result.usage.cost.total).toBeCloseTo(0.00045, 12);
		expect(raw).toEqual(sdk.chunks);
		expect(raw[0]).toBe(sdk.chunks[0]);
		expect(sdk.clients[0]).toMatchObject({
			httpOptions: { baseUrl: model.baseUrl, apiVersion: "", headers: { "User-Agent": formatUserAgent() } },
		});
	});
	it("keeps tool signatures, repairs duplicate IDs and emits complete arguments once", async () => {
		sdk.chunks = [
			{
				candidates: [
					{
						content: {
							parts: [
								{ functionCall: { id: "same", name: "read", args: { path: "one" } }, thoughtSignature: "c2ln" },
								{ functionCall: { id: "same", name: "read", args: { path: "two" } } },
							],
						},
						finishReason: "STOP",
					},
				],
			},
		];
		const stream = google.stream(model, context, { apiKey: "test" }),
			deltas: string[] = [];
		for await (const event of stream) if (event.type === "toolcall_delta") deltas.push(event.delta);
		const result = await stream.result();
		expect(result.stopReason).toBe("toolUse");
		expect(deltas).toEqual(['{"path":"one"}', '{"path":"two"}']);
		expect(result.content[0]).toEqual({
			type: "toolCall",
			id: "same",
			name: "read",
			arguments: { path: "one" },
			thoughtSignature: "c2ln",
		});
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			id: expect.stringMatching(/^read_\d+_\d+$/),
			arguments: { path: "two" },
		});
	});
	it.each(["google", "vertex"])("retains partial content and raw safety failures on %s", async (adapter) => {
		sdk.chunks = [{ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" }] }];
		const stream =
			adapter === "google"
				? google.stream(model, context, { apiKey: "test" })
				: vertex.stream(vertexModel, context, { apiKey: "test" });
		const result = await stream.result();
		expect(result).toMatchObject({
			stopReason: "error",
			rawStopReason: "SAFETY",
			errorMessage: "Provider stopped with: SAFETY",
			content: [{ type: "text", text: "partial" }],
		});
	});
	it("rejects early EOF and propagates observer failures", async () => {
		sdk.chunks = [{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }];
		expect(await google.stream(model, context, { apiKey: "test" }).result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Google stream ended without a finish reason",
			content: [{ type: "text", text: "partial" }],
		});
		expect(
			await google
				.stream(model, context, {
					apiKey: "test",
					onProviderStreamEvent: () => {
						throw new Error("observer failed");
					},
				})
				.result(),
		).toMatchObject({ stopReason: "error", errorMessage: "observer failed", content: [] });
	});
	it("honors payload replacement and distinguishes Flash Lite budgets", async () => {
		await google
			.streamSimple({ ...model, id: "gemini-2.5-flash-lite" }, context, {
				apiKey: "test",
				reasoning: "minimal",
				onPayload: (payload) => ({ ...(payload as object), custom: true }),
			})
			.result();
		await vertex
			.streamSimple({ ...vertexModel, id: "gemini-2.5-flash-lite" }, context, { apiKey: "test", reasoning: "minimal" })
			.result();
		expect(sdk.requests).toMatchObject([
			{ custom: true, config: { thinkingConfig: { includeThoughts: true, thinkingBudget: 512 } } },
			{ config: { thinkingConfig: { includeThoughts: true, thinkingBudget: 128 } } },
		]);
	});
	it("uses the Pro thinking budget for a custom route that also names Flash Lite", async () => {
		const result = await google
			.streamSimple({ ...model, id: "gemini-2.5-pro-2.5-flash-lite" }, context, {
				apiKey: "test",
				reasoning: "minimal",
			})
			.result();
		expect(result.stopReason).toBe("stop");
		expect(sdk.requests).toMatchObject([{ config: { thinkingConfig: { thinkingBudget: 128 } } }]);
	});
	it("uses scoped ADC credentials and omits generated endpoint placeholders", async () => {
		const result = await vertex
			.stream(vertexModel, context, {
				apiKey: "<authenticated>",
				env: {
					GOOGLE_CLOUD_PROJECT: "project",
					GOOGLE_CLOUD_LOCATION: "global",
					GOOGLE_APPLICATION_CREDENTIALS: "/test/key.json",
				},
			})
			.result();
		expect(result.stopReason).toBe("stop");
		expect(sdk.clients).toEqual([
			{
				vertexai: true,
				project: "project",
				location: "global",
				apiVersion: "v1",
				googleAuthOptions: { keyFilename: "/test/key.json" },
				httpOptions: { headers: { "User-Agent": formatUserAgent() } },
			},
		]);
	});
	it("uses Vertex API keys without ADC and avoids doubling versioned base paths", async () => {
		await vertex
			.stream({ ...vertexModel, baseUrl: "https://proxy.invalid/v1/projects/project/locations/global" }, context, {
				apiKey: " test ",
				headers: { "User-Agent": "custom", "x-test": "value" },
			})
			.result();
		expect(sdk.clients[0]).toEqual({
			vertexai: true,
			apiKey: "test",
			apiVersion: "v1",
			httpOptions: {
				baseUrl: "https://proxy.invalid/v1/projects/project/locations/global",
				baseUrlResourceScope: "COLLECTION",
				apiVersion: "",
				headers: { "User-Agent": "custom", "x-test": "value" },
			},
		});
	});
	it("rejects unsupported fetch overrides and missing keys before requests", async () => {
		expect(() => google.streamSimple(model, context)).toThrow("No API key for provider: google");
		expect(
			await google.stream(model, context, { apiKey: "test", fetch: async () => new Response() }).result(),
		).toMatchObject({
			stopReason: "error",
			errorMessage: "Custom fetch is not supported by the Google Generative AI adapter",
		});
		expect(await vertex.stream(vertexModel, context, { fetch: async () => new Response() }).result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Custom fetch is not supported by the Google Vertex adapter",
		});
		expect(sdk.clients).toEqual([]);
	});
	it("keeps signed empty replay parts and nests image tool results", async () => {
		const prior: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: 1,
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "c2ln" },
				{ type: "toolCall", id: "a:b", name: "read", arguments: {} },
			],
		};
		expect(
			convertMessages(
				model,
				normalizeContext({
					messages: [
						prior,
						{
							role: "toolResult",
							toolCallId: "a:b",
							toolName: "read",
							isError: false,
							timestamp: 2,
							content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
						},
					],
				}),
			),
		).toEqual([
			{
				role: "model",
				parts: [
					{ text: "", thought: true, thoughtSignature: "c2ln" },
					{ functionCall: { id: "a:b", name: "read", args: {} } },
				],
			},
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							id: "a:b",
							name: "read",
							response: { output: "(see attached image)" },
							parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }],
						},
					},
				],
			},
		]);
	});
	it("retries SDK throttling only when explicitly enabled", async () => {
		vi.useFakeTimers();
		sdk.request
			.mockRejectedValueOnce(Object.assign(new Error("throttled"), { status: 429 }))
			.mockResolvedValue(undefined);
		const result = google.stream(model, context, { apiKey: "test", maxRetries: 1 }).result();
		await vi.advanceTimersByTimeAsync(500);
		expect((await result).stopReason).toBe("stop");
		expect(sdk.requests).toHaveLength(2);
	});
});

it("adapts schema constants without rewriting literal objects or property names", () => {
	const literal = { const: "keep", properties: { item: { const: 9 } } };
	const parameters = {
		type: "object",
		properties: {
			tag: { const: "ready" },
			count: { const: 5 },
			flag: { const: false },
			choice: { const: "ready", enum: ["ready", "waiting"] },
			data: { type: "object", default: literal, examples: [literal], "x-info": literal },
			["__proto__"]: { const: "own" },
			const: { const: "named" },
		},
		allOf: [{ properties: { tag: { const: "ready" } } }],
	};
	const before = structuredClone(parameters);
	const declarations = convertTools([{ name: "inspect", description: "Inspect", parameters }]);
	expect(declarations?.[0]?.functionDeclarations[0]?.parametersJsonSchema).toEqual({
		type: "object",
		properties: {
			tag: { enum: ["ready"] },
			count: { enum: [5] },
			flag: { const: false },
			choice: { const: "ready", enum: ["ready", "waiting"] },
			data: { type: "object", default: literal, examples: [literal], "x-info": literal },
			["__proto__"]: { enum: ["own"] },
			const: { enum: ["named"] },
		},
		allOf: [{ properties: { tag: { enum: ["ready"] } } }],
	});
	expect(parameters).toEqual(before);
});
