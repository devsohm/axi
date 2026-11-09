import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { McpClient, StreamableHttpTransport, LATEST_PROTOCOL_VERSION } from "../src/index.ts";
import { consumeSseStream, type SseEvent } from "../src/transports/streamable-http.ts";

test("HTTP error excerpts stop reading after the byte budget", async () => {
	let cancelled = false;
	let reads = 0;
	const transport = new StreamableHttpTransport({
		url: "https://example.invalid/mcp",
		fetch: async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						reads++;
						controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
						if (reads === 100) controller.close();
					},
					cancel() {
						cancelled = true;
					},
				}),
				{ status: 502 },
			),
	});
	await transport.start();
	try {
		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toMatchObject({
			body: "x".repeat(8192),
		});
		expect(cancelled).toBe(true);
		expect(reads).toBeLessThan(12);
	} finally {
		await transport.close();
	}
});

test("JSON responses obey the transport byte budget", async () => {
	const transport = new StreamableHttpTransport({
		url: "https://example.invalid/mcp",
		maxMessageBytes: 64,
		fetch: async () => Response.json({ jsonrpc: "2.0", id: 1, result: "é".repeat(64) }),
	});
	await transport.start();
	try {
		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(
			"MCP JSON response exceeds 64 bytes",
		);
	} finally {
		await transport.close();
	}
});

test("rejected SSE input cancels its source even if cancellation fails", async () => {
	let cancelled = false;
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("data: oversized\n\n"));
		},
		cancel() {
			cancelled = true;
			throw new Error("cancel failed");
		},
	});
	await expect(consumeSseStream(source, { maxEventBytes: 2, onEvent() {} })).rejects.toThrow(
		"MCP SSE event exceeds 2 bytes",
	);
	expect(cancelled).toBe(true);
	expect(source.locked).toBe(false);
});

test("HTTP errors keep a UTF-8 byte excerpt without an incomplete character", async () => {
	const text = "a" + "🙂".repeat(8192);
	for (const status of [401, 503]) {
		const transport = new StreamableHttpTransport({
			url: "https://example.invalid/mcp",
			openGetStream: false,
			fetch: async () => new Response(text, { status }),
		});
		await transport.start();
		try {
			await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toMatchObject({
				status,
				body: "a" + "🙂".repeat(2047),
			});
		} finally {
			await transport.close();
		}
	}
});

test("HTTP sessions negotiate, read streamed tools, call them and terminate with session headers", async () => {
	const observed: { method: string; session: string | undefined; version: string | undefined; body: unknown }[] = [];
	let expired = false;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
		observed.push({
			method: request.method ?? "",
			session: request.headers["mcp-session-id"]?.toString(),
			version: request.headers["mcp-protocol-version"]?.toString(),
			body,
		});
		if (request.method === "DELETE") {
			response.writeHead(204).end();
			return;
		}
		if (expired) {
			response.writeHead(404).end("expired");
			return;
		}
		if (!body || typeof body !== "object" || !("method" in body)) {
			response.writeHead(400).end();
			return;
		}
		if (!("id" in body)) {
			response.writeHead(202).end();
			return;
		}
		if (body.method === "initialize") {
			response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "local-session" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "local", version: "1" },
					},
				}),
			);
		} else if (body.method === "tools/list") {
			response.writeHead(200, { "content-type": "text/event-stream" });
			const event = Buffer.from(
				`id: tool-page\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", description: "café", inputSchema: { type: "object" } }] } })}\r\n\r\n`,
			);
			for (let offset = 0; offset < event.length; offset += 3) response.write(event.subarray(offset, offset + 3));
			response.end();
		} else {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "café" }] } }),
			);
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing listener");
	const transport = new StreamableHttpTransport({ url: `http://127.0.0.1:${address.port}/mcp`, openGetStream: false });
	const client = new McpClient({ name: "axi-test", version: "1" });
	try {
		expect((await client.connect(transport)).serverInfo).toEqual({ name: "local", version: "1" });
		expect(await client.listTools()).toEqual([{ name: "echo", description: "café", inputSchema: { type: "object" } }]);
		expect(await client.callTool("echo", { text: "café" })).toEqual({ content: [{ type: "text", text: "café" }] });
		expect(observed.at(-1)).toMatchObject({
			session: "local-session",
			version: LATEST_PROTOCOL_VERSION,
			body: { method: "tools/call", params: { name: "echo", arguments: { text: "café" } } },
		});
		expired = true;
		await expect(client.ping()).rejects.toMatchObject({ name: "McpSessionExpiredError", status: 404 });
	} finally {
		await client.close();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	expect(observed.at(-1)).toMatchObject({
		method: "DELETE",
		session: "local-session",
		version: LATEST_PROTOCOL_VERSION,
	});
});

test("SSE decoding survives every byte split and enforces byte limits", async () => {
	const source = new TextEncoder().encode(
		":comment\r\nid: first\r\nretry: 7\r\nevent: message\r\ndata: café\r\ndata: 日本\r\n\r\n",
	);
	for (let split = 1; split < source.length; split++) {
		const events: SseEvent[] = [],
			ids: string[] = [],
			retries: number[] = [];
		await consumeSseStream(
			new ReadableStream({
				start(controller) {
					controller.enqueue(source.slice(0, split));
					controller.enqueue(source.slice(split));
					controller.close();
				},
			}),
			{
				onEvent: (event) => events.push(event),
				onId: (id) => ids.push(id),
				onRetry: (delay) => retries.push(delay),
			},
		);
		expect(events).toEqual([{ event: "message", id: "first", data: "café\n日本" }]);
		expect(ids).toEqual(["first"]);
		expect(retries).toEqual([7]);
	}
	await expect(
		consumeSseStream(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: ééé\n\n"));
					controller.close();
				},
			}),
			{ maxEventBytes: 4, onEvent() {} },
		),
	).rejects.toThrow("exceeds 4 bytes");
});
