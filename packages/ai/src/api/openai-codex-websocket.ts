import type { ResponseInput } from "openai/resources/responses/responses.js";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import { formatThrownValue } from "../utils/diagnostics.ts";
import { headersToRecord } from "../utils/headers.ts";
import { CodexProtocolError, type CodexRequest, parseCodexFrame } from "./openai-codex-protocol.ts";

type Listener = (event: unknown) => void;
interface Socket {
	close(code?: number, reason?: string): void;
	send(message: string): void;
	addEventListener(type: string, listener: Listener): void;
	removeEventListener(type: string, listener: Listener): void;
}
interface Continuation {
	body: CodexRequest;
	responseId: string;
	items: ResponseInput;
}
interface Entry {
	socket: Socket;
	busy: boolean;
	created: number;
	timer?: ReturnType<typeof setTimeout>;
	continuation?: Continuation;
}
export interface OpenAICodexWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}
const sessions = new Map<string, Map<unknown, Entry>>();
const statistics = new Map<string, OpenAICodexWebSocketDebugStats>();
const fallback = new Set<string>();
function stats(session: string): OpenAICodexWebSocketDebugStats {
	let value = statistics.get(session);
	if (!value) {
		value = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		statistics.set(session, value);
	}
	return value;
}
export function getOpenAICodexWebSocketDebugStats(session: string): OpenAICodexWebSocketDebugStats | undefined {
	const value = statistics.get(session);
	return value ? { ...value } : undefined;
}
export function resetOpenAICodexWebSocketDebugStats(session?: string): void {
	if (session) {
		statistics.delete(session);
		fallback.delete(session);
	} else {
		statistics.clear();
		fallback.clear();
	}
}
function close(socket: Socket, reason = "done"): void {
	try {
		socket.close(1000, reason);
	} catch {}
}
export function closeOpenAICodexWebSocketSessions(session?: string): void {
	const selected = session
		? (sessions.get(session)?.values() ?? [])
		: [...sessions.values()].flatMap((accounts) => [...accounts.values()]);
	for (const entry of selected) {
		if (entry.timer) clearTimeout(entry.timer);
		close(entry.socket, "debug_close");
	}
	if (session) sessions.delete(session);
	else sessions.clear();
}
registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);
export function websocketFallbackActive(session: string | undefined): boolean {
	return !!session && fallback.has(session);
}
export function recordWebsocketFallback(session: string | undefined): void {
	if (session) {
		const value = stats(session);
		value.sseFallbacks++;
		value.websocketFallbackActive = fallback.has(session);
	}
}
export function recordWebsocketFailure(session: string | undefined, error: unknown): void {
	if (!session) return;
	fallback.add(session);
	const value = stats(session);
	value.websocketFailures++;
	value.lastWebSocketError = formatThrownValue(error);
	value.websocketFallbackActive = true;
}
function isSocket(value: unknown): value is Socket {
	return (
		typeof value === "object" &&
		value !== null &&
		"close" in value &&
		typeof value.close === "function" &&
		"send" in value &&
		typeof value.send === "function" &&
		"addEventListener" in value &&
		typeof value.addEventListener === "function" &&
		"removeEventListener" in value &&
		typeof value.removeEventListener === "function"
	);
}
function reusable(socket: Socket): boolean {
	return !("readyState" in socket) || typeof socket.readyState !== "number" || socket.readyState === 1;
}
function socketError(event: unknown): Error {
	if (event && typeof event === "object") {
		if ("message" in event && typeof event.message === "string" && event.message) return new Error(event.message);
		if ("error" in event) {
			const nested = event.error;
			if (nested instanceof Error && nested.message) return nested;
			if (
				nested &&
				typeof nested === "object" &&
				"message" in nested &&
				typeof nested.message === "string" &&
				nested.message
			)
				return new Error(nested.message);
		}
	}
	return new Error("WebSocket error");
}
class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;
	constructor(code: number | undefined, reason: string | undefined, wasClean: boolean | undefined) {
		super(
			`WebSocket closed${code === undefined ? "" : ` ${code}`}${reason ? ` ${reason}` : code === 1009 ? " message too big" : ""}`.trim(),
		);
		this.name = "WebSocketCloseError";
		this.code = code;
		this.reason = reason;
		this.wasClean = wasClean;
	}
}
function closeError(event: unknown): Error {
	if (!event || typeof event !== "object") return new Error("WebSocket closed");
	return new WebSocketCloseError(
		"code" in event && typeof event.code === "number" ? event.code : undefined,
		"reason" in event && typeof event.reason === "string" && event.reason ? event.reason : undefined,
		"wasClean" in event && typeof event.wasClean === "boolean" ? event.wasClean : undefined,
	);
}
async function connect(
	url: string,
	headers: Headers,
	signal: AbortSignal | undefined,
	timeout = 15_000,
): Promise<Socket> {
	const socketConstructor: unknown = globalThis.WebSocket;
	if (typeof socketConstructor !== "function") throw new Error("WebSocket transport is not available in this runtime");
	const options = headersToRecord(headers);
	delete options["OpenAI-Beta"];
	return new Promise((resolve, reject) => {
		let socket: Socket;
		try {
			const value: unknown = Reflect.construct(socketConstructor, [url, { headers: options }]);
			if (!isSocket(value)) throw new Error("WebSocket constructor returned an invalid socket");
			socket = value;
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		let settled = false,
			timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			socket.removeEventListener("open", opened);
			socket.removeEventListener("error", errored);
			socket.removeEventListener("close", closed);
			signal?.removeEventListener("abort", aborted);
		};
		const fail = (error: Error, reason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (reason) close(socket, reason);
			reject(error);
		};
		const opened = () => {
			if (!settled) {
				settled = true;
				cleanup();
				resolve(socket);
			}
		};
		const errored: Listener = (event) => fail(socketError(event));
		const closed: Listener = (event) => fail(closeError(event));
		const aborted = () => fail(new Error("Request was aborted"), "aborted");
		socket.addEventListener("open", opened);
		socket.addEventListener("error", errored);
		socket.addEventListener("close", closed);
		signal?.addEventListener("abort", aborted);
		if (timeout > 0)
			timer = setTimeout(
				() => fail(new Error(`WebSocket connect timeout after ${timeout}ms`), "connect_timeout"),
				timeout,
			);
		if (signal?.aborted) aborted();
	});
}
function removeEntry(session: string, account: unknown, entry: Entry): void {
	if (entry.timer) clearTimeout(entry.timer);
	const accounts = sessions.get(session);
	if (accounts?.get(account) === entry) accounts.delete(account);
	if (!accounts?.size) sessions.delete(session);
}
interface Lease {
	socket: Socket;
	entry?: Entry;
	reused: boolean;
	release(keep: boolean): void;
}
async function acquire(
	url: string,
	headers: Headers,
	session: string | undefined,
	account: unknown,
	signal: AbortSignal | undefined,
	timeout: number | undefined,
): Promise<Lease> {
	let entry = session ? sessions.get(session)?.get(account) : undefined;
	if (entry?.timer) {
		clearTimeout(entry.timer);
		entry.timer = undefined;
	}
	if (session && entry && !entry.busy && (Date.now() - entry.created >= 55 * 60_000 || !reusable(entry.socket))) {
		close(entry.socket, Date.now() - entry.created >= 55 * 60_000 ? "connection_age_limit" : "done");
		removeEntry(session, account, entry);
		entry = undefined;
	}
	const reused = !!entry && !entry.busy;
	if (!session || entry?.busy) {
		const socket = await connect(url, headers, signal, timeout);
		return { socket, reused: false, release: () => close(socket) };
	}
	if (!entry) {
		entry = { socket: await connect(url, headers, signal, timeout), busy: true, created: Date.now() };
		let accounts = sessions.get(session);
		if (!accounts) {
			accounts = new Map();
			sessions.set(session, accounts);
		}
		accounts.set(account, entry);
	}
	const owned = entry;
	owned.busy = true;
	return {
		socket: owned.socket,
		entry: owned,
		reused,
		release: (keep) => {
			if (!keep || !reusable(owned.socket)) {
				close(owned.socket);
				removeEntry(session, account, owned);
				return;
			}
			owned.busy = false;
			owned.timer = setTimeout(() => {
				if (!owned.busy) {
					close(owned.socket, "idle_timeout");
					removeEntry(session, account, owned);
				}
			}, 5 * 60_000);
		},
	};
}
async function decode(data: unknown): Promise<string | undefined> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data))
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	if (data && typeof data === "object" && "arrayBuffer" in data && typeof data.arrayBuffer === "function") {
		const bytes: unknown = await data.arrayBuffer();
		if (bytes instanceof ArrayBuffer) return new TextDecoder().decode(bytes);
	}
	return undefined;
}
async function* frames(
	socket: Socket,
	signal: AbortSignal | undefined,
	timeout: number | undefined,
): AsyncGenerator<Record<string, unknown>> {
	const queue: Record<string, unknown>[] = [];
	let wake: (() => void) | undefined,
		stopped = false,
		terminal = false,
		failure: Error | undefined;
	const notify = () => {
		wake?.();
		wake = undefined;
	};
	const message: Listener = (event) => {
		void (async () => {
			let text: string | undefined;
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				text = await decode(event.data);
				if (!text) return;
				const value = parseCodexFrame(text, "WebSocket");
				if (["response.completed", "response.done", "response.incomplete"].includes(String(value.type))) {
					terminal = true;
					stopped = true;
				}
				queue.push(value);
				notify();
			} catch (error) {
				failure =
					error instanceof CodexProtocolError
						? error
						: new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(error)}`, text, error);
				stopped = true;
				notify();
			}
		})();
	};
	const error: Listener = (event) => {
		failure = socketError(event);
		stopped = true;
		notify();
	};
	const closed: Listener = (event) => {
		if (!terminal && !failure) failure = closeError(event);
		stopped = true;
		notify();
	};
	const abort = () => {
		failure = new Error("Request was aborted");
		stopped = true;
		notify();
	};
	socket.addEventListener("message", message);
	socket.addEventListener("error", error);
	socket.addEventListener("close", closed);
	signal?.addEventListener("abort", abort);
	try {
		for (;;) {
			if (signal?.aborted) throw new Error("Request was aborted");
			if (queue.length) {
				yield queue.shift()!;
				continue;
			}
			if (stopped) break;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await new Promise<void>((resolve, reject) => {
					wake = resolve;
					if (timeout !== undefined && timeout > 0)
						timer = setTimeout(() => {
							failure = new Error(`WebSocket idle timeout after ${timeout}ms`);
							stopped = true;
							wake = undefined;
							close(socket, "idle_timeout");
							reject(failure);
						}, timeout);
				});
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		if (failure) throw failure;
		if (!terminal) throw new Error("WebSocket stream closed before response.completed");
	} finally {
		socket.removeEventListener("message", message);
		socket.removeEventListener("error", error);
		socket.removeEventListener("close", closed);
		signal?.removeEventListener("abort", abort);
	}
}
function continuationBody(body: CodexRequest, previous: Continuation | undefined): CodexRequest {
	if (!previous) return body;
	const withoutInput = ({ input: _input, previous_response_id: _response, ...rest }: CodexRequest) => rest;
	const baseline = [...(previous.body.input ?? []), ...previous.items],
		current = body.input ?? [];
	if (
		JSON.stringify(withoutInput(body)) !== JSON.stringify(withoutInput(previous.body)) ||
		current.length < baseline.length ||
		JSON.stringify(current.slice(0, baseline.length)) !== JSON.stringify(baseline) ||
		!previous.responseId
	)
		return body;
	return { ...body, previous_response_id: previous.responseId, input: current.slice(baseline.length) };
}
export async function runCodexWebSocket({
	url,
	headers,
	session,
	account,
	signal,
	connectTimeout,
	idleTimeout,
	body,
	cached,
	consume,
}: {
	url: string;
	headers: Headers;
	session: string | undefined;
	account: unknown;
	signal: AbortSignal | undefined;
	connectTimeout: number | undefined;
	idleTimeout: number | undefined;
	body: CodexRequest;
	cached: boolean;
	consume(events: AsyncIterable<Record<string, unknown>>): Promise<{ responseId?: string; items: ResponseInput }>;
}): Promise<void> {
	const lease = await acquire(url, headers, session, account, signal, connectTimeout);
	const request = cached && lease.entry ? continuationBody(body, lease.entry.continuation) : body;
	if (cached && lease.entry && request === body) lease.entry.continuation = undefined;
	if (session) {
		const value = stats(session);
		value.requests++;
		if (lease.reused) value.connectionsReused++;
		else value.connectionsCreated++;
		if (cached) value.cachedContextRequests++;
		if (request.store === true) value.storeTrueRequests++;
		value.lastInputItems = request.input?.length ?? 0;
		if (request.previous_response_id) {
			value.deltaRequests++;
			value.lastDeltaInputItems = request.input?.length ?? 0;
			value.lastPreviousResponseId = request.previous_response_id;
		} else {
			value.fullContextRequests++;
			value.lastDeltaInputItems = undefined;
			value.lastPreviousResponseId = undefined;
		}
	}
	let keep = true;
	try {
		lease.socket.send(JSON.stringify({ type: "response.create", ...request }));
		const result = await consume(frames(lease.socket, signal, idleTimeout));
		if (signal?.aborted) keep = false;
		else if (cached && lease.entry && result.responseId)
			lease.entry.continuation = { body, responseId: result.responseId, items: result.items };
	} catch (error) {
		keep = false;
		if (lease.entry) lease.entry.continuation = undefined;
		throw error;
	} finally {
		lease.release(keep);
	}
}
