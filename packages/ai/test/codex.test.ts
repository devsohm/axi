import type { IncomingHttpHeaders } from "node:http";
import { getEventListeners } from "node:events";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
	getOpenAICodexWebSocketDebugStats,
	type OpenAICodexResponsesOptions,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "test-model",
	name: "Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://provider.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
};
const context = normalizeContext({
	systemPrompt: "Test instructions",
	messages: [{ role: "user", content: "first", timestamp: 1 }],
});
function token(account = "test-account"): string {
	return `a.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }))}.b`;
}
function responseEvents(id = "response-1"): object[] {
	return [
		{ type: "response.created", response: { id } },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: `message-${id}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "accepted", annotations: [] }],
			},
		},
		{
			type: "response.done",
			response: {
				id,
				status: "completed",
				end_turn: false,
				usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 2 } },
			},
		},
	];
}
function sse(): Response {
	return new Response(
		responseEvents()
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
async function serverTest(run: (url: string, server: WebSocketServer) => Promise<void>): Promise<void> {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
	try {
		await run(`http://127.0.0.1:${address.port}`, server);
	} finally {
		cleanupSessionResources();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}
afterEach(() => {
	cleanupSessionResources();
	resetOpenAICodexWebSocketDebugStats();
});
describe("legacy Codex requests", () => {
	it("serializes truthy account claims into the request header", async () => {
		for (const account of [42, true, ["account"], { id: "account" }]) {
			let captured: string | null = null;
			const apiKey = `a.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }))}.b`;
			const result = await stream(model, context, {
				apiKey,
				transport: "sse",
				fetch: async (_url, init) => {
					captured = new Headers(init?.headers).get("chatgpt-account-id");
					return sse();
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(captured).toBe(String(account));
		}
	});
	it("retains a completed retry callback on the caller's abort signal", async () => {
		const controller = new AbortController();
		let calls = 0;
		const result = await stream(model, context, {
			apiKey: token(),
			transport: "sse",
			signal: controller.signal,
			maxRetries: 1,
			fetch: async () =>
				++calls === 1 ? new Response("rate limit", { status: 429, headers: { "retry-after-ms": "0" } }) : sse(),
		}).result();
		expect({
			calls,
			reason: result.stopReason,
			listeners: getEventListeners(controller.signal, "abort").length,
		}).toEqual({
			calls: 2,
			reason: "stop",
			listeners: 1,
		});
		controller.abort();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
	});
	it.each(["7", '"heartbeat"', "[]", "0", "false", '""'])(
		"ignores a non-event WebSocket frame %s before the response",
		async (frame) => {
			await serverTest(async (url, server) => {
				const received: unknown[] = [];
				server.on("connection", (socket) =>
					socket.on("message", () => {
						socket.send(frame);
						for (const event of responseEvents()) socket.send(JSON.stringify(event));
					}),
				);
				const result = await stream({ ...model, baseUrl: url }, context, {
					apiKey: token(),
					transport: "websocket",
					onProviderStreamEvent: (event) => {
						received.push(event);
					},
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(received[0]).toEqual(JSON.parse(frame));
			});
		},
	);
	it.each(["7", '"heartbeat"', "[]", "0", "false", '""'])(
		"ignores a non-event SSE frame %s before the response",
		async (frame) => {
			const result = await stream(model, context, {
				apiKey: token(),
				transport: "sse",
				fetch: async () => {
					const response = sse();
					return new Response(`data: ${frame}\n\n${await response.text()}`, {
						headers: { "content-type": "text/event-stream" },
					});
				},
			}).result();
			expect(result.content).toEqual([
				{ type: "text", text: "accepted", textSignature: '{"v":1,"id":"message-response-1"}' },
			]);
			expect(result.stopReason).toBe("stop");
		},
	);
	it("keeps the credential selected before the payload callback", async () => {
		let authorization: string | null = null;
		const selected = token();
		const options: OpenAICodexResponsesOptions = {
			apiKey: selected,
			transport: "sse",
			onPayload() {
				options.apiKey = token("other-account");
			},
			fetch: async (_url, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return sse();
			},
		};
		const result = await stream(model, context, options).result();
		expect({ authorization, reason: result.stopReason }).toEqual({
			authorization: `Bearer ${selected}`,
			reason: "stop",
		});
	});
	it("sends uncompressed JSON when the runtime has no builtin-module loader", async () => {
		const property = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
		if (!property) throw new Error("Expected the host builtin-module loader");
		let body: unknown;
		try {
			Object.defineProperty(process, "getBuiltinModule", { ...property, value: undefined });
			const result = await stream(model, context, {
				apiKey: token(),
				transport: "sse",
				fetch: async (_url, init) => {
					body = init?.body;
					return sse();
				},
			}).result();
			expect({ bodyType: typeof body, reason: result.stopReason }).toEqual({ bodyType: "string", reason: "stop" });
		} finally {
			Object.defineProperty(process, "getBuiltinModule", property);
		}
	});
	it("does not read a fallback retry header when milliseconds are supplied", async () => {
		let fallbackReads = 0,
			calls = 0;
		class RetryHeaders extends Headers {
			override get(name: string): string | null {
				if (name === "retry-after") fallbackReads++;
				return super.get(name);
			}
		}
		const result = await stream(model, context, {
			apiKey: token(),
			transport: "sse",
			maxRetries: 1,
			fetch: async () => {
				if (++calls > 1) return sse();
				const response = new Response("busy", { status: 429 });
				Object.defineProperty(response, "headers", { value: new RetryHeaders({ "retry-after-ms": "0" }) });
				return response;
			},
		}).result();
		expect({ fallbackReads, calls, reason: result.stopReason }).toEqual({ fallbackReads: 0, calls: 2, reason: "stop" });
	});
	it("compresses SSE requests and sends Axi identity with account authentication", async () => {
		let body: unknown,
			headers: Headers | undefined,
			requested = "";
		const result = await stream(model, context, {
			apiKey: token(),
			transport: "sse",
			sessionId: "session-1",
			reasoningEffort: "high",
			fetch: async (url, init) => {
				requested = String(url);
				headers = new Headers(init?.headers);
				if (!(init?.body instanceof Uint8Array)) throw new Error("Expected compressed bytes");
				body = JSON.parse(zstdDecompressSync(init.body).toString("utf8"));
				return sse();
			},
		}).result();
		expect(requested).toBe("https://provider.invalid/codex/responses");
		expect(headers?.get("originator")).toBe("axi");
		expect(headers?.get("user-agent")).toMatch(/^axi\//);
		expect(headers?.get("authorization")).toBe(`Bearer ${token()}`);
		expect(headers?.get("chatgpt-account-id")).toBe("test-account");
		expect(headers?.get("content-encoding")).toBe("zstd");
		expect(headers?.get("session-id")).toBe("session-1");
		expect(body).toMatchObject({
			model: "test-model",
			instructions: "Test instructions",
			reasoning: { effort: "high", summary: "auto" },
			store: false,
			parallel_tool_calls: true,
			input: [{ role: "user", content: [{ type: "input_text", text: "first" }] }],
		});
		expect(result).toMatchObject({
			stopReason: "stop",
			endTurn: false,
			content: [{ type: "text", text: "accepted" }],
			usage: { input: 8, cacheRead: 2, output: 4 },
		});
	});
	it("honors case-insensitive header replacement and deletion", async () => {
		let headers: Headers | undefined;
		const result = await stream(
			{ ...model, headers: { "user-agent": "model-agent", originator: "model-origin", "x-remove": "remove" } },
			context,
			{
				apiKey: token(),
				transport: "sse",
				headers: { "User-Agent": "caller-agent", "x-remove": null },
				fetch: async (_url, init) => {
					headers = new Headers(init?.headers);
					return sse();
				},
			},
		).result();
		expect({
			agent: headers?.get("user-agent"),
			origin: headers?.get("originator"),
			removed: headers?.get("x-remove"),
			stop: result.stopReason,
		}).toEqual({ agent: "caller-agent", origin: "model-origin", removed: null, stop: "stop" });
	});
	it("returns a terminal response without waiting for the SSE body to close", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						responseEvents()
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
					),
				);
			},
			cancel() {
				cancelled = true;
			},
		});
		const result = await stream(model, context, {
			apiKey: token(),
			transport: "sse",
			fetch: async () => new Response(body),
		}).result();
		expect({ stop: result.stopReason, cancelled, response: result.responseId }).toEqual({
			stop: "stop",
			cancelled: true,
			response: "response-1",
		});
	});
	it("does not retry a provider-specified delay beyond the configured limit", async () => {
		let requests = 0;
		const result = await stream(model, context, {
			apiKey: token(),
			transport: "sse",
			maxRetries: 2,
			maxRetryDelayMs: 100,
			fetch: async () => {
				requests++;
				return new Response('{"error":{"message":"busy"}}', { status: 503, headers: { "retry-after-ms": "500" } });
			},
		}).result();
		expect({ requests, stop: result.stopReason, error: result.errorMessage }).toEqual({
			requests: 1,
			stop: "error",
			error: "Server requested 1s retry delay (max: 1s)",
		});
	});
	it("reuses native WebSockets and sends only the continuation delta", async () => {
		await serverTest(async (url, server) => {
			const requests: unknown[] = [],
				headers: IncomingHttpHeaders[] = [];
			server.on("connection", (socket, request) => {
				headers.push(request.headers);
				socket.on("message", (message) => {
					requests.push(JSON.parse(message.toString()));
					for (const event of responseEvents(`response-${requests.length}`)) socket.send(JSON.stringify(event));
				});
			});
			const selected = { ...model, baseUrl: url },
				options = { apiKey: token(), transport: "websocket-cached" as const, sessionId: "native-1" };
			const first = await stream(selected, context, options).result();
			const next = normalizeContext({
				messages: [...context.messages, first, { role: "user", content: "second", timestamp: 3 }],
			});
			const second = await stream(selected, next, options).result();
			expect({ first: first.stopReason, second: second.stopReason, connections: headers.length }).toEqual({
				first: "stop",
				second: "stop",
				connections: 1,
			});
			expect(headers[0]).toMatchObject({
				authorization: `Bearer ${token()}`,
				"chatgpt-account-id": "test-account",
				"session-id": "native-1",
			});
			expect(requests[1]).toMatchObject({
				type: "response.create",
				store: false,
				previous_response_id: "response-1",
				input: [{ role: "user", content: [{ type: "input_text", text: "second" }] }],
			});
			expect(getOpenAICodexWebSocketDebugStats("native-1")).toMatchObject({
				requests: 2,
				connectionsCreated: 1,
				connectionsReused: 1,
				fullContextRequests: 1,
				deltaRequests: 1,
			});
		});
	});
	it("retains cached continuation across a full-context WebSocket request", async () => {
		await serverTest(async (url, server) => {
			const requests: { previous_response_id?: string; input: unknown[] }[] = [];
			server.on("connection", (socket) =>
				socket.on("message", (data) => {
					requests.push(JSON.parse(data.toString()));
					socket.send(
						JSON.stringify({
							type: "response.completed",
							response: { id: `response-${requests.length}`, status: "completed" },
						}),
					);
				}),
			);
			let transcript = normalizeContext({ messages: [{ role: "user", content: "first", timestamp: 1 }] });
			const stops = [];
			for (const transport of ["auto", "websocket", "auto"] as const) {
				const output = await stream({ ...model, baseUrl: url }, transcript, {
					apiKey: token(),
					sessionId: "transport-switch",
					transport,
				}).result();
				stops.push(output.stopReason);
				transcript = normalizeContext({
					messages: [...transcript.messages, output, { role: "user", content: "next", timestamp: 2 }],
				});
			}
			expect(stops).toEqual(["stop", "stop", "stop"]);
			expect(requests.map((request) => request.previous_response_id ?? null)).toEqual([null, null, "response-1"]);
			expect(requests.map((request) => request.input.length)).toEqual([1, 2, 2]);
		});
	});
	it("keeps native socket authentication separate between accounts", async () => {
		await serverTest(async (url, server) => {
			const accounts: (string | string[] | undefined)[] = [];
			server.on("connection", (socket, request) => {
				accounts.push(request.headers["chatgpt-account-id"]);
				socket.on("message", () =>
					socket.send(JSON.stringify({ type: "response.completed", response: { status: "completed" } })),
				);
			});
			for (const account of ["one", "two", "one"]) {
				const result = await stream({ ...model, baseUrl: url }, context, {
					apiKey: token(account),
					sessionId: "shared",
					transport: "websocket",
				}).result();
				expect(result.stopReason).toBe("stop");
			}
			expect(accounts).toEqual(["one", "two"]);
		});
	});
	it("stops on provider errors without retrying through SSE", async () => {
		await serverTest(async (url, server) => {
			server.on("connection", (socket) =>
				socket.on("message", () =>
					socket.send('{"type":"error","error":{"code":"denied","message":"request denied"}}'),
				),
			);
			let httpRequests = 0;
			const result = await stream({ ...model, baseUrl: url }, context, {
				apiKey: token(),
				transport: "auto",
				fetch: async () => {
					httpRequests++;
					return sse();
				},
			}).result();
			expect({ stop: result.stopReason, error: result.errorMessage, httpRequests }).toEqual({
				stop: "error",
				error: "Codex error: request denied",
				httpRequests: 0,
			});
		});
	});
	it("does not treat a raw-event callback failure as a transport failure", async () => {
		await serverTest(async (url, server) => {
			server.on("connection", (socket) =>
				socket.on("message", () => socket.send('{"type":"response.created","response":{"id":"response-1"}}')),
			);
			let httpRequests = 0;
			const result = await stream({ ...model, baseUrl: url }, context, {
				apiKey: token(),
				transport: "auto",
				onProviderStreamEvent: () => {
					throw new Error("observer failed");
				},
				fetch: async () => {
					httpRequests++;
					return sse();
				},
			}).result();
			expect({ stop: result.stopReason, error: result.errorMessage, httpRequests }).toEqual({
				stop: "error",
				error: "observer failed",
				httpRequests: 0,
			});
		});
	});
	it("falls back before output starts and remembers that failure for the session", async () => {
		await serverTest(async (url, server) => {
			let connections = 0,
				httpRequests = 0;
			server.on("connection", (socket) => {
				connections++;
				socket.on("message", () => socket.close(1009));
			});
			for (let index = 0; index < 2; index++) {
				const result = await stream({ ...model, baseUrl: url }, context, {
					apiKey: token(),
					sessionId: "fallback",
					transport: "auto",
					fetch: async () => {
						httpRequests++;
						return sse();
					},
				}).result();
				expect(result.stopReason).toBe("stop");
			}
			expect({ connections, httpRequests }).toEqual({ connections: 1, httpRequests: 2 });
			expect(getOpenAICodexWebSocketDebugStats("fallback")).toMatchObject({
				websocketFailures: 1,
				sseFallbacks: 2,
				websocketFallbackActive: true,
			});
		});
	});
});

describe("Codex WebSocket recovery", () => {
	for (const failures of [1, 2])
		it(`reconnects once for a connection limit and ${failures === 1 ? "completes" : "falls back after another limit"}`, async () => {
			await serverTest(async (url, server) => {
				let connections = 0,
					http = 0;
				server.on("connection", (socket) => {
					const connection = ++connections;
					socket.on("message", () => {
						const events =
							connection <= failures
								? [
										{
											type: "error",
											error: { code: "websocket_connection_limit_reached", message: "Rotate connection" },
										},
									]
								: responseEvents();
						for (const event of events) socket.send(JSON.stringify(event));
					});
				});
				const result = await stream({ ...model, baseUrl: url }, context, {
					apiKey: token(),
					transport: "auto",
					fetch: async () => {
						http++;
						return sse();
					},
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toEqual([{ type: "text", text: "accepted", textSignature: expect.any(String) }]);
				expect({ connections, http }).toEqual({ connections: 2, http: failures === 1 ? 0 : 1 });
			});
		});

	it("rebuilds the complete request after a cached response id is no longer available", async () => {
		await serverTest(async (url, server) => {
			const requests: { previous_response_id?: string; input: unknown[] }[] = [];
			server.on("connection", (socket) =>
				socket.on("message", (data) => {
					const request = JSON.parse(data.toString());
					requests.push(request);
					if (request.previous_response_id) {
						socket.send(
							JSON.stringify({
								type: "error",
								error: {
									code: "previous_response_not_found",
									message: "Cached response expired",
									param: "previous_response_id",
								},
							}),
						);
						return;
					}
					for (const event of responseEvents(`recovered-${requests.length}`)) socket.send(JSON.stringify(event));
				}),
			);
			const selected = { ...model, baseUrl: url },
				options = { apiKey: token(), sessionId: "expired-response", transport: "websocket-cached" as const };
			const first = await stream(selected, context, options).result();
			const continued = normalizeContext({
				messages: [...context.messages, first, { role: "user", content: "Continue", timestamp: 2 }],
			});
			const result = await stream(selected, continued, options).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toContainEqual({ type: "text", text: "accepted", textSignature: expect.any(String) });
			expect(
				requests.map((request) => ({ previous: request.previous_response_id ?? null, count: request.input.length })),
			).toEqual([
				{ previous: null, count: 1 },
				{ previous: "recovered-1", count: 1 },
				{ previous: null, count: 3 },
			]);
		});
	});

	for (const started of [false, true])
		it(`handles an idle socket ${started ? "after" : "before"} output without duplicating the response`, async () => {
			await serverTest(async (url, server) => {
				server.on("connection", (socket) =>
					socket.on("message", () => {
						if (started)
							socket.send(
								JSON.stringify({
									type: "response.output_item.added",
									output_index: 0,
									item: { type: "message", id: "partial", role: "assistant", status: "in_progress", content: [] },
								}),
							);
					}),
				);
				let http = 0;
				const result = await stream({ ...model, baseUrl: url }, context, {
					apiKey: token(),
					sessionId: `idle-${started}`,
					transport: "auto",
					timeoutMs: 100,
					fetch: async () => {
						http++;
						return sse();
					},
				}).result();
				expect(result.stopReason).toBe(started ? "error" : "stop");
				expect(http).toBe(started ? 0 : 1);
				if (started) expect(result.errorMessage).toContain("WebSocket idle timeout");
				else
					expect(result.content).toContainEqual({ type: "text", text: "accepted", textSignature: expect.any(String) });
			});
		});

	it("aborting an active socket cancels its request and allows a fresh call in the same session", async () => {
		await serverTest(async (url, server) => {
			const received = Promise.withResolvers<void>();
			let requests = 0,
				http = 0;
			server.on("connection", (socket) =>
				socket.on("message", () => {
					requests++;
					if (requests === 1) {
						received.resolve();
						return;
					}
					for (const event of responseEvents()) socket.send(JSON.stringify(event));
				}),
			);
			const controller = new AbortController();
			const options = {
				apiKey: token(),
				sessionId: "abort-and-resume",
				transport: "auto" as const,
				fetch: async () => {
					http++;
					return sse();
				},
			};
			const pending = stream({ ...model, baseUrl: url }, context, { ...options, signal: controller.signal }).result();
			await received.promise;
			controller.abort(new Error("Cancelled by application"));
			expect((await pending).stopReason).toBe("aborted");
			const next = await stream({ ...model, baseUrl: url }, context, options).result();
			expect(next.stopReason).toBe("stop");
			expect(next.content).toContainEqual({ type: "text", text: "accepted", textSignature: expect.any(String) });
			expect({ requests, http }).toEqual({ requests: 2, http: 0 });
		});
	});
});
