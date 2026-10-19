import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import {
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	McpAbortError,
	McpConnectionClosedError,
	parseJsonRpcMessage,
	toError,
	type JsonRpcMessage,
	type JsonRpcId,
} from "../protocol/jsonrpc.ts";
import {
	DEFAULT_MAX_MESSAGE_BYTES,
	TransportEvents,
	type McpTransport,
	type McpTransportSendOptions,
} from "./transport.ts";
export interface SseEvent {
	event?: string;
	data: string;
	id?: string;
}
export interface ConsumeSseOptions {
	maxEventBytes?: number;
	onEvent(event: SseEvent): void;
	onId?(id: string): void;
	onRetry?(delayMs: number): void;
}
export async function consumeSseStream(stream: ReadableStream<Uint8Array>, options: ConsumeSseOptions): Promise<void> {
	const reader = stream.getReader(),
		decoder = new TextDecoder(),
		limit = options.maxEventBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
	let buffer = "",
		name: string | undefined,
		id: string | undefined,
		data: string[] = [],
		size = 0;
	const flush = (): void => {
		if (!data.length) {
			name = undefined;
			id = undefined;
			return;
		}
		options.onEvent({ ...(name ? { event: name } : {}), data: data.join("\n"), ...(id ? { id } : {}) });
		name = undefined;
		id = undefined;
		data = [];
		size = 0;
	};
	const line = (raw: string): void => {
		const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!text) {
			flush();
			return;
		}
		if (text.startsWith(":")) return;
		const at = text.indexOf(":"),
			field = at < 0 ? text : text.slice(0, at);
		let value = at < 0 ? "" : text.slice(at + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			size += Buffer.byteLength(value) + (data.length ? 1 : 0);
			if (size > limit) throw new Error(`MCP SSE event exceeds ${limit} bytes`);
			data.push(value);
		} else if (field === "event") name = value;
		else if (field === "id" && !value.includes("\0")) {
			id = value;
			options.onId?.(value);
		} else if (field === "retry" && /^\d+$/.test(value)) options.onRetry?.(Number(value));
	};
	try {
		for (;;) {
			const read = await reader.read();
			if (read.done) break;
			buffer += decoder.decode(read.value, { stream: true });
			let at: number;
			while ((at = buffer.indexOf("\n")) >= 0) {
				line(buffer.slice(0, at));
				buffer = buffer.slice(at + 1);
			}
			if (Buffer.byteLength(buffer) > limit) throw new Error(`MCP SSE event exceeds ${limit} bytes`);
		}
		buffer += decoder.decode();
		if (buffer) line(buffer);
		flush();
	} finally {
		reader.releaseLock();
	}
}
export interface StreamableHttpReconnectOptions {
	initialDelayMs?: number;
	maxDelayMs?: number;
	maxRetries?: number;
}
export interface StreamableHttpTransportOptions {
	url: string | URL;
	headers?: Record<string, string>;
	fetch?: McpFetch;
	openGetStream?: boolean;
	maxMessageBytes?: number;
	authProvider?: AuthProvider;
	reconnect?: StreamableHttpReconnectOptions;
}
export class McpHttpError extends Error {
	readonly status: number;
	readonly body: string;
	constructor(status: number, message: string, body = "") {
		super(message);
		this.name = "McpHttpError";
		this.status = status;
		this.body = body;
	}
}
export class McpAuthRequiredError extends McpHttpError {
	readonly wwwAuthenticate: string | null;
	constructor(response: Response, body = "") {
		super(401, "MCP server requires authentication", body);
		this.name = "McpAuthRequiredError";
		this.wwwAuthenticate = response.headers.get("www-authenticate");
	}
}
export class McpSessionExpiredError extends McpHttpError {
	constructor(body = "") {
		super(404, "MCP session expired", body);
		this.name = "McpSessionExpiredError";
	}
}
function media(response: Response): string | undefined {
	return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}
