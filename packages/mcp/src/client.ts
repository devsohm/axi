import {
	isObject,
	isJsonRpcId,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	McpAbortError,
	McpConnectionClosedError,
	McpError,
	McpTimeoutError,
	toError,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
} from "./protocol/jsonrpc.ts";
import {
	LATEST_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	type ClientCapabilities,
	type Implementation,
	type InitializeResult,
	type ProgressNotification,
	type ServerCapabilities,
	type SupportedProtocolVersion,
	type Root,
	type Tool,
	type Resource,
	type ResourceTemplate,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	type ReadResourceResult,
} from "./protocol/types.ts";
import type { CallToolResult } from "./protocol/content.ts";
import type { McpTransport } from "./transports/transport.ts";
export interface McpClientOptions extends Implementation {
	capabilities?: ClientCapabilities;
	protocolVersion?: SupportedProtocolVersion;
	requestTimeoutMs?: number;
	roots?: readonly Root[] | (() => readonly Root[] | Promise<readonly Root[]>);
}
export interface McpRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	onProgress?: (progress: ProgressNotification) => void;
}
type RequestHandler = (params: unknown, context: { signal: AbortSignal }) => unknown | Promise<unknown>;
type Pending = {
	resolve(value: unknown): void;
	reject(error: unknown): void;
	controller: AbortController;
	timeout: number;
	timer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	abort(): void;
	cancellable: boolean;
	progressToken: JsonRpcId | undefined;
	progress?: (value: ProgressNotification) => void;
};
function invalid(message: string): McpError {
	return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
}
function initialize(value: unknown): InitializeResult {
	if (
		!isObject(value) ||
		typeof value.protocolVersion !== "string" ||
		!isObject(value.capabilities) ||
		!isObject(value.serverInfo) ||
		typeof value.serverInfo.name !== "string" ||
		typeof value.serverInfo.version !== "string" ||
		(value.instructions !== undefined && typeof value.instructions !== "string")
	)
		throw invalid("Invalid MCP initialize result");
	return value as unknown as InitializeResult;
}
type ItemCheck = (value: Record<string, unknown>) => boolean;
const toolValid: ItemCheck = (value) => typeof value.name === "string" && isObject(value.inputSchema);
const resourceValid: ItemCheck = (value) =>
	typeof value.uri === "string" && (value.name === undefined || typeof value.name === "string");
const templateValid: ItemCheck = (value) =>
	typeof value.uriTemplate === "string" && (value.name === undefined || typeof value.name === "string");
