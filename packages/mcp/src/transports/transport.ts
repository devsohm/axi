import { toError, type JsonRpcMessage } from "../protocol/jsonrpc.ts";
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export type McpTransportMessageListener = (message: JsonRpcMessage) => void;
export type McpTransportErrorListener = (error: Error) => void;
export type McpTransportCloseListener = () => void;
export interface McpTransportSendOptions {
	signal?: AbortSignal;
}
export interface McpTransport {
	start(): Promise<void>;
	close(): Promise<void>;
	send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void>;
	onMessage(listener: McpTransportMessageListener): () => void;
	onError(listener: McpTransportErrorListener): () => void;
	onClose(listener: McpTransportCloseListener): () => void;
	setProtocolVersion?(version: string): void;
}
export abstract class TransportEvents {
	readonly #messages = new Set<McpTransportMessageListener>();
	readonly #errors = new Set<McpTransportErrorListener>();
	readonly #closes = new Set<McpTransportCloseListener>();
	#ended = false;
	onMessage(listener: McpTransportMessageListener): () => void {
		this.#messages.add(listener);
		return () => this.#messages.delete(listener);
	}
	onError(listener: McpTransportErrorListener): () => void {
		this.#errors.add(listener);
		return () => this.#errors.delete(listener);
	}
	onClose(listener: McpTransportCloseListener): () => void {
		this.#closes.add(listener);
		return () => this.#closes.delete(listener);
	}
	protected emitMessage(message: JsonRpcMessage): void {
		for (const callback of this.#messages) callback(message);
	}
	protected emitError(error: unknown): void {
		const value = toError(error);
		for (const callback of this.#errors) callback(value);
	}
	protected emitClose(): void {
		if (!this.#ended) {
			this.#ended = true;
			for (const callback of this.#closes) callback();
		}
	}
}
