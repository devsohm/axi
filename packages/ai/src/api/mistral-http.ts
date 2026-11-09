import type { Model, ProviderHeaders } from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import type { MistralOptions } from "./options.ts";
import { type MistralPayload, mistralWirePayload } from "./mistral-request.ts";
export interface MistralChunk {
	id?: string;
	usage?: Record<string, unknown> & { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
	choices: {
		finish_reason?: string | null;
		delta: {
			content?: string | { type: string; text?: string; thinking?: { text?: string }[] }[] | null;
			tool_calls?:
				| { id?: string; index?: number; function: { name: string; arguments: string | Record<string, unknown> } }[]
				| null;
		};
	}[];
}
class HttpError extends Error {
	readonly statusCode: number;
	readonly body: string;
	constructor(statusCode: number, body: string, statusText: string) {
		super(statusText || `Request failed with status ${statusCode}`);
		this.name = "MistralHttpError";
		this.statusCode = statusCode;
		this.body = body;
	}
}
export function mistralError(error: unknown): string {
	if (error instanceof Error) {
		const status = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
		const body = "body" in error && typeof error.body === "string" ? error.body.trim() : undefined;
		return status !== undefined
			? `Mistral API error (${status}): ${body ? (body.length <= 4000 ? body : `${body.slice(0, 4000)}... [truncated ${body.length - 4000} chars]`) : error.message}`
			: error.message;
	}
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}
function apply(headers: Headers, values?: ProviderHeaders): void {
	for (const [name, value] of Object.entries(values ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
}
export async function mistralHttp(
	model: Model<"mistral-conversations">,
	payload: MistralPayload,
	apiKey: string,
	options: MistralOptions,
): Promise<AsyncIterable<MistralChunk>> {
	const base = new URL(model.baseUrl);
	base.pathname = base.pathname.replace(/\/+$/u, "") + "/";
	const headers = new Headers({
		...getIdentityHeaders(model, options.identity),
		accept: "text/event-stream",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
	});
	apply(headers, model.headers);
	apply(headers, options.headers);
	const affinity = [model.headers, options.headers].some((values) =>
		Object.keys(values ?? {}).some((name) => name.toLowerCase() === "x-affinity"),
	);
	if (options.sessionId && options.cacheRetention !== "none" && !affinity) headers.set("x-affinity", options.sessionId);
	const timeoutMs = options.timeoutMs ?? 60000,
		timeout = AbortSignal.timeout(timeoutMs),
		combined = combineAbortSignals([options.signal, timeout]);
	let response: Response;
	try {
		response = await (options.fetch ?? globalThis.fetch)(new URL("v1/chat/completions", base), {
			method: "POST",
			headers,
			body: JSON.stringify(mistralWirePayload(payload)),
			signal: combined.signal,
		});
	} catch (error) {
		if (timeout.aborted && !options.signal?.aborted)
			throw new Error(`Mistral response headers timed out after ${timeoutMs}ms`);
		throw error;
	} finally {
		combined.cleanup();
	}
	await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	if (!response.ok) throw new HttpError(response.status, await response.text(), response.statusText);
	if (!response.body) throw new Error("Mistral response has no body");
	return events(response.body, options.signal);
}
const doneFrame = Symbol();
function parseFrame(frame: string): MistralChunk | typeof doneFrame | undefined {
	const data = frame
		.split(/\r\n|\r|\n/u)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	if (!data) return undefined;
	if (data === "[DONE]") return doneFrame;
	const parsed: unknown = JSON.parse(data);
	if (!parsed || typeof parsed !== "object" || !("choices" in parsed) || !Array.isArray(parsed.choices))
		throw new Error("Invalid Mistral streaming event");
	return parsed as MistralChunk;
}
async function* events(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<MistralChunk> {
	const reader = body.getReader(),
		decoder = new TextDecoder();
	let buffer = "";
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			if (signal?.aborted) throw signal.reason;
			const chunk = await reader.read();
			if (signal?.aborted) throw signal.reason;
			buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
			for (;;) {
				const boundary = /\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\n\r\n|\r\r|\n\r|\n\n/u.exec(buffer);
				if (!boundary) break;
				const event = parseFrame(buffer.slice(0, boundary.index));
				buffer = buffer.slice(boundary.index + boundary[0].length);
				if (event === doneFrame) return;
				if (event) yield event;
			}
			if (chunk.done) break;
		}
		if (buffer.trim()) {
			const event = parseFrame(buffer);
			if (event && event !== doneFrame) yield event;
		}
	} finally {
		signal?.removeEventListener("abort", cancel);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}