type Page = { items: Record<string, unknown>[]; nextCursor?: string };
function page(value: unknown, method: string, key: string, check: ItemCheck): Page {
	const items = isObject(value) ? value[key] : undefined;
	if (!isObject(value) || !Array.isArray(items)) throw invalid(`Invalid MCP ${method} result`);
	for (const item of items) {
		if (!isObject(item) || !check(item)) throw invalid(`Invalid entry in MCP ${method} result`);
	}
	const cursor = value.nextCursor === null || value.nextCursor === "" ? undefined : value.nextCursor;
	if (cursor !== undefined && typeof cursor !== "string") throw invalid(`Invalid MCP ${method} cursor`);
	return { items, ...(cursor === undefined ? {} : { nextCursor: cursor }) };
}
function resource(row: Record<string, unknown>): Resource {
	return { ...row, name: row.name ?? row.uri } as unknown as Resource;
}
function template(row: Record<string, unknown>): ResourceTemplate {
	return { ...row, name: row.name ?? row.uriTemplate } as unknown as ResourceTemplate;
}
export class McpClient {
	readonly options: Readonly<McpClientOptions>;
	#state: "idle" | "connecting" | "connected" | "closed" = "idle";
	#transport?: McpTransport;
	#next = 1;
	#info?: Implementation;
	#capabilities?: ServerCapabilities;
	#instructions?: string;
	#version?: string;
	readonly #requests = new Map<JsonRpcId, Pending>();
	readonly #progressRequests = new Map<JsonRpcId, JsonRpcId>();
	readonly #incoming = new Map<JsonRpcId, AbortController>();
	readonly #handlers = new Map<string, RequestHandler>();
	readonly #notifications = new Map<string, Set<(params: unknown) => void>>();
	readonly #errors = new Set<(error: Error) => void>();
	readonly #closes = new Set<() => void>();
	#disposers: (() => void)[] = [];
	constructor(options: McpClientOptions) {
		this.options = Object.freeze({ ...options });
		this.#handlers.set("ping", () => ({}));
		const roots = options.roots;
		if (roots)
			this.#handlers.set("roots/list", async () => ({
				roots: [...(typeof roots === "function" ? await roots() : roots)],
			}));
	}
	get connectionState(): "idle" | "connecting" | "connected" | "closed" {
		return this.#state;
	}
	get serverInfo(): Implementation | undefined {
		return this.#info;
	}
	get serverCapabilities(): ServerCapabilities | undefined {
		return this.#capabilities;
	}
	get instructions(): string | undefined {
		return this.#instructions;
	}
	get protocolVersion(): string | undefined {
		return this.#version;
	}
	async connect(transport: McpTransport): Promise<InitializeResult> {
		if (this.#state !== "idle") throw new Error(`Cannot connect MCP client in ${this.#state} state`);
		this.#state = "connecting";
		this.#transport = transport;
		this.#disposers = [
			transport.onMessage((value) => this.#receive(value)),
			transport.onError((error) => this.#error(error)),
			transport.onClose(() => this.#end()),
		];
		try {
			await transport.start();
			const capabilities: ClientCapabilities = { ...this.options.capabilities };
			if (this.options.roots && capabilities.roots === undefined) capabilities.roots = {};
			const result = initialize(
				await this.#request(
					"initialize",
					{
						protocolVersion: this.options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
						capabilities,
						clientInfo: {
							name: this.options.name,
							version: this.options.version,
							...(this.options.title === undefined ? {} : { title: this.options.title }),
						},
					},
					{},
					true,
				),
			);
			if (!SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === result.protocolVersion))
				throw new Error(`MCP server selected unsupported protocol version ${result.protocolVersion}`);
			this.#version = result.protocolVersion;
			this.#info = result.serverInfo;
			this.#capabilities = result.capabilities;
			this.#instructions = result.instructions;
			transport.setProtocolVersion?.(result.protocolVersion);
			await this.#notify("notifications/initialized", undefined, true);
			this.#state = "connected";
			return result;
		} catch (error) {
			await this.close().catch(() => undefined);
			throw error;
		}
	}
	request<Result = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<Result> {
		return this.#request(method, params, options) as Promise<Result>;
	}
	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.#notify(method, params);
	}
	setRequestHandler(method: string, handler: RequestHandler): () => void {
		this.#handlers.set(method, handler);
		return () => {
			if (this.#handlers.get(method) === handler) this.#handlers.delete(method);
		};
	}
	onNotification(method: string, listener: (params: unknown) => void): () => void {
		const listeners = this.#notifications.get(method) ?? new Set();
		listeners.add(listener);
		this.#notifications.set(method, listeners);
		return () => {
			listeners.delete(listener);
			if (!listeners.size) this.#notifications.delete(method);
		};
	}
	onError(listener: (error: Error) => void): () => void {
		this.#errors.add(listener);
		return () => this.#errors.delete(listener);
	}
	onClose(listener: () => void): () => void {
		this.#closes.add(listener);
		return () => this.#closes.delete(listener);
	}
	async ping(options: McpRequestOptions = {}): Promise<void> {
		await this.request("ping", undefined, options);
	}
	async listTools(options: McpRequestOptions = {}): Promise<Tool[]> {
		return (await this.#all("tools/list", "tools", toolValid, options)) as unknown as Tool[];
	}
	async listResources(options: McpRequestOptions = {}): Promise<Resource[]> {
		return (await this.#all("resources/list", "resources", resourceValid, options)).map(resource);
	}
	async listResourceTemplates(options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
		return (await this.#all("resources/templates/list", "resourceTemplates", templateValid, options)).map(template);
	}
	async listResourcesPage(cursor?: string, options: McpRequestOptions = {}): Promise<ListResourcesResult> {
		const result = await this.#page("resources/list", "resources", resourceValid, cursor, options);
		return {
			resources: result.items.map(resource),
			...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
		};
	}
	async listResourceTemplatesPage(
		cursor?: string,
		options: McpRequestOptions = {},
	): Promise<ListResourceTemplatesResult> {
		const result = await this.#page("resources/templates/list", "resourceTemplates", templateValid, cursor, options);
		return {
			resourceTemplates: result.items.map(template),
			...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
		};
	}
	async readResource(uri: string, options: McpRequestOptions = {}): Promise<ReadResourceResult> {
		const value = await this.request("resources/read", { uri }, options);
		if (!isObject(value) || !Array.isArray(value.contents)) throw invalid("Invalid MCP resources/read result");
		for (const content of value.contents)
			if (
				!isObject(content) ||
				typeof content.uri !== "string" ||
				(typeof content.text !== "string" && typeof content.blob !== "string")
			)
				throw invalid("Invalid contents in MCP resources/read result");
		return value as unknown as ReadResourceResult;
	}
	async callTool(
		name: string,
		args?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<CallToolResult> {
		const value = await this.request(
			"tools/call",
			{ name, ...(args === undefined ? {} : { arguments: args }) },
			options,
		);
		if (!isObject(value) || (value.content !== undefined && !Array.isArray(value.content)))
			throw invalid("Invalid MCP tools/call result");
		return (value.content === undefined ? { ...value, content: [] } : value) as unknown as CallToolResult;
	}
	async #page(
		method: string,
		key: string,
		check: ItemCheck,
		cursor: string | undefined,
		options: McpRequestOptions,
	): Promise<Page> {
		return page(await this.request(method, cursor === undefined ? undefined : { cursor }, options), method, key, check);
	}
	async #all(
		method: string,
		key: string,
		check: ItemCheck,
		options: McpRequestOptions,
	): Promise<Record<string, unknown>[]> {
		const result: Record<string, unknown>[] = [],
			seen = new Set<string>();
		let cursor: string | undefined;
		for (let i = 0; i < 1000; i++) {
			const next = await this.#page(method, key, check, cursor, options);
			result.push(...next.items);
			if (next.nextCursor === undefined) return result;
			if (seen.has(next.nextCursor)) throw new Error(`MCP ${method} returned duplicate cursor: ${next.nextCursor}`);
			seen.add(next.nextCursor);
			cursor = next.nextCursor;
		}
		throw new Error(`MCP ${method} exceeded 1000 pages`);
	}
	#channel(connecting = false): McpTransport {
		if (this.#transport && (this.#state === "connected" || (connecting && this.#state === "connecting")))
			return this.#transport;
		throw new McpConnectionClosedError(`MCP client is ${this.#state}`);
	}
	async #request(
		method: string,
		params: Record<string, unknown> | undefined,
		options: McpRequestOptions,
		connecting = false,
	): Promise<unknown> {
		const transport = this.#channel(connecting);
		if (options.signal?.aborted) throw new McpAbortError();
		const id = this.#next++,
			progressToken = options.onProgress ? id : undefined,
			requestParams =
				progressToken === undefined
					? params
					: { ...params, _meta: { ...(isObject(params?._meta) ? params._meta : {}), progressToken } };
		return new Promise((resolve, reject) => {
			const pending: Pending = {
				resolve,
				reject,
				controller: new AbortController(),
				timeout: options.timeoutMs ?? this.options.requestTimeoutMs ?? 30000,
				signal: options.signal,
				cancellable: method !== "initialize",
				progressToken,
				progress: options.onProgress,
				abort: () =>
					this.#cancel(id, new McpAbortError(), method !== "initialize", String(options.signal?.reason ?? "Aborted")),
			};
			this.#requests.set(id, pending);
			if (progressToken !== undefined) this.#progressRequests.set(progressToken, id);
			options.signal?.addEventListener("abort", pending.abort, { once: true });
			this.#timer(id, pending);
			void transport
				.send(
					{ jsonrpc: "2.0", id, method, ...(requestParams === undefined ? {} : { params: requestParams }) },
					{ signal: pending.controller.signal },
				)
				.catch((error) => this.#cancel(id, error, false));
		});
	}
	async #notify(method: string, params: Record<string, unknown> | undefined, connecting = false): Promise<void> {
		await this.#channel(connecting).send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
	}
	#remove(id: JsonRpcId, pending: Pending): void {
		this.#requests.delete(id);
		clearTimeout(pending.timer);
		if (pending.progressToken !== undefined) this.#progressRequests.delete(pending.progressToken);
		pending.signal?.removeEventListener("abort", pending.abort);
		pending.controller.abort();
	}
	#timer(id: JsonRpcId, pending: Pending): void {
		clearTimeout(pending.timer);
		if (Number.isFinite(pending.timeout) && pending.timeout > 0)
			pending.timer = setTimeout(
				() => this.#cancel(id, new McpTimeoutError(pending.timeout), pending.cancellable, "Request timed out"),
				pending.timeout,
			);
	}
	#cancel(id: JsonRpcId, error: unknown, notify: boolean, reason?: string): void {
		const pending = this.#requests.get(id);
		if (!pending) return;
		this.#remove(id, pending);
		pending.reject(error);
		if (notify && this.#transport)
			void this.#transport
				.send({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: id, ...(reason ? { reason } : {}) },
				})
				.catch((error) => this.#error(error));
	}
	#receive(message: JsonRpcMessage): void {
		if (isJsonRpcResponse(message)) {
			const pending = this.#requests.get(message.id);
			if (!pending) {
				this.#error(new Error(`Received response for unknown MCP request ${String(message.id)}`));
				return;
			}
			this.#remove(message.id, pending);
			if ("error" in message)
				pending.reject(new McpError(message.error.code, message.error.message, message.error.data));
			else pending.resolve(message.result);
		} else if (isJsonRpcRequest(message)) void this.#serve(message);
		else if (isJsonRpcNotification(message)) {
			const data = message.params;
			if (message.method === "notifications/cancelled" && isObject(data) && isJsonRpcId(data.requestId))
				this.#incoming.get(data.requestId)?.abort(data.reason);
			if (
				message.method === "notifications/progress" &&
				isObject(data) &&
				isJsonRpcId(data.progressToken) &&
				typeof data.progress === "number"
			) {
				const id = this.#progressRequests.get(data.progressToken);
				const pending = id === undefined ? undefined : this.#requests.get(id);
				if (id !== undefined && pending) {
					this.#timer(id, pending);
					try {
						pending.progress?.(data as unknown as ProgressNotification);
					} catch (error) {
						this.#error(error);
					}
				}
			}
			for (const listener of this.#notifications.get(message.method) ?? []) {
				try {
					listener(data);
				} catch (error) {
					this.#error(error);
				}
			}
		} else this.#error(invalid("Received invalid JSON-RPC message"));
	}
	async #serve(request: JsonRpcRequest): Promise<void> {
		const transport = this.#transport;
		if (!transport) return;
		const handler = this.#handlers.get(request.method);
		if (!handler) {
			await transport
				.send({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${request.method}` },
				})
				.catch((error) => this.#error(error));
			return;
		}
		const controller = new AbortController();
		this.#incoming.set(request.id, controller);
		try {
			const result = await handler(request.params, { signal: controller.signal });
			await transport.send({
				jsonrpc: "2.0",
				id: request.id,
				result: result ?? {},
			});
		} catch (error) {
			await transport
				.send({
					jsonrpc: "2.0",
					id: request.id,
					error:
						error instanceof McpError
							? { code: error.code, message: error.message, data: error.data }
							: { code: JSON_RPC_ERROR_CODES.internalError, message: toError(error).message },
				})
				.catch((error) => this.#error(error));
		} finally {
			this.#incoming.delete(request.id);
		}
	}
	#error(error: unknown): void {
		const normalized = toError(error);
		for (const listener of this.#errors) listener(normalized);
	}
	#end(): void {
		const closed = this.#state === "closed",
			error = new McpConnectionClosedError();
		this.#state = "closed";
		for (const [id, pending] of this.#requests) {
			this.#remove(id, pending);
			pending.reject(error);
		}
		for (const controller of this.#incoming.values()) controller.abort(error);
		this.#incoming.clear();
		if (!closed)
			for (const listener of [...this.#closes]) {
				try {
					listener();
				} catch (error) {
					this.#error(error);
				}
			}
	}
	async close(): Promise<void> {
		const transport = this.#transport;
		this.#transport = undefined;
		for (const dispose of this.#disposers.splice(0)) dispose();
		this.#end();
		await transport?.close();
	}
}
