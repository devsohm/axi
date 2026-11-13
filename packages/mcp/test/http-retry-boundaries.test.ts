import { afterEach, expect, test, vi } from "vitest";
import { StreamableHttpTransport } from "../src/transports/streamable-http.ts";
import type { McpFetch } from "../src/auth-provider.ts";

afterEach(() => vi.useRealTimers());
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" } as const;
const request = { jsonrpc: "2.0", id: 1, method: "ping" } as const;

test.each([
	[200, undefined, false],
	[403, undefined, false],
	[403, 'Bearer error="access_denied"', false],
	[403, 'Bearer error="insufficient_scope"', true],
])("authorization recovery for HTTP %i %s retries only a scope challenge", async (status, challenge, recover) => {
	let requests = 0,
		recoveries = 0;
	const messages: unknown[] = [];
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		authProvider: {
			token: async () => "fixture-token",
			onUnauthorized: async () => {
				recoveries++;
			},
		},
		fetch: async () => {
			requests++;
			return status === 200 || requests > 1
				? Response.json({ jsonrpc: "2.0", id: 1, result: 42 })
				: new Response(null, { status, headers: challenge ? { "www-authenticate": challenge } : {} });
		},
	});
	transport.onMessage((message) => messages.push(message));
	try {
		await transport.start();
		if (status === 200 || recover) {
			await transport.send(request);
			expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: 42 }]);
		} else await expect(transport.send(request)).rejects.toMatchObject({ status: 403 });
		expect([requests, recoveries]).toEqual(recover ? [2, 1] : [1, 0]);
	} finally {
		await transport.close();
	}
});

test("a request requires a supported response body and a later request still works", async () => {
	for (const [status, type] of [[202], [204], [200, "text/plain"], [200]] as const) {
		let requests = 0,
			cancellations = 0;
		const messages: unknown[] = [];
		const transport = new StreamableHttpTransport({
			url: "https://peer.invalid/mcp",
			fetch: async () => {
				if (++requests > 1) return Response.json({ jsonrpc: "2.0", id: 1, result: 7 });
				return new Response(
					status === 200
						? new ReadableStream({
								cancel() {
									cancellations++;
								},
							})
						: null,
					{
						status,
						headers: type ? { "content-type": type } : {},
					},
				);
			},
		});
		transport.onMessage((message) => messages.push(message));
		try {
			await transport.start();
			await expect(transport.send(request)).rejects.toMatchObject({
				status,
				message: expect.stringContaining(
					status === 200 ? "Unsupported MCP response content type" : "without a response",
				),
			});
			expect(cancellations).toBe(status === 200 ? 1 : 0);
			await transport.send(request);
			expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: 7 }]);
		} finally {
			await transport.close();
		}
	}
});

test("unsupported notification stream types are cancelled once without disabling POST requests", async () => {
	for (const type of [undefined, "application/json"]) {
		let gets = 0,
			cancellations = 0;
		const errors: Error[] = [],
			messages: unknown[] = [];
		const transport = new StreamableHttpTransport({
			url: "https://peer.invalid/mcp",
			fetch: async (_url, init) => {
				if (init?.method !== "GET") {
					const message = JSON.parse(String(init?.body));
					return "id" in message
						? Response.json({ jsonrpc: "2.0", id: message.id, result: 7 })
						: new Response(null, { status: 202 });
				}
				gets++;
				return new Response(
					new ReadableStream({
						cancel() {
							cancellations++;
						},
					}),
					{
						headers: type === undefined ? {} : { "content-type": type },
					},
				);
			},
		});
		transport.onError((error) => errors.push(error));
		transport.onMessage((message) => messages.push(message));
		try {
			await transport.start();
			await transport.send(initialized);
			await vi.waitFor(() => expect(errors).toHaveLength(1));
			expect(errors[0]).toMatchObject({
				status: 200,
				message: `Unsupported MCP GET response content type: ${type ?? "missing"}`,
			});
			expect([gets, cancellations]).toEqual([1, 1]);
			await transport.send(request);
			expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: 7 }]);
		} finally {
			await transport.close();
		}
	}
});

test("a malformed SSE message is reported while a later valid notification is delivered", async () => {
	const message = { jsonrpc: "2.0", method: "server.ready", params: { ready: true } };
	const errors: Error[] = [],
		messages: unknown[] = [];
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		fetch: async (_url, init) =>
			init?.method === "GET"
				? new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(`event: heartbeat\ndata: {ignored\n\ndata:   \n\ndata: {broken\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`));
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					)
				: new Response(null, { status: 202 }),
	});
	transport.onError((error) => errors.push(error));
	transport.onMessage((message) => messages.push(message));
	try {
		await transport.start();
		await transport.send(initialized);
		await vi.waitFor(() => expect(messages).toEqual([message]));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(SyntaxError);
	} finally {
		await transport.close();
	}
});

test("HTTP requests retain their configured headers and deliver every message in a JSON batch in order", async () => {
	const headers = { "x-project": "first" };
	const replies = [
		{ jsonrpc: "2.0", method: "server.ready" },
		{ jsonrpc: "2.0", id: 1, result: 42 },
	];
	const messages: unknown[] = [];
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		headers,
		fetch: async (_url, init) => {
			expect(new Headers(init?.headers).get("x-project")).toBe("first");
			return Response.json(replies);
		},
	});
	headers["x-project"] = "later";
	transport.onMessage((message) => messages.push(message));
	try {
		await transport.start();
		await transport.send(request);
		expect(messages).toEqual(replies);
	} finally {
		await transport.close();
	}
});

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

test("an idle notification stream that stayed healthy resets the reconnect budget", async () => {
	vi.useFakeTimers();
	let gets = 0;
	const errors: Error[] = [];
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		reconnect: { initialDelayMs: 1, maxDelayMs: 5, maxRetries: 1 },
		fetch: async (_url, init) => {
			if (init?.method !== "GET") return new Response(null, { status: 202 });
			gets++;
			if (gets === 1) throw new TypeError("Disconnected");
			if (gets === 3) return new Response(null, { status: 405 });
			return new Response(
				new ReadableStream({
					start(controller) {
						setTimeout(() => controller.close(), 6);
					},
				}),
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	transport.onError((error) => errors.push(error));
	try {
		await transport.start();
		await transport.send(initialized);
		await vi.advanceTimersByTimeAsync(1);
		expect(gets).toBe(2);
		await vi.advanceTimersByTimeAsync(7);
		expect(gets).toBe(3);
		expect(errors).toEqual([]);
	} finally {
		await transport.close();
	}
});

test("closing from a notification callback prevents a reconnect after that stream ends", async () => {
	vi.useFakeTimers();
	let gets = 0;
	const transport = new StreamableHttpTransport({
		url: "https://peer.invalid/mcp",
		fetch: async (_url, init) => {
			if (init?.method !== "GET") return new Response(null, { status: 202 });
			gets++;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(Buffer.from('data: {"jsonrpc":"2.0","method":"ready"}\n\n'));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const messages: unknown[] = [];
	transport.onMessage((message) => {
		messages.push(message);
		void transport.close();
	});
	try {
		await transport.start();
		await transport.send(initialized);
		await vi.advanceTimersByTimeAsync(60000);
		expect(messages).toEqual([{ jsonrpc: "2.0", method: "ready" }]);
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
