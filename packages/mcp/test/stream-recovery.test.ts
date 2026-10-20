import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test, vi } from "vitest";
import { LATEST_PROTOCOL_VERSION, McpClient, StreamableHttpTransport } from "../src/index.ts";

async function fixture(handle: (request: IncomingMessage, response: ServerResponse, body: unknown) => void) {
	const client = new McpClient({ name: "stream-check", version: "1" });
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
		if (request.method === "DELETE") {
			response.writeHead(204).end();
			return;
		}
		if (body && typeof body === "object" && "method" in body) {
			if (body.method === "initialize" && "id" in body) {
				response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stream-session" });
				response.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "local-stream", version: "1" },
						},
					}),
				);
				return;
			}
			if (!("id" in body)) {
				response.writeHead(202).end();
				return;
			}
		}
		handle(request, response, body);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
	return {
		client,
		connect(openGetStream = true) {
			return client.connect(
				new StreamableHttpTransport({
					url: `http://127.0.0.1:${address.port}/mcp`,
					openGetStream,
					reconnect: { initialDelayMs: 1, maxDelayMs: 5, maxRetries: 2 },
				}),
			);
		},
		async [Symbol.asyncDispose]() {
			await client.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

test("a resumed response carries its cursor and session headers and resolves the original request", async () => {
	const resumed: { cursor: string | undefined; session: string | undefined; version: string | undefined }[] = [];
	let requestId: unknown;
	await using f = await fixture((request, response, body) => {
		if (request.method === "GET") {
			resumed.push({
				cursor: request.headers["last-event-id"]?.toString(),
				session: request.headers["mcp-session-id"]?.toString(),
				version: request.headers["mcp-protocol-version"]?.toString(),
			});
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: "Recovered reply" }] } })}\n\n`,
			);
			return;
		}
		if (body && typeof body === "object" && "id" in body) requestId = body.id;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end("id: saved-response\nretry: 1\ndata:\n\n");
	});
	await f.connect(false);
	expect(await f.client.callTool("resume", {}, { timeoutMs: 2000 })).toEqual({
		content: [{ type: "text", text: "Recovered reply" }],
	});
	expect(resumed).toEqual([{ cursor: "saved-response", session: "stream-session", version: LATEST_PROTOCOL_VERSION }]);
});

test("server notifications resume from their event id after a dropped GET stream", async () => {
	const cursors: (string | undefined)[] = [];
	await using f = await fixture((request, response) => {
		if (request.method !== "GET") {
			response.writeHead(400).end();
			return;
		}
		cursors.push(request.headers["last-event-id"]?.toString());
		response.writeHead(200, { "content-type": "text/event-stream" });
		const event = `id: notification-${cursors.length}\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`;
		if (cursors.length === 1) response.end(event);
		else response.write(event);
	});
	let notifications = 0;
	f.client.onNotification("notifications/tools/list_changed", () => {
		notifications++;
	});
	await f.connect();
	await vi.waitFor(() => expect(notifications).toBe(2));
	expect(cursors).toEqual([undefined, "notification-1"]);
});

test("an ended response without a cursor fails promptly instead of leaving its request pending", async () => {
	await using f = await fixture((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(": heartbeat only\n\n");
	});
	await f.connect(false);
	await expect(f.client.callTool("no-result", {}, { timeoutMs: 2000 })).rejects.toThrow(
		"MCP response stream failed: stream ended without a response",
	);
});
