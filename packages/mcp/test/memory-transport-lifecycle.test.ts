import { expect, test } from "vitest";
import { InMemoryTransport, createInMemoryTransportPair } from "../src/transports/in-memory.ts";
import type { JsonRpcMessage } from "../src/protocol/jsonrpc.ts";

test("unstarted, absent and unstarted-peer transports reject delivery without emitting messages", async () => {
	const transport = new InMemoryTransport();
	const message = { jsonrpc: "2.0", method: "notice" } as const;
	await expect(transport.send(message)).rejects.toMatchObject({ name: "McpConnectionClosedError" });
	await transport.start();
	await expect(transport.send(message)).rejects.toThrow("peer is not connected");
	const peer = new InMemoryTransport();
	transport.connectPeer(peer);
	await expect(transport.send(message)).rejects.toThrow("peer is not connected");
	await transport.close();
	await expect(transport.send(message)).rejects.toMatchObject({ name: "McpConnectionClosedError" });
});

test("queued messages are cloned before delivery and discarded if the receiving peer closes", async () => {
	const { client, server } = createInMemoryTransportPair();
	const received: unknown[] = [];
	server.onMessage((message) => received.push(message));
	await Promise.all([client.start(), server.start()]);
	const message = { jsonrpc: "2.0", method: "notice", params: { count: 1 } } satisfies JsonRpcMessage;
	const sending = client.send(message);
	message.params.count = 2;
	await sending;
	expect(received).toEqual([{ jsonrpc: "2.0", method: "notice", params: { count: 1 } }]);
	const pending = client.send(message);
	await server.close();
	await pending;
	expect(received).toHaveLength(1);
});
