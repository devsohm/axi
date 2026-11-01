import { describe, expect, it, vi } from "vitest";
import { McpClient, LATEST_PROTOCOL_VERSION, type JsonRpcMessage, type McpRequestOptions } from "../src/index.ts";
import { createInMemoryTransportPair } from "../src/testing/index.ts";
import { McpOAuthProvider, MemoryOAuthStateStore } from "../src/oauth/index.ts";

describe("MCP client", () => {
	it("validates and returns the same page value from a getter", async () => {
		const client = new McpClient({ name: "client", version: "1" });
		let reads = 0;
		vi.spyOn(client, "request").mockResolvedValue({
			get tools() {
				return [{ name: ++reads === 1 ? "first" : "later", inputSchema: {} }];
			},
		});
		expect(await client.listTools()).toEqual([{ name: "first", inputSchema: {} }]);
		expect(reads).toBe(1);
	});
	it("returns whether an error or close listener was removed", () => {
		const client = new McpClient({ name: "client", version: "1" });
		for (const dispose of [client.onError(() => {}), client.onClose(() => {})]) {
			expect(dispose()).toBe(true);
			expect(dispose()).toBe(false);
		}
	});
	it("ignores progress that the request did not advertise", async () => {
		const pair = createInMemoryTransportPair();
		const callbacks: number[] = [];
		let reads = 0;
		const progress: McpRequestOptions["onProgress"] = (value) => callbacks.push(value.progress);
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			if (message.method === "initialize") {
				void pair.server.send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: {},
						serverInfo: { name: "server", version: "1" },
					},
				});
			} else {
				void pair.server.send({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken: message.id, progress: 1 },
				});
				void pair.server.send({ jsonrpc: "2.0", id: message.id, result: "complete" });
			}
		});
		await pair.server.start();
		const client = new McpClient({ name: "client", version: "1" });
		try {
			await client.connect(pair.client);
			expect(
				await client.request("local", undefined, {
					get onProgress() {
						return ++reads === 1 ? undefined : progress;
					},
				}),
			).toBe("complete");
			expect(callbacks).toEqual([]);
		} finally {
			await client.close();
		}
	});
	it("rejects repeated pagination cursors through the transport", async () => {
		const pair = createInMemoryTransportPair();
		let pages = 0;
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			const result =
				message.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: {},
							serverInfo: { name: "own-server", version: "1" },
						}
					: (++pages, { tools: [], nextCursor: "again" });
			void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
		});
		await pair.server.start();
		const client = new McpClient({ name: "own-client", version: "1" });
		try {
			await client.connect(pair.client);
			await expect(client.listTools()).rejects.toThrow("MCP tools/list returned duplicate cursor: again");
			expect(pages).toBe(2);
		} finally {
			await client.close();
		}
	});
	it("keeps replacement request handlers and forwards server cancellation", async () => {
		const pair = createInMemoryTransportPair(),
			received: JsonRpcMessage[] = [];
		pair.server.onMessage((message) => {
			received.push(message);
			if ("method" in message && "id" in message && message.method === "initialize")
				void pair.server.send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: {},
						serverInfo: { name: "server", version: "1" },
					},
				});
		});
		await pair.server.start();
		const client = new McpClient({ name: "client", version: "1" });
		await client.connect(pair.client);
		const dispose = client.setRequestHandler("calculate", () => "old");
		let entered!: () => void;
		const called = new Promise<void>((resolve) => {
			entered = resolve;
		});
		client.setRequestHandler(
			"calculate",
			(_args, { signal }) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
					entered();
				}),
		);
		dispose();
		try {
			await pair.server.send({ jsonrpc: "2.0", id: "server-call", method: "calculate" });
			await called;
			await pair.server.send({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: "server-call", reason: "server stopped" },
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(received).toContainEqual({ jsonrpc: "2.0", id: "server-call", result: "server stopped" });
		} finally {
			await client.close();
		}
	});
	it("serializes concurrent credential updates and isolates server URLs", async () => {
		const store = new MemoryOAuthStateStore();
		const options = {
			serverUrl: "https://first.example/mcp",
			redirectUrl: "http://127.0.0.1/callback",
			clientMetadata: { client_name: "Axi" },
			store,
			onRedirect() {},
		};
		const first = new McpOAuthProvider(options);
		await Promise.all([
			first.saveTokens({ access_token: "local-test-token", token_type: "Bearer" }),
			first.saveCodeVerifier("verifier"),
			first.saveDiscoveryState({ authorizationServerUrl: "https://issuer.example" }),
		]);
		expect(await first.codeVerifier()).toBe("verifier");
		expect((await first.tokens())?.access_token).toBe("local-test-token");
		expect((await first.discoveryState())?.authorizationServerUrl).toBe("https://issuer.example");
		const second = new McpOAuthProvider({ ...options, serverUrl: "https://second.example/mcp" });
		expect(await second.tokens()).toBeUndefined();
		await first.invalidateCredentials("tokens");
		expect(await first.tokens()).toBeUndefined();
		expect(await first.codeVerifier()).toBe("verifier");
	});
});