function discard(response: Response): Promise<void> {
	return response.body?.cancel().catch(() => undefined) ?? Promise.resolve();
}
type Cursor = { id: string | undefined; retry: number | undefined; received: boolean };
export class StreamableHttpTransport extends TransportEvents implements McpTransport {
	readonly url: URL;
	readonly options: Readonly<StreamableHttpTransportOptions>;
	readonly #fetch: McpFetch;
	readonly #controller = new AbortController();
	#started = false;
	#closed = false;
	#get = false;
	#session?: string;
	#version?: string;
	#token?: string;
	constructor(options: StreamableHttpTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
		this.url = new URL(options.url);
		const fetch = options.fetch ?? globalThis.fetch;
		this.#fetch = (input, init) => fetch(input, init);
	}
	get sessionId(): string | undefined {
		return this.#session;
	}
	async start(): Promise<void> {
		if (this.#started) throw new Error("MCP Streamable HTTP transport already started");
		if (this.#closed) throw new McpConnectionClosedError();
		this.#started = true;
	}
	setProtocolVersion(version: string): void {
		this.#version = version;
	}
	#headers(extra: Record<string, string>, token?: string): Headers {
		const headers = new Headers(this.options.headers);
		for (const [key, value] of Object.entries(extra)) headers.set(key, value);
		if (this.#session) headers.set("Mcp-Session-Id", this.#session);
		if (this.#version) headers.set("MCP-Protocol-Version", this.#version);
		if (token) headers.set("Authorization", `Bearer ${token}`);
		return headers;
	}
	async #request(
		method: "GET" | "POST",
		headers: Record<string, string>,
		body?: string,
		signal?: AbortSignal,
	): Promise<Response> {
		const auth = this.options.authProvider,
			onUnauthorized = auth?.onUnauthorized?.bind(auth);
		for (let attempt = 0; ; attempt++) {
			const prepared = await this.#authorizedHeaders(headers);
			if (signal?.aborted) throw new McpAbortError();
			const response = await this.#fetch(this.url, {
				method,
				headers: prepared.headers,
				body,
				signal: this.#controller.signal,
			});
			if (attempt || !onUnauthorized) return response;
			const unauthorized =
				response.status === 401 ||
				(response.status === 403 &&
					/(?:^|[\s,])error="?insufficient_scope"?/i.test(response.headers.get("www-authenticate") ?? ""));
			if (!unauthorized) return response;
			try {
				await onUnauthorized({ response, serverUrl: this.url, fetch: this.#fetch, token: prepared.token });
			} finally {
				await discard(response);
			}
		}
	}
	async #authorizedHeaders(extra: Record<string, string>): Promise<{ headers: Headers; token?: string }> {
		const token = await this.options.authProvider?.token();
		this.#token = token;
		return { headers: this.#headers(extra, token), ...(token ? { token } : {}) };
	}
	#capture(response: Response): void {
		const id = response.headers.get("mcp-session-id");
		if (id) this.#session = id;
	}
	async #check(response: Response): Promise<void> {
		if (response.ok) return;
		const body = (await response.text().catch(() => "")).slice(0, 8192);
		if (response.status === 401) throw new McpAuthRequiredError(response, body);
		if (response.status === 404 && this.#session) throw new McpSessionExpiredError(body);
		const text = body.trim(),
			snippet = text.length > 500 ? text.slice(0, 497) + "..." : text;
		throw new McpHttpError(
			response.status,
			`MCP HTTP request failed with status ${response.status}${snippet ? `: ${snippet}` : ""}`,
			body,
		);
	}
	async send(message: JsonRpcMessage, { signal }: McpTransportSendOptions = {}): Promise<void> {
		if (!this.#started || this.#closed) throw new McpConnectionClosedError();
		const response = await this.#request(
			"POST",
			{ accept: "application/json, text/event-stream", "content-type": "application/json" },
			JSON.stringify(message),
			signal,
		);
		await this.#check(response);
		this.#capture(response);
		if (!isJsonRpcRequest(message)) {
			await discard(response);
			if (
				"method" in message &&
				message.method === "notifications/initialized" &&
				!this.#get &&
				!this.#closed &&
				this.options.openGetStream !== false
			) {
				this.#get = true;
				void this.#getLoop();
			}
			return;
		}
		if (response.status === 202 || response.status === 204)
			throw new McpHttpError(response.status, `MCP server accepted request ${message.method} without a response`);
		const type = media(response);
		if (type === "application/json") {
			const value: unknown = await response.json();
			for (const row of Array.isArray(value) ? value : [value]) this.emitMessage(parseJsonRpcMessage(row));
			return;
		}
		if (type === "text/event-stream" && response.body) {
			void this.#responseLoop(response.body, message.id);
			return;
		}
		await discard(response);
		throw new McpHttpError(response.status, `Unsupported MCP response content type: ${type ?? "missing"}`);
	}
	async #consume(
		body: ReadableStream<Uint8Array>,
		cursor: Cursor,
		callback?: (message: JsonRpcMessage) => void,
	): Promise<void> {
		await consumeSseStream(body, {
			maxEventBytes: this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
			onId: (id) => {
				cursor.id = id;
			},
			onRetry: (retry) => {
				cursor.retry = retry;
			},
			onEvent: (event) => {
				cursor.received = true;
				if (!event.data.trim() || (event.event !== undefined && event.event !== "message")) return;
				let message: JsonRpcMessage;
				try {
					message = parseJsonRpcMessage(JSON.parse(event.data));
				} catch (error) {
					this.emitError(error);
					return;
				}
				callback?.(message);
				this.emitMessage(message);
			},
		});
	}
	async #open(id?: string): Promise<ReadableStream<Uint8Array> | undefined> {
		const response = await this.#request("GET", {
			accept: "text/event-stream",
			...(id === undefined ? {} : { "last-event-id": id }),
		});
		if (response.status === 405) {
			await discard(response);
			return;
		}
		await this.#check(response);
		this.#capture(response);
		const type = media(response);
		if (type === "text/event-stream" && response.body) return response.body;
		await discard(response);
		throw new McpHttpError(response.status, `Unsupported MCP GET response content type: ${type ?? "missing"}`);
	}
	#retryable(error: unknown): boolean {
		if (error instanceof McpHttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
		if (error instanceof TypeError) return true;
		const code = (error as { code?: unknown } | null | undefined)?.code;
		return typeof code === "string" && (code.startsWith("E") || code.startsWith("UND_ERR"));
	}
	#maxDelay(): number {
		return this.options.reconnect?.maxDelayMs ?? 30000;
	}
	#maxRetries(): number {
		return this.options.reconnect?.maxRetries ?? 5;
	}
	#delay(attempt: number, cursor: Cursor): number {
		return cursor.retry ?? Math.min((this.options.reconnect?.initialDelayMs ?? 1000) * 2 ** attempt, this.#maxDelay());
	}
	#sleep(ms: number): Promise<boolean> {
		const signal = this.#controller.signal;
		if (signal.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			const abort = () => {
				clearTimeout(timer);
				resolve(false);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve(true);
			}, ms);
			timer.unref?.();
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	async #responseLoop(initial: ReadableStream<Uint8Array>, id: JsonRpcId): Promise<void> {
		const cursor: Cursor = { id: undefined, retry: undefined, received: false };
		let stream: ReadableStream<Uint8Array> | undefined = initial,
			failure: unknown,
			answered = false,
			attempt = 0;
		const onMessage = (message: JsonRpcMessage): void => {
			if (isJsonRpcResponse(message) && message.id === id) answered = true;
		};
		for (;;) {
			if (stream) {
				try {
					await this.#consume(stream, cursor, onMessage);
					failure = undefined;
				} catch (error) {
					failure = error;
				}
			}
			if (answered || this.#closed) return;
			if (
				(failure !== undefined && !this.#retryable(failure)) ||
				cursor.id === undefined ||
				attempt >= this.#maxRetries()
			)
				break;
			if (cursor.received) attempt = 0;
			cursor.received = false;
			if (!(await this.#sleep(this.#delay(attempt++, cursor)))) return;
			try {
				stream = await this.#open(cursor.id);
			} catch (error) {
				failure = error;
				if (!this.#retryable(error)) break;
				stream = undefined;
			}
		}
		if (!this.#closed)
			this.emitMessage({
				jsonrpc: "2.0",
				id,
				error: {
					code: JSON_RPC_ERROR_CODES.internalError,
					message: `MCP response stream failed: ${failure === undefined ? "stream ended without a response" : toError(failure).message}`,
				},
			});
	}
	async #getLoop(): Promise<void> {
		const cursor: Cursor = { id: undefined, retry: undefined, received: false };
		let attempt = 0;
		while (!this.#closed) {
			try {
				const stream = await this.#open(cursor.id);
				if (!stream) return;
				const since = Date.now();
				await this.#consume(stream, cursor);
				if (cursor.received || Date.now() - since > this.#maxDelay()) attempt = 0;
			} catch (error) {
				if (this.#closed) return;
				if (!this.#retryable(error)) {
					this.emitError(error);
					return;
				}
			}
			cursor.received = false;
			if (attempt >= this.#maxRetries()) {
				this.emitError(new Error("MCP server-to-client stream dropped and could not be reopened"));
				return;
			}
			if (!(await this.#sleep(this.#delay(attempt++, cursor)))) return;
		}
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#controller.abort();
		if (this.#started && this.#session) {
			try {
				await discard(
					await this.#fetch(this.url, {
						method: "DELETE",
						headers: this.#headers({}, this.#token),
						signal: AbortSignal.timeout(1000),
					}),
				);
			} catch {}
		}
		this.emitClose();
	}
}
