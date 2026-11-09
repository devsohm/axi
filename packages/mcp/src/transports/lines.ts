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
	#pending: Buffer[] = [];
	#pendingBytes = 0;
	#errors = Buffer.alloc(0);
	constructor(options: JsonRpcLineReaderOptions) {
		this.#options = options;
	}
	get stderr(): string {
		return this.#errors.toString("utf8");
	}
	readStdout(chunk: Uint8Array): void {
		const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const maximum = this.#options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		const tooLong = () => this.#options.onError(new Error(`MCP stdio message exceeds ${maximum} bytes`));
		let offset = 0;
		for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, offset)) {
			const fragment = bytes.subarray(offset, end);
			const line = this.#pending.length
				? Buffer.concat([...this.#pending, fragment], this.#pendingBytes + fragment.length)
				: fragment;
			this.#pending = [];
			this.#pendingBytes = 0;
			offset = end + 1;
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
		if (offset < bytes.length) {
			this.#pending.push(Buffer.from(bytes.subarray(offset)));
			this.#pendingBytes += bytes.length - offset;
		}
		if (this.#pendingBytes > maximum) {
			this.#pending = [];
			this.#pendingBytes = 0;
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
		if (this.#pendingBytes && Buffer.concat(this.#pending, this.#pendingBytes).toString("utf8").trim())
			this.#options.onError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
		this.#pending = [];
		this.#pendingBytes = 0;
	}
}
