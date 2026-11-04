import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "../../context/index.ts";
import type { Connection } from "./admission.ts";
import { isForwarding, type Incoming } from "./incoming.ts";
import type { Answer } from "./response.ts";
import { UNCARRIED } from "./router.ts";
export type ListenAddress = { readonly host: string; readonly port: number };
export type Served = { readonly answer: Answer; readonly finished: () => void };
export interface Handler {
	serve(incoming: Incoming, connection: Connection): Promise<Served>;
	refusal(status: number): Answer;
	readonly upgrade: (message: IncomingMessage, socket: Duplex, head: Buffer) => void;
}
export class NodeListener {
	readonly address: ListenAddress;
	readonly #server: Server;
	readonly #ended: Promise<void>;
	private constructor(server: Server, address: ListenAddress) {
		this.#server = server;
		this.address = address;
		this.#ended = new Promise((resolve) => server.once("close", resolve));
	}
	static async listen(handler: Handler, at: ListenAddress, context: Context): Promise<NodeListener> {
		const server = createServer((message, response) => {
			void deliver(handler, message, response).catch(() => response.destroy());
		});
		server.on("upgrade", handler.upgrade);
		await new Promise<void>((resolve, reject) => {
			const fail = (error: Error): void => reject(error);
			server.once("error", fail);
			server.listen(at.port, at.host, () => {
				server.removeListener("error", fail);
				resolve();
			});
		});
		if (context.abortSignal?.aborted) {
			server.close();
			throw context.abortSignal.reason;
		}
		const bound = server.address();
		return new NodeListener(server, { host: at.host, port: bound && typeof bound === "object" ? bound.port : at.port });
	}
	stop(): void {
		this.#server.close();
		this.#server.closeIdleConnections();
	}
	async closed(): Promise<void> {
		this.#server.close();
		this.#server.closeAllConnections();
		await this.#ended;
	}
}
export type WireRefusal = { readonly kind: "refused"; readonly status: 400 | 403 | 501 };
export type NodeRequest =
	| { readonly kind: "request"; readonly request: Request; readonly connection: Connection }
	| WireRefusal;
