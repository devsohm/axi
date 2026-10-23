import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
	Tool,
} from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AssistantMessage, Model, ProviderHeaders, StreamOptions } from "../types.ts";
import { formatThrownValue } from "../utils/diagnostics.ts";
import type { OpenAICodexResponsesOptions } from "./options.ts";

export interface CodexRequest {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: Tool[];
	tool_choice?: OpenAICodexResponsesOptions["toolChoice"];
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}
export class CodexApiError extends Error {
	readonly code?: string;
	readonly payload: Record<string, unknown>;
	constructor(message: string, code: string | undefined, payload: Record<string, unknown>) {
		super(message);
		this.name = "CodexApiError";
		this.code = code;
		this.payload = payload;
	}
}
export class CodexProtocolError extends Error {
	readonly payload: unknown;
	constructor(message: string, payload: unknown, cause: unknown) {
		super(message, { cause });
		this.name = "CodexProtocolError";
		this.payload = payload;
	}
}
export class ProviderStreamEventCallbackError extends Error {
	constructor(cause: unknown) {
		super(formatThrownValue(cause), { cause });
		this.name = "ProviderStreamEventCallbackError";
	}
}
const recordSchema = Type.Record(Type.String(), Type.Unknown());
export function parseCodexFrame(text: string, transport: "SSE" | "WebSocket"): Record<string, unknown> {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (cause) {
		throw new CodexProtocolError(`Invalid Codex ${transport} JSON: ${formatThrownValue(cause)}`, text, cause);
	}
}
function record(value: unknown): Record<string, unknown> | undefined {
	return Value.Check(recordSchema, value) ? value : undefined;
}
function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function status(value: unknown): string | undefined {
	return typeof value === "string" &&
		["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"].includes(value)
		? value
		: undefined;
}
export async function* codexEvents(
	events: AsyncIterable<Record<string, unknown>>,
	output: AssistantMessage,
	model: Model<"openai-codex-responses">,
	observer: StreamOptions["onProviderStreamEvent"],
): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		try {
			await observer?.(event, model);
		} catch (cause) {
			throw new ProviderStreamEventCallbackError(cause);
		}
		if (typeof event.type !== "string" || !event.type) continue;
		const nested = record(event.error),
			response = record(event.response);
		if (event.type === "error") {
			const code = string(event.code) ?? string(nested?.code),
				message = string(event.message) ?? string(nested?.message);
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, code, event);
		}
		if (event.type === "response.failed") {
			const error = record(response?.error);
			throw new CodexApiError(string(error?.message) || "Codex response failed", string(error?.code), event);
		}
		if (["response.done", "response.completed", "response.incomplete"].includes(event.type)) {
			if (typeof response?.end_turn === "boolean") output.endTurn = response.end_turn;
			yield {
				...event,
				type: "response.completed",
				response: response ? { ...response, status: status(response.status) } : response,
			} as unknown as ResponseStreamEvent;
			return;
		}
		yield event as unknown as ResponseStreamEvent;
	}
}
export async function* codexSSE(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;
	const reader = response.body.getReader(),
		decoder = new TextDecoder();
	let buffer = "";
	const cancelled = () => {
		if (signal?.aborted) throw new Error("Request was aborted");
	};
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			cancelled();
			const next = await reader.read();
			cancelled();
			buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
			if (next.done && buffer.trim()) buffer += "\n\n";
			for (;;) {
				const end = buffer.indexOf("\n\n");
				if (end === -1) break;
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const text = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("\n")
					.trim();
				if (text && text !== "[DONE]") yield parseCodexFrame(text, "SSE");
			}
			if (next.done) return;
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}
export function codexAccount(token: string): unknown {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = record(JSON.parse(atob(parts[1] ?? "")));
		const account = record(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
		if (account) return account;
	} catch {}
	throw new Error("Failed to extract accountId from token");
}
export function codexUrl(base: string): string {
	const root = (base.trim() ? base : "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	return root.endsWith("/codex/responses")
		? root
		: root.endsWith("/codex")
			? `${root}/responses`
			: `${root}/codex/responses`;
}
export function codexHeaders(
	defaults: Record<string, string>,
	model: Record<string, string> | undefined,
	overrides: ProviderHeaders | undefined,
	account: unknown,
	token: string,
	transport: "sse" | "websocket",
	session?: string,
): Headers {
	const headers = new Headers(defaults);
	for (const [name, value] of Object.entries(model ?? {})) headers.set(name, value);
	for (const [name, value] of Object.entries(overrides ?? {}))
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", String(account));
	headers.set("OpenAI-Beta", transport === "sse" ? "responses=experimental" : "responses_websockets=2026-02-06");
	if (transport === "sse") {
		headers.set("accept", "text/event-stream");
		headers.set("content-type", "application/json");
	} else {
		headers.delete("accept");
		headers.delete("content-type");
	}
	if (session) {
		headers.set("session-id", session);
		headers.set("x-client-request-id", session);
	}
	return headers;
}
export function codexTimeout(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid timeoutMs: ${String(value)}`);
	return Math.floor(value);
}
export class RetryDelayExceededError extends Error {}
export function codexRetryDelay(headers: Headers, options: StreamOptions, attempt: number): number {
	const millis = headers.get("retry-after-ms");
	let delay: number | undefined;
	if (millis !== null && Number.isFinite(Number(millis))) delay = Math.max(0, Number(millis));
	if (delay === undefined) {
		const seconds = headers.get("retry-after");
		if (seconds) {
			const value = Number(seconds);
			const parsed = Number.isFinite(value) ? value * 1000 : Date.parse(seconds) - Date.now();
			if (Number.isFinite(parsed)) delay = Math.max(0, parsed);
		}
	}
	if (delay === undefined) return 1000 * 2 ** attempt;
	const maximum = options.maxRetryDelayMs ?? 60_000;
	if (maximum > 0 && delay > maximum)
		throw new RetryDelayExceededError(
			`Server requested ${Math.ceil(delay / 1000)}s retry delay (max: ${Math.ceil(maximum / 1000)}s)`,
		);
	return delay;
}
export function codexRetryable(status: number, text: string): boolean {
	if (
		status === 429 &&
		/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
			text,
		)
	)
		return false;
	return (
		[429, 500, 502, 503, 504].includes(status) ||
		/rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(text)
	);
}
export function codexHttpError(raw: string, response: Response): Error {
	let message = raw || response.statusText || "Request failed";
	try {
		const error = record(record(JSON.parse(raw))?.error);
		if (error) {
			const code = string(error.code) || string(error.type) || "";
			let friendly: string | undefined;
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan =
					typeof error.plan_type === "string" && error.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
				const when =
					typeof error.resets_at === "number" && error.resets_at
						? ` Try again in ~${Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60000))} min.`
						: "";
				friendly = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = friendly || string(error.message) || message;
		}
	} catch {}
	return new Error(message);
}
