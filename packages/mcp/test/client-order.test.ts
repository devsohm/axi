import { describe, expect, it } from "vitest";
import { McpClient, type JsonRpcMessage, type McpTransport } from "../src/index.ts";
import { TransportEvents } from "../src/transports/transport.ts";

class DirectServer extends TransportEvents implements McpTransport {
	readonly sent: JsonRpcMessage[] = [];
	readonly initialized: unknown;
	constructor(initialized: unknown) {
		super();
		this.initialized = initialized;
	}
	async start(): Promise<void> {}
	async close(): Promise<void> {}
	async send(message: JsonRpcMessage): Promise<void> {
		if ("method" in message && message.method === "initialize" && "id" in message)
			this.emitMessage({ jsonrpc: "2.0", id: message.id, result: this.initialized });
		else this.sent.push(message);
	}
	receive(message: JsonRpcMessage): void {
		this.emitMessage(message);
	}
}

describe("MCP client operation order", () => {
	it("publishes the negotiated version before reading server metadata", async () => {
		const client = new McpClient({ name: "client", version: "1" });
		const reads: (string | undefined)[] = [];
		const transport = new DirectServer({
			protocolVersion: "2025-11-25",
			capabilities: {},
			get serverInfo() {
				reads.push(client.protocolVersion);
				return { name: "server", version: "1" };
			},
		});
		try {
			await client.connect(transport);
			expect(reads).toEqual([undefined, undefined, undefined, "2025-11-25"]);
		} finally {
			await client.close();
		}
	});
	it("constructs a server response after its handler completes", async () => {
		const client = new McpClient({ name: "client", version: "1" });
		const transport = new DirectServer({
			protocolVersion: "2025-11-25",
			capabilities: {},
			serverInfo: { name: "server", version: "1" },
		});
		let id = 10;
		client.setRequestHandler("answer", () => {
			id = 11;
			return 42;
		});
		try {
			await client.connect(transport);
			transport.receive({
				jsonrpc: "2.0",
				get id() {
					return id;
				},
				method: "answer",
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(transport.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 11, result: 42 });
		} finally {
			await client.close();
		}
	});
});
