import { getEventListeners } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import {
	codexAccount,
	codexEvents,
	codexHttpError,
	codexRetryable,
	codexRetryDelay,
	codexSSE,
	codexTimeout,
	codexUrl,
	parseCodexFrame,
	RetryDelayExceededError,
} from "../src/api/openai-codex-protocol.ts";
import type { AssistantMessage, Model } from "../src/types.ts";

afterEach(() => vi.restoreAllMocks());

const model: Model<"openai-codex-responses"> = {
	id: "protocol-fixture",
	name: "Protocol fixture",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://provider.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function output(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
async function* events(...values: Record<string, unknown>[]) {
	yield* values;
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of source) values.push(value);
	return values;
}

test("SSE reads fragmented UTF-8, multiline frames and a final frame without a separator", async () => {
	const bytes = new TextEncoder().encode(
		': keepalive\n\ndata: {"type":\ndata: "message", "text":"界🙂"}\n\ndata: [DONE]\n\ndata: {"type":"tail"}',
	);
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset === bytes.length) controller.close();
			else controller.enqueue(bytes.slice(offset, ++offset));
		},
	});
	expect(await collect(codexSSE(new Response(body)))).toEqual([{ type: "message", text: "界🙂" }, { type: "tail" }]);
	expect(body.locked).toBe(false);
	expect(await collect(codexSSE(new Response(null)))).toEqual([]);
});

test.each(["SSE", "WebSocket"] as const)("malformed %s JSON retains the bad frame and parsing cause", (transport) => {
	try {
		parseCodexFrame('{"type":', transport);
		throw new Error("The malformed frame was accepted");
	} catch (error) {
		expect(error).toMatchObject({ name: "CodexProtocolError", payload: '{"type":', cause: expect.any(SyntaxError) });
	}
});

test.each(["before-read", "pending-read"] as const)(
	"SSE cancellation releases the body and abort listener: %s",
	async (when) => {
		const controller = new AbortController();
		let cancelled = 0;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled++;
			},
		});
		if (when === "before-read") controller.abort();
		const read = codexSSE(new Response(body), controller.signal).next();
		const rejected = expect(read).rejects.toThrow("Request was aborted");
		if (when === "pending-read") controller.abort();
		await rejected;
		expect({ cancelled, locked: body.locked, listeners: getEventListeners(controller.signal, "abort").length }).toEqual(
			{
				cancelled: 1,
				locked: false,
				listeners: 0,
			},
		);
	},
);

test("stopping SSE consumption cancels its unfinished body", async () => {
	let cancelled = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('data: {"type":"first"}\n\n'));
		},
		cancel() {
			cancelled++;
		},
	});
	for await (const event of codexSSE(new Response(body))) {
		expect(event).toEqual({ type: "first" });
		break;
	}
	expect({ cancelled, locked: body.locked }).toEqual({ cancelled: 1, locked: false });
});

test.each(["response.done", "response.completed", "response.incomplete"])(
	"terminal alias %s ends consumption and normalizes unknown status",
	async (type) => {
		const message = output();
		const observed: unknown[] = [];
		const result = await collect(
			codexEvents(
				events(
					{ ignored: true },
					{ type, response: { id: "answer", status: "not-a-status", end_turn: false } },
					{ type: "after-completion" },
				),
				message,
				model,
				(event) => {
					observed.push(event);
				},
			),
		);
		expect(result).toEqual([
			{ type: "response.completed", response: { id: "answer", status: undefined, end_turn: false } },
		]);
		expect(message.endTurn).toBe(false);
		expect(observed).toHaveLength(2);
	},
);

test.each([
	{ event: { type: "error", code: "busy" }, message: "Codex error: busy", code: "busy" },
	{
		event: { type: "error", error: { code: "denied", message: "Access denied" } },
		message: "Codex error: Access denied",
		code: "denied",
	},
	{ event: { type: "error" }, message: 'Codex error: {"type":"error"}', code: undefined },
	{
		event: { type: "response.failed", response: { error: { code: "failed", message: "Generation failed" } } },
		message: "Generation failed",
		code: "failed",
	},
	{ event: { type: "response.failed" }, message: "Codex response failed", code: undefined },
])("provider failure is preserved: $message", async ({ event, message, code }) => {
	await expect(collect(codexEvents(events(event), output(), model, undefined))).rejects.toMatchObject({
		name: "CodexApiError",
		message,
		code,
		payload: event,
	});
});

