import { McpConnectionClosedError, type JsonRpcMessage } from "../protocol/jsonrpc.ts";
import { TransportEvents, type McpTransport } from "./transport.ts";
export class InMemoryTransport extends TransportEvents implements McpTransport {
	#peer?: InMemoryTransport;
	#started = false;
	#closed = false;
	connectPeer(peer: InMemoryTransport): void {
		if (this.#peer) throw new Error("In-memory MCP transport already has a peer");
		this.#peer = peer;
	}
	async start(): Promise<void> {
		if (this.#closed) throw new McpConnectionClosedError();
		this.#started = true;
	}
	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.#started || this.#closed) throw new McpConnectionClosedError();
		const peer = this.#peer;
		if (!peer || !peer.#started || peer.#closed)
			throw new McpConnectionClosedError("In-memory MCP peer is not connected");
		const copy = structuredClone(message);
		queueMicrotask(() => {
			if (!peer.#closed) peer.emitMessage(copy);
		});
	}
	async close(): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			this.emitClose();
			await this.#peer?.close();
		}
	}
	override emitError(error: unknown): void {
		super.emitError(error);
	}
}
export function createInMemoryTransportPair(): { client: InMemoryTransport; server: InMemoryTransport } {
	const client = new InMemoryTransport(),
		server = new InMemoryTransport();
	client.connectPeer(server);
	server.connectPeer(client);
	return { client, server };
}
