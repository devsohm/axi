import { parseJsonRpcMessage, type JsonRpcMessage } from "../protocol/jsonrpc.ts";
import { DEFAULT_MAX_MESSAGE_BYTES } from "./transport.ts";

export interface JsonRpcLineReaderOptions {
	maxMessageBytes?: number;
	maxStderrBytes?: number;
	onStderr?: (chunk: string) => void;
	onMessage(message: JsonRpcMessage): void;
	onError(error: unknown): void;
}
export class JsonRpcLineReader {
	readonly #options: JsonRpcLineReaderOptions;
	#pending = Buffer.alloc(0);
	#errors = Buffer.alloc(0);
	constructor(options: JsonRpcLineReaderOptions) {
		this.#options = options;
	}
	get stderr(): string {
		return this.#errors.toString("utf8");
	}
	readStdout(chunk: Uint8Array): void {
		this.#pending = Buffer.concat([this.#pending, chunk]);
		const maximum = this.#options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		const tooLong = () => this.#options.onError(new Error(`MCP stdio message exceeds ${maximum} bytes`));
		while (this.#pending.includes(10)) {
			const end = this.#pending.indexOf(10);
			const line = this.#pending.subarray(0, end);
			this.#pending = this.#pending.subarray(end + 1);
			if (line.length > maximum) {
				tooLong();
				continue;
			}
			const text = line.toString("utf8").replace(/\r$/, "");
			if (!text.trim()) continue;
			try {
				this.#options.onMessage(parseJsonRpcMessage(JSON.parse(text)));
			} catch (error) {
				this.#options.onError(error);
			}
		}
		if (this.#pending.length > maximum) {
			this.#pending = Buffer.alloc(0);
			tooLong();
		}
	}
	readStderr(chunk: Uint8Array): void {
		const limit = this.#options.maxStderrBytes ?? 65536;
		const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		this.#errors = Buffer.concat([this.#errors, bytes]);
		if (this.#errors.length > limit) this.#errors = this.#errors.subarray(-limit);
		this.#options.onStderr?.(bytes.toString("utf8"));
	}
	end(): void {
		if (this.#pending.toString("utf8").trim())
			this.#options.onError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
		this.#pending = Buffer.alloc(0);
	}
}