export class NodeIncoming implements Incoming {
	readonly method: string;
	readonly url: string;
	readonly #message: IncomingMessage;
	readonly #response: ServerResponse | undefined;
	#web: Request | undefined;
	private constructor(message: IncomingMessage, url: string, response: ServerResponse | undefined) {
		this.#message = message;
		this.#response = response;
		this.url = url;
		this.method = message.method ?? "GET";
	}
	static of(message: IncomingMessage, response?: ServerResponse): NodeIncoming | WireRefusal {
		const target = message.url ?? "";
		if (!target.startsWith("/")) return { kind: "refused", status: 403 };
		if (UNCARRIED.has(message.method ?? "GET")) return { kind: "refused", status: 501 };
		try {
			const url = new URL(`http://${message.headers.host ?? "invalid"}${target}`);
			if (url.username || url.password) return { kind: "refused", status: 403 };
			return new NodeIncoming(message, url.href, response);
		} catch {
			return { kind: "refused", status: 400 };
		}
	}
	header(name: string): string | null {
		return this.#message.headersDistinct[name]?.join(", ") ?? null;
	}
	forwarded(): boolean {
		return Object.keys(this.#message.headersDistinct).some(isForwarding);
	}
	cancelled(abort: (reason: unknown) => void): void {
		const response = this.#response;
		if (!response) return;
		const gone = (): void => abort(new Error("http: the client disconnected"));
		if (response.closed) gone();
		else
			response.once("close", () => {
				if (!response.writableFinished) gone();
			});
	}
	request(): Request {
		return (this.#web ??= toWeb(this.#message, this.url));
	}
}
export function nodeRequest(message: IncomingMessage, response: ServerResponse): NodeRequest {
	const incoming = NodeIncoming.of(message, response);
	if (!(incoming instanceof NodeIncoming)) return incoming;
	const controller = new AbortController();
	incoming.cancelled((reason) => controller.abort(reason));
	try {
		return {
			kind: "request",
			request: toWeb(message, incoming.url, controller.signal),
			connection: connectionOf(message),
		};
	} catch {
		return { kind: "refused", status: 400 };
	}
}
export function connectionOf(message: IncomingMessage): Connection {
	const socket = message.socket;
	return {
		...(socket.localAddress === undefined ? {} : { localAddress: socket.localAddress }),
		...(socket.localPort === undefined ? {} : { localPort: socket.localPort }),
		...(socket.remoteAddress === undefined ? {} : { remoteAddress: socket.remoteAddress }),
	};
}
const limit = 64 * 1024;
function hasBody(message: IncomingMessage): boolean {
	const length = message.headers["content-length"];
	return length === undefined ? message.headers["transfer-encoding"] !== undefined : Number(length) > 0;
}
function toWeb(message: IncomingMessage, url: string, signal?: AbortSignal): Request {
	const headers = new Headers();
	for (let index = 0; index < message.rawHeaders.length; index += 2)
		headers.append(message.rawHeaders[index]!, message.rawHeaders[index + 1]!);
	const init: ConstructorParameters<typeof Request>[1] & { duplex?: "half" } = {
		method: message.method ?? "GET",
		headers,
		...(signal ? { signal } : {}),
	};
	if (init.method !== "GET" && init.method !== "HEAD" && hasBody(message)) {
		init.body = body(message);
		init.duplex = "half";
	}
	return new Request(url, init);
}
function body(message: IncomingMessage): ReadableStream<Uint8Array> {
	let alive = true;
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				message.on("data", (chunk: Buffer) => {
					if (alive) {
						controller.enqueue(chunk);
						if ((controller.desiredSize ?? 0) <= 0) message.pause();
					}
				});
				message.once("end", () => {
					if (alive) controller.close();
					alive = false;
				});
				message.once("close", () => {
					if (alive && !message.complete) controller.error(new Error("http: the client disconnected"));
					alive = false;
				});
				message.pause();
			},
			pull() {
				message.resume();
			},
			cancel() {
				alive = false;
				message.pause();
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark: limit }),
	);
}
async function deliver(handler: Handler, message: IncomingMessage, response: ServerResponse): Promise<void> {
	const incoming = NodeIncoming.of(message, response);
	const served =
		incoming instanceof NodeIncoming
			? await handler.serve(incoming, connectionOf(message))
			: { answer: handler.refusal(incoming.status), finished: () => {} };
	if (response.closed) {
		served.finished();
		return;
	}
	response.once("close", served.finished);
	const length = Number(message.headers["content-length"] ?? Infinity);
	const unread = message.complete || !hasBody(message) ? "none" : length <= limit ? "drain" : "close";
	const headers: string[] = [];
	for (const [name, value] of served.answer.headers.lines()) headers.push(name, value);
	if (unread === "close") headers.push("connection", "close");
	response.writeHead(served.answer.status, headers);
	if (served.answer.body instanceof ReadableStream) await pump(served.answer.body, response);
	else response.end(served.answer.body ?? undefined);
	if (unread === "drain") {
		let size = 0;
		message.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > limit) message.socket.destroy();
		});
		message.on("error", () => message.socket.destroy());
		message.resume();
	}
}
async function pump(stream: ReadableStream<Uint8Array>, response: ServerResponse): Promise<void> {
	const reader = stream.getReader();
	const cancel = (): void => {
		void reader.cancel().catch(() => {});
	};
	response.once("close", cancel);
	for (;;) {
		let next: Awaited<ReturnType<typeof reader.read>>;
		try {
			next = await reader.read();
		} catch {
			response.destroy();
			return;
		}
		if (next.done) break;
		if (response.destroyed) return;
		if (!response.write(next.value))
			await new Promise<void>((resolve) => {
				const done = (): void => {
					response.removeListener("drain", done);
					response.removeListener("close", done);
					resolve();
				};
				response.once("drain", done);
				response.once("close", done);
			});
	}
	response.removeListener("close", cancel);
	response.end();
}