test("raw event callback failures retain their cause", async () => {
	const cause = { reason: "Cannot record event" };
	await expect(
		collect(
			codexEvents(events({ type: "response.created" }), output(), model, () => {
				throw cause;
			}),
		),
	).rejects.toMatchObject({ name: "ProviderStreamEventCallbackError", cause });
});

test("account extraction rejects malformed tokens and missing claims", () => {
	for (const token of [
		"",
		"one.two",
		"one.two.three.four",
		"a.!broken.b",
		...[null, 1, [], {}, { "https://api.openai.com/auth": {} }].map((value) => `a.${btoa(JSON.stringify(value))}.b`),
	]) {
		expect(() => codexAccount(token)).toThrow("Failed to extract accountId");
	}
	expect(
		codexAccount(`a.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.b`),
	).toBe("account");
});

test("Codex base paths normalize once and invalid deadlines fail before dispatch", () => {
	for (const base of [
		"https://provider.invalid",
		"https://provider.invalid/codex/",
		"https://provider.invalid/codex/responses///",
	]) {
		expect(codexUrl(base)).toBe("https://provider.invalid/codex/responses");
	}
	expect(codexUrl("  ")).toBe("https://chatgpt.com/backend-api/codex/responses");
	expect(codexTimeout(undefined)).toBeUndefined();
	expect(codexTimeout(0)).toBe(0);
	expect(codexTimeout(12.9)).toBe(12);
	for (const invalid of [-1, NaN, Infinity, -Infinity])
		expect(() => codexTimeout(invalid)).toThrow("Invalid timeoutMs");
});

test("retry delays honor valid units, dates and the caller's cap", () => {
	const now = Date.parse("2031-04-05T12:00:00Z");
	vi.spyOn(Date, "now").mockReturnValue(now);
	for (const [headers, expected] of [
		[{}, 4000],
		[{ "retry-after-ms": "invalid", "retry-after": "0.125" }, 125],
		[{ "retry-after-ms": "-5" }, 0],
		[{ "retry-after": "-1" }, 0],
		[{ "retry-after": "invalid" }, 4000],
		[{ "retry-after-ms": "18", "retry-after": "20" }, 18],
	] satisfies [Record<string, string>, number][])
		expect(codexRetryDelay(new Headers(headers), {}, 2)).toBe(expected);
	const date = new Date(now + 10000).toUTCString();
	expect(codexRetryDelay(new Headers({ "retry-after": date }), {}, 0)).toBe(10000);
	expect(codexRetryDelay(new Headers({ "retry-after": new Date(0).toUTCString() }), {}, 0)).toBe(0);
	expect(() => codexRetryDelay(new Headers({ "retry-after-ms": "100" }), { maxRetryDelayMs: 99 }, 0)).toThrow(
		RetryDelayExceededError,
	);
	expect(codexRetryDelay(new Headers({ "retry-after-ms": "100000" }), { maxRetryDelayMs: 0 }, 0)).toBe(100000);
});

test("retry classification distinguishes exhausted quota from transient server faults", () => {
	for (const text of [
		"insufficient_quota",
		"Monthly usage limit reached",
		"GoUsageLimitError",
		"billing",
		"out of budget",
	]) {
		expect(codexRetryable(429, text)).toBe(false);
	}
	for (const status of [429, 500, 502, 503, 504]) expect(codexRetryable(status, "busy")).toBe(true);
	for (const text of ["Rate limit", "overloaded", "service unavailable", "upstream connect", "connection refused"]) {
		expect(codexRetryable(400, text)).toBe(true);
	}
	expect(codexRetryable(401, "Invalid token")).toBe(false);
});

test("HTTP errors retain raw diagnostics and explain usage-limit responses", () => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2031-04-05T12:00:00Z"));
	const response = new Response(null, { status: 400, statusText: "Bad Request" });
	for (const [body, message] of [
		["not JSON", "not JSON"],
		["", "Bad Request"],
		['{"error":{"message":"Bad input"}}', "Bad input"],
		["[]", "[]"],
	] satisfies [string, string][]) {
		expect(codexHttpError(body, response).message).toBe(message);
	}
	const limited = codexHttpError(
		JSON.stringify({ error: { code: "usage_limit_reached", plan_type: "PLUS", resets_at: Date.now() / 1000 + 120 } }),
		response,
	);
	expect(limited.message).toBe("You have hit your ChatGPT usage limit (plus plan). Try again in ~2 min.");
	expect(codexHttpError('{"error":{}}', new Response(null, { status: 429 })).message).toBe(
		"You have hit your ChatGPT usage limit.",
	);
});
