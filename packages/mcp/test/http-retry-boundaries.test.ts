import { afterEach, expect, test, vi } from "vitest";
import { StreamableHttpTransport } from "../src/transports/streamable-http.ts";
import type { McpFetch } from "../src/auth-provider.ts";

afterEach(() => vi.useRealTimers());
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" } as const;
const request = { jsonrpc: "2.0", id: 1, method: "ping" } as const;

test("discarding an accepted notification body contains cancellation failure and preserves later requests", async () => {
	let cancellations = 0;
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		fetch: async (_url, init) => {
			const message = JSON.parse(String(init?.body));
			if ("id" in message) return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
			return new Response(
				new ReadableStream({
					cancel() {
						cancellations++;
						throw new Error("peer already disconnected");
					},
				}),
				{ status: 202 },
			);
		},
	});
	const messages: unknown[] = [],
		errors: Error[] = [];
	transport.onMessage((message) => messages.push(message));
	transport.onError((error) => errors.push(error));
	try {
		await transport.start();
		await transport.send({ jsonrpc: "2.0", method: "notice" });
		await transport.send(request);
		expect(cancellations).toBe(1);
		expect(errors).toEqual([]);
		expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
	} finally {
		await transport.close();
	}
});

test.each([
	{ status: 408, retry: true },
	{ status: 429, retry: true },
	{ status: 503, retry: true },
	{ status: 400, retry: false },
	{ error: new TypeError("Network unavailable"), retry: true },
	{ error: Object.assign(new Error("Reset"), { code: "ECONNRESET" }), retry: true },
	{ error: Object.assign(new Error("Socket"), { code: "UND_ERR_SOCKET" }), retry: true },
	{ error: new Error("Permanent failure"), retry: false },
])("notification reconnect classifies $status $error and retries only recoverable failures", async (scenario) => {
	let gets = 0;
	const errors: Error[] = [];
	const fetch: McpFetch = async (_url, init) => {
		if (init?.method !== "GET") return new Response(null, { status: 202 });
		if (++gets > 1) return new Response(null, { status: 405 });
		if ("error" in scenario) throw scenario.error;
		return new Response(null, { status: scenario.status });
	};
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		fetch,
		reconnect: { initialDelayMs: 1, maxDelayMs: 2, maxRetries: 1 },
	});
	transport.onError((error) => errors.push(error));
	try {
		await transport.start();
		await transport.send(initialized);
		await vi.waitFor(() => expect(scenario.retry ? gets : errors.length).toBe(scenario.retry ? 2 : 1));
		expect(gets).toBe(scenario.retry ? 2 : 1);
		expect(errors).toHaveLength(scenario.retry ? 0 : 1);
	} finally {
		await transport.close();
	}
});

test("retry exhaustion reports one failure after the configured number of GET attempts", async () => {
	let gets = 0;
	const errors: Error[] = [];
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		reconnect: { initialDelayMs: 1, maxDelayMs: 1, maxRetries: 2 },
		fetch: async (_url, init) => {
			if (init?.method !== "GET") return new Response(null, { status: 202 });
			gets++;
			return new Response(null, { status: 503 });
		},
	});
	transport.onError((error) => errors.push(error));
	try {
		await transport.start();
		await transport.send(initialized);
		await vi.waitFor(() => expect(errors).toHaveLength(1));
		expect(gets).toBe(3);
		expect(errors[0]?.message).toContain("could not be reopened");
	} finally {
		await transport.close();
	}
});

test("closing during reconnect cancels the delay and makes no further HTTP request", async () => {
	vi.useFakeTimers();
	let gets = 0;
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		fetch: async (_url, init) => {
			if (init?.method !== "GET") return new Response(null, { status: 202 });
			gets++;
			throw new TypeError("Disconnected");
		},
	});
	try {
		await transport.start();
		await transport.send(initialized);
		await vi.advanceTimersByTimeAsync(0);
		expect(gets).toBe(1);
		await transport.close();
		await vi.advanceTimersByTimeAsync(60000);
		expect(gets).toBe(1);
	} finally {
		await transport.close();
	}
});

test("unreadable HTTP error bodies still expose their status", async () => {
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("Body disconnected"));
					},
				}),
				{ status: 502 },
			),
	});
	try {
		await transport.start();
		await expect(transport.send(request)).rejects.toMatchObject({
			status: 502,
			message: "MCP HTTP request failed with status 502",
		});
	} finally {
		await transport.close();
	}
});

test("empty JSON response bodies fail parsing and oversized bodies are cancelled before parsing", async () => {
	for (const empty of [true, false]) {
		let cancelled = false;
		const body = empty
			? null
			: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(Buffer.from('{"value":"too big"}'));
					},
					cancel() {
						cancelled = true;
						throw new Error("Already disconnected");
					},
				});
		const transport = new StreamableHttpTransport({
			url: "https://peer.invalid/mcp",
			maxMessageBytes: 4,
			fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
		});
		try {
			await transport.start();
			await expect(transport.send(request)).rejects.toThrow(empty ? "Unexpected end of JSON input" : "exceeds 4 bytes");
			expect(cancelled).toBe(!empty);
		} finally {
			await transport.close();
		}
	}
});

test("HTTP transport lifecycle prevents sends before start, double start and reuse after close", async () => {
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		fetch: async () => {
			throw new Error("No network request expected");
		},
	});
	expect(transport.sessionId).toBeUndefined();
	await expect(transport.send(request)).rejects.toThrow(/closed/i);
	await transport.start();
	await expect(transport.start()).rejects.toThrow("already started");
	await transport.close();
	await transport.close();
	await expect(transport.send(request)).rejects.toThrow(/closed/i);
	const closed = new StreamableHttpTransport({ url: "https://peer.invalid/mcp" });
	await closed.close();
	await expect(closed.start()).rejects.toThrow(/closed/i);
});
