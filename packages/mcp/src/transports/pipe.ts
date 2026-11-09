import { McpConnectionClosedError, type JsonRpcMessage } from "../protocol/jsonrpc.ts";
import { JsonRpcLineReader } from "./lines.ts";
import { TransportEvents, type McpTransport } from "./transport.ts";

export interface McpPipe {
	write(data: Uint8Array | string): void;
	closeStdin(): void;
	close(): void;
	readonly exited: Promise<unknown>;
}
export interface McpPipeHandlers {
	onStdout(bytes: Uint8Array): void;
	onStderr(bytes: Uint8Array): void;
}
export interface PipeTransportOptions {
	open(handlers: McpPipeHandlers): Promise<McpPipe>;
	maxMessageBytes?: number;
	maxStderrBytes?: number;
	onStderr?: (chunk: string) => void;
	closeTimeoutMs?: number;
}
export class PipeTransport extends TransportEvents implements McpTransport {
	readonly options: Readonly<PipeTransportOptions>;
	readonly #lines: JsonRpcLineReader;
	#pipe?: McpPipe;
	#started = false;
	#closed = false;
	#ended = false;
	constructor(options: PipeTransportOptions) {
		super();
		this.options = Object.freeze({ ...options });
		this.#lines = new JsonRpcLineReader({
			maxMessageBytes: this.options.maxMessageBytes,
			maxStderrBytes: this.options.maxStderrBytes,
			onStderr: this.options.onStderr,
			onMessage: (message) => this.emitMessage(message),
			onError: (error) => this.emitError(error),
		});
	}
	get stderr(): string {
		return this.#lines.stderr;
	}
	async start(): Promise<void> {
		if (this.#started) throw new Error("MCP pipe transport already started");
		if (this.#closed) throw new McpConnectionClosedError();
		this.#started = true;
		const pipe = await this.options.open({
			onStdout: (data) => this.#lines.readStdout(data),
			onStderr: (data) => this.#lines.readStderr(data),
		});
		if (this.#closed) {
			void pipe.exited.catch(() => undefined);
			pipe.close();
			throw new McpConnectionClosedError();
		}
		this.#pipe = pipe;
		void pipe.exited.then(
			() => this.#finish(),
			(error: unknown) => {
				if (!this.#closed) this.emitError(error);
				this.#finish();
			},
		);
	}
	#finish(): void {
		this.#ended = true;
		this.#lines.end();
		this.emitClose();
	}
	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.#pipe || this.#closed || this.#ended) throw new McpConnectionClosedError();
		this.#pipe.write(JSON.stringify(message) + "\n");
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const pipe = this.#pipe;
		if (!pipe) {
			this.emitClose();
			return;
		}
		if (this.#ended) return;
		pipe.closeStdin();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = pipe.exited.then(
			() => true,
			() => true,
		);
		const ended = await Promise.race([
			settled,
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), this.options.closeTimeoutMs ?? 2000);
			}),
		]);
		clearTimeout(timer);
		if (!ended) {
			pipe.close();
			await settled;
		}
	}
}
