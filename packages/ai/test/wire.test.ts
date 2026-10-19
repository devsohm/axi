import { describe, expect, it } from "vitest";
import { axiMessagesApi } from "../src/api/axi-messages.lazy.ts";
import { type AxiMessagesEvent, type AxiMessagesOptions, stream, streamSimple } from "../src/api/axi-messages.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"axi-messages"> = {
	id: "test",
	name: "Test",
	api: "axi-messages",
	provider: "remote",
	baseUrl: "https://provider.invalid/v1/",
	reasoning: true,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 5000,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};
function response(events: AxiMessagesEvent[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), {
		headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
	});
}

describe("Remote message protocol", () => {
	it("keeps the selected credential when the payload callback changes options", async () => {
		let authorization: string | null = null;
		const options: AxiMessagesOptions = {
			apiKey: "selected-key",
			onPayload() {
				options.apiKey = "later-key";
			},
			fetch: async (_url, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return response([{ type: "done", reason: "stop", usage }]);
			},
		};
		const result = await stream(model, context, options).result();
		expect(result.stopReason).toBe("stop");
		expect(authorization).toBe("Bearer selected-key");
	});
	it("converts signatures and arguments while preserving terminal usage and rewrite details", async () => {
		const raw: AxiMessagesEvent[] = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "consider" },
			{ type: "thinking_end", contentIndex: 0, content: "consider", contentSignature: "signed", redacted: false },
			{ type: "toolcall_start", contentIndex: 1, id: "a", toolName: "read" },
			{ type: "toolcall_delta", contentIndex: 1, delta: '{"path":' },
			{ type: "toolcall_delta", contentIndex: 1, delta: '"a"}' },
			{
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
			},
			{
				type: "done",
				reason: "toolUse",
				usage,
				responseId: "response-1",
				providerThinkingLevel: "high",
				rewrite: {
					policyId: "rule",
					policyVersion: 1,
					changed: true,
					tokenCountChange: -1,
					messageCountChange: 0,
					systemPromptChanged: false,
				},
			},
		];
		const observed: unknown[] = [];
		const result = await stream(model, context, {
			apiKey: "test",
			fetch: async () => response(raw),
			onProviderStreamEvent: (event) => {
				observed.push(event);
			},
		}).result();
		expect(observed).toEqual(raw);
		expect(result).toMatchObject({
			stopReason: "toolUse",
			responseId: "response-1",
			providerThinkingLevel: "high",
			usage,
			content: [
				{ type: "thinking", thinking: "consider", thinkingSignature: "signed", redacted: false },
				{ type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
			],
			diagnostics: [{ type: "axi_messages_rewrite", details: { policyId: "rule", changed: true } }],
		});
	});
	it("runs through Models and the lazy adapter, with backend-owned defaults left unset", async () => {
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "remote",
				models: [model],
				api: axiMessagesApi(),
				auth: { apiKey: envApiKeyAuth("Remote key", []) },
			}),
		);
		let body = "",
			url = "";
		const result = await models.completeSimple(
			model,
			{ messages: context.messages },
			{
				apiKey: "test",
				env: {},
				sessionId: "session-1",
				fetch: async (input, init) => {
					body = String(init?.body);
					url = String(input);
					return response([
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_end", contentIndex: 0, content: "answer", contentSignature: "signed" },
						{ type: "done", reason: "stop", usage },
					]);
				},
			},
		);
		expect(result.content).toEqual([{ type: "text", text: "answer", textSignature: "signed" }]);
		expect(url).toBe("https://provider.invalid/v1/messages");
		expect(JSON.parse(body)).toEqual({ model: "test", context, options: { sessionId: "session-1" } });
	});
	it("retains structured HTTP diagnostics and bounds plain diagnostic bodies", async () => {
		const structured = await stream(model, context, {
			apiKey: "test",
			fetch: async () =>
				Response.json({ error: { message: "denied", code: "blocked", details: { policy: "one" } } }, { status: 403 }),
		}).result();
		expect(structured).toMatchObject({
			stopReason: "error",
			errorMessage: "403 : denied (blocked)",
			diagnostics: [
				{
					type: "axi_messages_response_failure",
					details: { status: 403, error: { code: "blocked", details: { policy: "one" } } },
				},
			],
		});
		const plain = await stream(model, context, {
			apiKey: "test",
			fetch: async () => new Response("x".repeat(9000), { status: 500 }),
		}).result();
		expect(plain.stopReason).toBe("error");
		expect(plain.diagnostics?.[0].details?.body).toBe("x".repeat(8192) + "…");
	});
	it("preserves a backend error's partial content and billed usage", async () => {
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch: async () =>
				response([
					{ type: "text_start", contentIndex: 0 },
					{ type: "text_delta", contentIndex: 0, delta: "partial" },
					{ type: "error", reason: "error", errorMessage: "backend failed", usage },
				]),
		}).result();
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "backend failed",
			content: [{ type: "text", text: "partial" }],
			usage,
		});
	});
	it("returns errors on early EOF and caller cancellation", async () => {
		const ended = await stream(model, context, {
			apiKey: "test",
			fetch: async () => response([{ type: "start" }]),
		}).result();
		expect(ended).toMatchObject({ stopReason: "error", errorMessage: "remote stream ended without a terminal event" });
		const controller = new AbortController();
		controller.abort();
		const aborted = await stream(model, context, {
			apiKey: "test",
			signal: controller.signal,
			fetch: async (_url, init) => {
				init?.signal?.throwIfAborted();
				return response([]);
			},
		}).result();
		expect(aborted).toMatchObject({ stopReason: "aborted", errorMessage: expect.stringMatching(/abort/i) });
	});
});
