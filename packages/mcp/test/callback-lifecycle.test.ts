import { expect, test, vi } from "vitest";
import {
	LATEST_PROTOCOL_VERSION,
	McpClient,
	McpError,
	type JsonRpcMessage,
	type McpClientOptions,
} from "../src/index.ts";
import { createInMemoryTransportPair } from "../src/testing/index.ts";

async function fixture(options: Partial<McpClientOptions> = {}) {
	const { client: transport, server } = createInMemoryTransportPair();
	const messages: JsonRpcMessage[] = [];
	server.onMessage((message) => {
		messages.push(message);
		if ("method" in message && "id" in message && message.method === "initialize") {
			void server.send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					serverInfo: { name: "peer", version: "2" },
					capabilities: { tools: { listChanged: true } },
				},
			});
		}
	});
	await server.start();
	const client = new McpClient({ name: "client", version: "1", ...options });
	await client.connect(transport);
	let id = 100;
	return {
		client,
		server,
		transport,
		messages,
		async invoke(method: string) {
			const requestId = id++;
			await server.send({ jsonrpc: "2.0", id: requestId, method });
			await vi.waitFor(() =>
				expect(messages.some((message) => "id" in message && message.id === requestId)).toBe(true),
			);
			const response = messages.find((message) => "id" in message && message.id === requestId);
			if (!response) throw new Error("Missing response");
			return response;
		},
	};
}

test("peer requests receive ping and current roots, and initialization advertises their capability", async () => {
	for (const dynamic of [true, false]) {
		const roots = [{ uri: "file:///project", name: "Project" }];
		const f = await fixture({ title: "Owned client", roots: dynamic ? async () => roots : roots });
		try {
			expect(f.messages[0]).toMatchObject({
				method: "initialize",
				params: { clientInfo: { title: "Owned client" }, capabilities: { roots: {} } },
			});
			expect(f.client.serverInfo).toEqual({ name: "peer", version: "2" });
			expect(f.client.serverCapabilities).toEqual({ tools: { listChanged: true } });
			expect(await f.invoke("ping")).toMatchObject({ result: {} });
			expect(await f.invoke("roots/list")).toMatchObject({ result: { roots } });
			roots.push({ uri: "file:///next", name: "Next" });
			expect(await f.invoke("roots/list")).toMatchObject({ result: { roots } });
			await f.client.notify("notifications/roots/list_changed", { changed: true });
			expect(f.messages.at(-1)).toMatchObject({
				method: "notifications/roots/list_changed",
				params: { changed: true },
			});
			await expect(f.client.connect(f.transport)).rejects.toThrow(/connected state/);
		} finally {
			await f.client.close();
		}
	}
});

test("replacing handlers preserves the new owner and returns protocol errors after disposal", async () => {
	const f = await fixture();
	try {
		const old = f.client.setRequestHandler("owned", () => "old");
		const current = f.client.setRequestHandler("owned", () => undefined);
		old();
		expect(await f.invoke("owned")).toMatchObject({ result: {} });
		current();
		expect(await f.invoke("owned")).toMatchObject({ error: { code: -32601 } });
		f.client.setRequestHandler("typed-error", () => {
			throw new McpError(-32001, "denied", { retry: false });
		});
		expect(await f.invoke("typed-error")).toMatchObject({
			error: { code: -32001, message: "denied", data: { retry: false } },
		});
		f.client.setRequestHandler("error", () => {
			throw new Error("callback failed");
		});
		expect(await f.invoke("error")).toMatchObject({ error: { code: -32603, message: "callback failed" } });
	} finally {
		await f.client.close();
	}
});

test("notification and close callbacks unsubscribe cleanly and report callback failures", async () => {
	const f = await fixture();
	const errors: Error[] = [],
		notices = vi.fn(),
		closed = vi.fn();
	const stopError = f.client.onError((error) => errors.push(error));
	const stopFirst = f.client.onNotification("custom", () => {
		throw new Error("listener failed");
	});
	const stopSecond = f.client.onNotification("custom", notices);
	const stopClose = f.client.onClose(closed);
	try {
		await f.server.send({ jsonrpc: "2.0", method: "custom", params: { value: 7 } });
		expect(notices).toHaveBeenCalledWith({ value: 7 });
		expect(errors.map((error) => error.message)).toEqual(["listener failed"]);
		stopFirst();
		stopSecond();
		stopClose();
		await f.server.send({ jsonrpc: "2.0", method: "custom" });
		expect(notices).toHaveBeenCalledOnce();
		await f.server.send(JSON.parse('{"jsonrpc":"2.0","method":42}'));
		expect(errors.at(-1)?.message).toContain("invalid JSON-RPC");
		stopError();
		await f.server.send(JSON.parse('{"invalid":true}'));
		expect(errors).toHaveLength(2);
	} finally {
		await f.client.close();
	}
	expect(closed).not.toHaveBeenCalled();
});
