import { getIdentityHeaders } from "../utils/identity.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	JsonObject,
	JsonValue,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	ToolCall,
} from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import type { AxiMessagesOptions } from "./options.ts";

export type { AxiMessagesOptions } from "./options.ts";
export type AxiMessagesRewriteImpact = {
	policyId: string;
	policyVersion: number;
	changed: boolean;
	tokenCountChange: number;
	messageCountChange: number;
	systemPromptChanged: boolean;
};
export type AxiMessagesEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
	| { type: "thinking_end"; contentIndex: number; content: string; contentSignature?: string; redacted?: boolean }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| {
			type: "done";
			reason: "stop" | "length" | "toolUse";
			usage: AssistantMessage["usage"];
			responseId?: string;
			responseModel?: string;
			providerThinkingLevel?: string;
			rewrite?: AxiMessagesRewriteImpact;
	  }
	| {
			type: "error";
			reason: "error" | "aborted";
			usage: AssistantMessage["usage"];
			errorMessage?: string;
			responseId?: string;
			responseModel?: string;
			providerThinkingLevel?: string;
			rewrite?: AxiMessagesRewriteImpact;
	  };
export class AxiMessagesResponseError extends Error {
	code?: string;
	readonly diagnosticDetails: JsonObject;
	constructor(message: string, code: string | undefined, details: JsonObject) {
		super(message);
		this.name = "AxiMessagesResponseError";
		this.code = code;
		this.diagnosticDetails = details;
	}
}
function empty(model: Model<"axi-messages">): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		content: [],
		stopReason: "pending",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function failure(model: Model<"axi-messages">, url: URL, response: Response, body: string): AxiMessagesResponseError {
	let details: Record<string, JsonValue> | undefined;
	try {
		const value = JSON.parse(body);
		if (value?.error && typeof value.error === "object" && !Array.isArray(value.error)) details = value.error;
	} catch {}
	const code = typeof details?.code === "string" ? details.code : undefined;
	return new AxiMessagesResponseError(
		`${response.status} ${response.statusText}: ${typeof details?.message === "string" ? details.message : body}${code ? ` (${code})` : ""}`,
		code,
		{
			version: 1,
			provider: model.provider,
			model: model.id,
			url: String(url),
			status: response.status,
			statusText: response.statusText,
			...(details ? { error: details } : { body: body.length > 8192 ? `${body.slice(0, 8192)}…` : body }),
			timestampMs: Date.now(),
		},
	);
}
function converter(model: Model<"axi-messages">): (event: AxiMessagesEvent) => AssistantMessageEvent {
	const partial = empty(model),
		argumentsByIndex = new Map<number, string>();
	return (event) => {
		switch (event.type) {
			case "done":
			case "error": {
				Object.assign(partial, { stopReason: event.reason, usage: event.usage, responseId: event.responseId });
				if (event.responseModel !== undefined) partial.responseModel = event.responseModel;
				if (event.type === "error") partial.errorMessage = event.errorMessage;
				if (event.providerThinkingLevel !== undefined) partial.providerThinkingLevel = event.providerThinkingLevel;
				if (event.rewrite)
					appendAssistantMessageDiagnostic(partial, {
						type: "axi_messages_rewrite",
						timestamp: Date.now(),
						details: { ...event.rewrite },
					});
				return event.type === "done"
					? { type: "done", reason: event.reason, message: partial }
					: { type: "error", reason: event.reason, error: partial };
			}
			case "start":
				break;
			case "text_start":
				partial.content[event.contentIndex] = { type: "text", text: "" };
				break;
			case "thinking_start":
				partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
				break;
			case "text_delta":
				(partial.content[event.contentIndex] as { text: string }).text += event.delta;
				break;
			case "thinking_delta":
				(partial.content[event.contentIndex] as { thinking: string }).thinking += event.delta;
				break;
			case "text_end":
				Object.assign(partial.content[event.contentIndex]!, {
					text: event.content,
					textSignature: event.contentSignature,
				});
				break;
			case "thinking_end":
				Object.assign(partial.content[event.contentIndex]!, {
					thinking: event.content,
					thinkingSignature: event.contentSignature,
					redacted: event.redacted,
				});
				break;
			case "toolcall_start":
				partial.content[event.contentIndex] = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
				argumentsByIndex.set(event.contentIndex, "");
				break;
			case "toolcall_delta": {
				const json = (argumentsByIndex.get(event.contentIndex) ?? "") + event.delta;
				argumentsByIndex.set(event.contentIndex, json);
				(partial.content[event.contentIndex] as ToolCall).arguments = parseStreamingJson(json);
				break;
			}
			case "toolcall_end": {
				const call = partial.content[event.contentIndex] as ToolCall;
				Object.assign(call, event.toolCall);
				argumentsByIndex.delete(event.contentIndex);
				return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: call, partial };
			}
		}
		return { ...event, partial } as AssistantMessageEvent;
	};
}
async function* wireEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AxiMessagesEvent> {
	const reader = body.getReader(),
		decoder = new TextDecoder();
	let buffer = "";
	const parse = (frame: string): AxiMessagesEvent | undefined => {
		const data = frame
			.split("\n")
			.find((line) => line.startsWith("data:"))
			?.slice(5)
			.trim();
		return data && data !== "[DONE]" ? (JSON.parse(data) as AxiMessagesEvent) : undefined;
	};
	try {
		for (;;) {
			const next = await reader.read();
			buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");
			for (let split = buffer.indexOf("\n\n"); split >= 0; split = buffer.indexOf("\n\n")) {
				const event = parse(buffer.slice(0, split));
				if (event) yield event;
				buffer = buffer.slice(split + 2);
			}
			if (next.done) break;
		}
		if (buffer.trim()) {
			const event = parse(buffer);
			if (event) yield event;
		}
	} finally {
		reader.releaseLock();
	}
}
export const stream: StreamFunction<"axi-messages", AxiMessagesOptions> = (model, context, options = {}) => {
	const output = new AssistantMessageEventStream(),
		convert = converter(model);
	void (async () => {
		try {
			const apiKey = options.apiKey;
			if (!apiKey) throw new Error(`No API key provided for provider "${model.provider}"`);
			const url = new URL(`${model.baseUrl.replace(/\/+$/u, "")}/messages`);
			if (options.debug) url.searchParams.set("debug", "1");
			let payload: unknown = {
				model: model.id,
				context,
				options: {
					temperature: options.temperature,
					maxTokens: options.maxTokens,
					reasoning: options.reasoning,
					cacheRetention:
						options.cacheRetention ??
						(getProviderEnvValue("AXI_CACHE_RETENTION", options.env) === "long" ? "long" : undefined),
					sessionId: options.sessionId,
					toolChoice: options.toolChoice,
				},
			};
			const replacement = await options.onPayload?.(payload, model);
			if (replacement !== undefined) payload = replacement;
			const response = await (options.fetch ?? globalThis.fetch)(url, {
				method: "POST",
				headers: providerHeadersToRecord(
					getIdentityHeaders(model, options.identity),
					{
						authorization: `Bearer ${apiKey}`,
						accept: "text/event-stream",
						"content-type": "application/json",
					},
					options.headers,
				),
				body: JSON.stringify(payload),
				signal: options.signal,
			});
			await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (!response.ok) throw failure(model, url, response, await response.text());
			if (!response.body) throw new Error(`${model.provider} response has no body`);
			for await (const raw of wireEvents(response.body)) {
				await options.onProviderStreamEvent?.(raw, model);
				const event = convert(raw);
				output.push(event);
				if (event.type === "done" || event.type === "error") return;
			}
			throw new Error(`${model.provider} stream ended without a terminal event`);
		} catch (error) {
			const failed = empty(model);
			failed.stopReason = options.signal?.aborted ? "aborted" : "error";
			failed.errorMessage = error instanceof Error ? error.message : String(error);
			if (failed.stopReason !== "aborted" && error instanceof AxiMessagesResponseError)
				appendAssistantMessageDiagnostic(
					failed,
					createAssistantMessageDiagnostic("axi_messages_response_failure", error, error.diagnosticDetails),
				);
			output.push({ type: "error", reason: failed.stopReason, error: failed });
		} finally {
			output.end();
		}
	})();
	return output;
};
export const streamSimple: StreamFunction<"axi-messages", SimpleStreamOptions> = (model, context, options) =>
	stream(model, context, {
		...options,
		reasoning: options?.reasoning,
		toolChoice: options?.toolChoice,
		debug: (options as AxiMessagesOptions | undefined)?.debug,
	});
