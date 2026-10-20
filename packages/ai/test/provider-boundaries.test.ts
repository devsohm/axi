import { afterEach, expect, test, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import {
	formatProviderError,
	normalizeProviderError,
	safeJsonStringify,
	truncateErrorText,
} from "../src/utils/error-body.ts";
import { parseStreamingJson, parseToolCallArguments, parseJsonWithRepair } from "../src/utils/json-parse.ts";

afterEach(() => vi.useRealTimers());

function failure(status: number | undefined, headers: Record<string, string> = {}) {
	return Object.assign(new Error("provider unavailable"), { status, headers: new Headers(headers) });
}

test("retry uses server delays before returning the later successful response", async () => {
	vi.useFakeTimers();
	const times: number[] = [];
	const start = Date.now();
	const response = retryProviderRequest(
		async () => {
			times.push(Date.now() - start);
			if (times.length === 1) throw failure(429, { "retry-after-ms": "25" });
			if (times.length === 2) throw failure(503, { "retry-after": "0.05" });
			return "ready";
		},
		{ maxRetries: 2 },
	);
	await vi.runAllTimersAsync();
	expect(await response).toBe("ready");
	expect(times).toEqual([0, 25, 75]);
});

test("HTTP-date delays and fallback backoff preserve the retry budget", async () => {
	vi.useFakeTimers();
	vi.setSystemTime("2026-01-01T00:00:00Z");
	const random = vi.spyOn(Math, "random").mockReturnValue(0);
	const start = Date.now(),
		times: number[] = [];
	try {
		const result = retryProviderRequest(
			async () => {
				times.push(Date.now() - start);
				if (times.length === 1) throw failure(408, { "retry-after": "Thu, 01 Jan 2026 00:00:01 GMT" });
				if (times.length === 2) throw failure(undefined, { "retry-after-ms": "bad", "retry-after": "bad" });
				return 42;
			},
			{ maxRetries: 2 },
		);
		await vi.runAllTimersAsync();
		expect(await result).toBe(42);
		expect(times).toEqual([0, 1000, 2000]);
	} finally {
		random.mockRestore();
	}
});

test("non-retryable failures retain their identity and make only one request", async () => {
	for (const [error, options] of [
		[failure(401), {}],
		[failure(503, { "x-should-retry": "false" }), {}],
		[failure(429), { noRetryStatuses: [429] }],
		[new TypeError("local validation"), {}],
		[failure(500), { maxRetries: 0 }],
	] satisfies [Error, Parameters<typeof retryProviderRequest>[1]][]) {
		let attempts = 0;
		await expect(
			retryProviderRequest(
				async () => {
					attempts++;
					throw error;
				},
				{ maxRetries: 3, ...options },
			),
		).rejects.toBe(error);
		expect(attempts).toBe(1);
	}
	let attempts = 0;
	expect(
		await retryProviderRequest(
			async () => {
				if (++attempts === 1) throw failure(400, { "x-should-retry": "true", "retry-after-ms": "-1" });
				return "forced retry";
			},
			{ maxRetries: 1 },
		),
	).toBe("forced retry");
	expect(attempts).toBe(2);
});

test("excessive delays fail promptly, and cancellation interrupts backoff", async () => {
	await expect(
		retryProviderRequest(
			async () => {
				throw failure(429, { "retry-after": "120" });
			},
			{ maxRetries: 1, maxRetryDelayMs: 1000 },
		),
	).rejects.toThrow("Server requested 120s retry delay (max: 1s)");
	const controller = new AbortController();
	let attempts = 0;
	const result = retryProviderRequest(
		async () => {
			attempts++;
			queueMicrotask(() => controller.abort());
			throw failure(503, { "retry-after": "30" });
		},
		{ maxRetries: 2, signal: controller.signal },
	);
	await expect(result).rejects.toMatchObject({ name: "AbortError", message: "Request aborted" });
	expect(attempts).toBe(1);
});

test("normalization reads each provider error envelope without consuming stream bodies", () => {
	for (const fields of [
		{ statusCode: 502, body: " upstream down " },
		{ status: 502, error: { message: "upstream down" } },
		{ $metadata: { httpStatusCode: 502 }, $response: { body: " upstream down " } },
		{ $response: { statusCode: 502, body: { message: "upstream down" } } },
	]) {
		const result = normalizeProviderError(Object.assign(new Error("request failed"), fields));
		expect(result).toMatchObject({ status: 502, message: "request failed", messageCarriesBody: false });
		expect(formatProviderError(result, "Gateway")).toBe(
			`Gateway (502): ${"error" in fields || typeof fields.$response?.body === "object" ? '{"message":"upstream down"}' : "upstream down"}`,
		);
	}
	expect(
		normalizeProviderError(
			Object.assign(new Error("failed"), {
				$response: {
					body: {
						pipe() {
							throw new Error("must not consume");
						},
					},
				},
			}),
		),
	).toEqual({ status: undefined, body: undefined, message: "failed", messageCarriesBody: true });
	expect(
		formatProviderError(
			normalizeProviderError(Object.assign(new Error("upstream down"), { status: 502, body: "upstream down" })),
		),
	).toBe("upstream down");
	expect(formatProviderError(normalizeProviderError(new Error("no status")), "Provider")).toBe("no status");
	expect(normalizeProviderError({ reason: "bad" })).toEqual({ message: '{"reason":"bad"}', messageCarriesBody: false });
	expect(truncateErrorText("abcdef", 3)).toBe("abc... [truncated 3 chars]");
	expect(truncateErrorText("abc", 3)).toBe("abc");
	const cyclic: { self?: unknown } = {};
	cyclic.self = cyclic;
	expect(safeJsonStringify(cyclic)).toBe("[object Object]");
	expect(safeJsonStringify(undefined)).toBe("undefined");
});

test("tool arguments repair invalid string escapes and controls while rejecting non-object values", () => {
	expect(parseJsonWithRepair('{"path":"C:\\work\\queue","text":"a\nb\tc\r\b\f\u0001"}')).toEqual({
		path: "C:\\work\\queue",
		text: "a\nb\tc\r\b\f\u0001",
	});
	expect(parseJsonWithRepair('{"value":"\\u0041\\\\\\\"\\/"}')).toEqual({ value: 'A\\"/' });
	expect(parseToolCallArguments('{"path":"ok"}')).toEqual({ arguments: { path: "ok" } });
	for (const source of ["null", "[]", "42", '"text"']) {
		expect(parseToolCallArguments(source)).toEqual({
			arguments: {},
			argumentsError: `Tool arguments must be a JSON object\n\nReceived arguments:\n${source}`,
		});
	}
	expect(parseToolCallArguments("  ")).toEqual({ arguments: {} });
	expect(() => parseJsonWithRepair("not JSON")).toThrow(SyntaxError);
});

test("streaming arguments expose complete fields before the last chunk and recover malformed prefixes", () => {
	expect(parseStreamingJson('{"path":"file","options":{"recursive":tr')).toEqual({
		path: "file",
		options: { recursive: true },
	});
	expect(parseStreamingJson('{"path":"C:\\\\queue')).toEqual({ path: "C:\\queue" });
	expect(parseStreamingJson('{"items":[1,2,')).toEqual({ items: [1, 2] });
	expect(parseStreamingJson("invalid")).toEqual({});
	expect(parseStreamingJson(undefined)).toEqual({});
	expect(parseStreamingJson('{"ready":true}')).toEqual({ ready: true });
});
