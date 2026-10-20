import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { McpClient, StdioTransport, type JsonRpcMessage } from "../src/index.ts";
const command = {
	command: process.execPath,
	args: [fileURLToPath(new URL("./fixtures/server.cjs", import.meta.url))],
	inheritEnv: false,
	env: { AXI_MCP_TEST: "child" },
	closeTimeoutMs: 100,
};

test("stdio negotiates with a real child, separates stderr and exchanges Unicode tool results", async () => {
	const transport = new StdioTransport({ ...command, maxStderrBytes: 5 });
	const client = new McpClient({ name: "test", version: "1" });
	try {
		expect((await client.connect(transport)).serverInfo).toEqual({ name: "child", version: "1" });
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		expect(await client.callTool("echo", { text: "café 日本語" })).toEqual({
			content: [{ type: "text", text: "café 日本語" }],
		});
		expect(transport.stderr).toBe("ready");
	} finally {
		await client.close();
	}
	await expect(transport.send({ jsonrpc: "2.0", id: 99, method: "ping" })).rejects.toMatchObject({
		name: "McpConnectionClosedError",
	});
});

test("stdio recovers after an oversized frame and still delivers the following response", async () => {
	const transport = new StdioTransport({ ...command, maxMessageBytes: 128 });
	const messages: JsonRpcMessage[] = [],
		errors: string[] = [];
	transport.onMessage((message) => messages.push(message));
	transport.onError((error) => errors.push(error.message));
	try {
		await transport.start();
		await transport.send({ jsonrpc: "2.0", id: 7, method: "boundary" });
		await vi.waitFor(() => expect(messages).toEqual([{ jsonrpc: "2.0", id: 7, result: "recovered" }]));
		expect(errors).toEqual(["MCP stdio message exceeds 128 bytes"]);
	} finally {
		await transport.close();
	}
});
