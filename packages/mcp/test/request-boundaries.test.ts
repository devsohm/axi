import { expect, test } from "vitest";
import { McpClient, LATEST_PROTOCOL_VERSION, type JsonRpcMessage } from "../src/index.ts";
import { createInMemoryTransportPair } from "../src/testing/index.ts";

async function connected(respond: (method: string) => unknown) {
	const pair = createInMemoryTransportPair();
	const received: JsonRpcMessage[] = [];
	pair.server.onMessage((message) => {
		received.push(message);
		if (!("method" in message) || !("id" in message)) return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { resources: {}, tools: {} },
						serverInfo: { name: "fixture", version: "1" },
						instructions: "Local fixture",
					}
				: respond(message.method);
		if (result !== undefined) void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: 1000 });
	await client.connect(pair.client);
	return { client, server: pair.server, received };
}

test("resource and tool helpers validate responses at the transport boundary", async () => {
	const responses: Record<string, unknown> = {
		"resources/list": { resources: [{ uri: "file:///one" }], nextCursor: null },
		"resources/templates/list": { resourceTemplates: [{ uriTemplate: "file:///{path}" }], nextCursor: "" },
		"resources/read": { contents: [{ uri: "file:///one", text: "hello" }] },
		"tools/call": { structuredContent: { answer: 42 } },
	};
	const { client } = await connected((method) => responses[method]);
	try {
		expect(client.instructions).toBe("Local fixture");
		expect(await client.listResourcesPage()).toEqual({ resources: [{ uri: "file:///one", name: "file:///one" }] });
		expect(await client.listResourceTemplatesPage()).toEqual({
			resourceTemplates: [{ uriTemplate: "file:///{path}", name: "file:///{path}" }],
		});
		expect(await client.readResource("file:///one")).toEqual({ contents: [{ uri: "file:///one", text: "hello" }] });
		expect(await client.callTool("answer")).toEqual({ content: [], structuredContent: { answer: 42 } });
		for (const [method, response, invoke, error] of [
			["resources/list", {}, () => client.listResources(), "Invalid MCP resources/list result"],
			["resources/list", { resources: [{ uri: 1 }] }, () => client.listResources(), "Invalid entry"],
			[
				"resources/list",
				{ resources: [], nextCursor: 1 },
				() => client.listResourcesPage(),
				"Invalid MCP resources/list cursor",
			],
			[
				"resources/templates/list",
				{ resourceTemplates: [{ uriTemplate: 1 }] },
				() => client.listResourceTemplates(),
				"Invalid entry",
			],
			[
				"resources/read",
				{ contents: [{ uri: "file:///one" }] },
				() => client.readResource("file:///one"),
				"Invalid contents",
			],
			["resources/read", {}, () => client.readResource("file:///one"), "Invalid MCP resources/read result"],
			["tools/call", { content: "bad" }, () => client.callTool("answer"), "Invalid MCP tools/call result"],
			["tools/list", { tools: [{ name: "answer", inputSchema: [] }] }, () => client.listTools(), "Invalid entry"],
		] satisfies [string, unknown, () => Promise<unknown>, string][]) {
			responses[method] = response;
			await expect(invoke()).rejects.toThrow(error);
		}
	} finally {
		await client.close();
	}
});

test("timeouts and aborts cancel pending requests and later responses cannot settle them again", async () => {
	const { client, server, received } = await connected(() => undefined);
	try {
		await expect(client.request("never", undefined, { timeoutMs: 5 })).rejects.toMatchObject({
			name: "McpTimeoutError",
			timeoutMs: 5,
		});
		await Promise.resolve();
		expect(received).toContainEqual({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 2, reason: "Request timed out" },
		});
		const controller = new AbortController();
		const pending = client.request("wait", undefined, { signal: controller.signal });
		controller.abort("stop now");
		await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "MCP request aborted" });
		await Promise.resolve();
		expect(received).toContainEqual({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 3, reason: "stop now" },
		});
		await server.send({ jsonrpc: "2.0", id: 2, result: "late" });
		await expect(client.request("already-aborted", undefined, { signal: AbortSignal.abort() })).rejects.toMatchObject({
			name: "AbortError",
		});
		await client.close();
		await expect(client.request("closed")).rejects.toMatchObject({ name: "McpConnectionClosedError" });
	} finally {
		await client.close();
	}
});

test("remote error responses and disconnected pending requests keep their distinct failures", async () => {
	const { client, server } = await connected(() => undefined);
	try {
		const pending = client.request("fail");
		await server.send({ jsonrpc: "2.0", id: 2, error: { code: -32001, message: "denied", data: { retry: false } } });
		await expect(pending).rejects.toMatchObject({
			name: "McpError",
			code: -32001,
			message: "denied",
			data: { retry: false },
		});
		const interrupted = client.request("wait");
		await server.close();
		await expect(interrupted).rejects.toMatchObject({ name: "McpConnectionClosedError" });
		expect(client.connectionState).toBe("closed");
	} finally {
		await client.close();
	}
});
