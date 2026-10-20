import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getSystemMessageText } from "../utils/text.ts";
import {
	getDeclaredTools,
	getInitialSystemMessage,
	normalizeContext,
	resolveTranscript,
	resolveTranscriptTools,
} from "../utils/transcript.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import {
	CodexApiError,
	CodexProtocolError,
	type CodexRequest,
	codexAccount,
	codexEvents,
	codexHeaders,
	codexHttpError,
	codexRetryable,
	codexRetryDelay,
	codexSSE,
	codexTimeout,
	codexUrl,
	ProviderStreamEventCallbackError,
	RetryDelayExceededError,
} from "./openai-codex-protocol.ts";
import {
	recordWebsocketFailure,
	recordWebsocketFallback,
	runCodexWebSocket,
	websocketFallbackActive,
} from "./openai-codex-websocket.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	getResponsesToolSupport,
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import type { OpenAICodexResponsesOptions } from "./options.ts";
import { buildBaseOptions } from "./simple-options.ts";

export {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	type OpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
} from "./openai-codex-websocket.ts";
export type { OpenAICodexResponsesOptions } from "./options.ts";

const toolProviders = new Set(["openai", "openai-codex", "opencode"]);
function request(
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options: OpenAICodexResponsesOptions,
	session: string | undefined,
	grammar: ReadonlyMap<string, string>,
): CodexRequest {
	const compat = model.compat,
		additions = compat?.supportsAdditionalTools ?? false,
		search = compat?.supportsToolSearch ?? false;
	const toolOptions = {
		strict: null,
		supportsStrictMode: compat?.supportsStrictMode ?? true,
		supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
	};
	const initial = getInitialSystemMessage(context.messages);
	const body: CodexRequest = {
		model: model.id,
		store: false,
		stream: true,
		instructions: (initial && getSystemMessageText(initial)) || "You are a helpful assistant.",
		input: convertResponsesMessages(model, context, toolProviders, {
			includeSystemPrompt: false,
			grammarToolInputProperties: grammar,
			supportsMidConvoSystemMessages: compat?.supportsMidConvoSystemMessages ?? false,
			supportsAdditionalTools: additions,
			supportsToolSearch: search,
			toolOptions,
		}),
		text: { verbosity: options.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: session,
		tool_choice: options.toolChoice ?? "auto",
		parallel_tool_calls: true,
	};
	if (options.temperature !== undefined) body.temperature = options.temperature;
	if (options.serviceTier !== undefined) body.service_tier = options.serviceTier;
	const tools = resolveTranscriptTools(
		context.messages,
		getResponsesToolSupport({
			supportsMidConvoSystemMessages: compat?.supportsMidConvoSystemMessages ?? false,
			supportsAdditionalTools: additions,
			supportsToolSearch: search,
		}),
	).requestTools;
	if (tools.length) body.tools = convertResponsesTools(tools, toolOptions);
	if (options.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? model.thinkingLevelMap?.off === undefined
					? "none"
					: model.thinkingLevelMap.off
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		if (effort !== null) body.reasoning = { effort, summary: options.reasoningSummary ?? "auto" };
	} else if (model.reasoning && model.thinkingLevelMap?.off !== null)
		body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	return body;
}
function compress(json: string): Uint8Array<ArrayBuffer> | string {
	if (typeof process === "undefined" || !process.versions?.node) return json;
	const zlib = process.getBuiltinModule?.("node:zlib");
	if (typeof zlib?.zstdCompressSync !== "function") return json;
	try {
		return new Uint8Array(zlib.zstdCompressSync(json, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }));
	} catch {
		return json;
	}
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Request was aborted"));
		});
	});
}
async function http(
	url: string,
	body: string,
	headers: Headers,
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions,
	timeout: number | undefined,
): Promise<Response> {
	const encoded = compress(body);
	if (typeof encoded !== "string") headers.set("content-encoding", "zstd");
	const maximum = options.maxRetries ?? 0;
	for (let attempt = 0; attempt <= maximum; attempt++) {
		if (options.signal?.aborted) throw new Error("Request was aborted");
		try {
			const timed = timeout !== undefined && timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
			const signals = combineAbortSignals([options.signal, timed]);
			let response: Response;
			try {
				response = await (options.fetch ?? globalThis.fetch)(url, {
					method: "POST",
					headers,
					body: encoded,
					signal: signals.signal,
				});
			} catch (error) {
				if (timed?.aborted && !options.signal?.aborted)
					throw new Error(`Codex SSE response headers timed out after ${timeout}ms`);
				throw error;
			} finally {
				signals.cleanup();
			}
			await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (response.ok) return response;
			const text = await response.text();
			if (attempt < maximum && codexRetryable(response.status, text)) {
				await delay(codexRetryDelay(response.headers, options, attempt), options.signal);
				continue;
			}
			throw codexHttpError(text, response);
		} catch (cause) {
			if (cause instanceof Error && (cause.name === "AbortError" || cause.message === "Request was aborted"))
				throw new Error("Request was aborted");
			const error = cause instanceof Error ? cause : new Error(String(cause));
			if (attempt < maximum && !(error instanceof RetryDelayExceededError) && !error.message.includes("usage limit")) {
				await delay(1000 * 2 ** attempt, options.signal);
				continue;
			}
			throw error;
		}
	}
	throw new Error("Failed after retries");
}
export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model,
	context,
	options = {},
) => {
	const events = new AssistantMessageEventStream(),
		transcript = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);
	const output: AssistantMessage = {
		role: "assistant",
		api: "openai-codex-responses",
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "pending",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const finish = () => {
		if (output.stopReason === "pending") throw new Error("Codex stream ended without a stop reason");
		if (output.stopReason === "error" || output.stopReason === "aborted")
			throw new Error(output.errorMessage || "An unknown error occurred");
		events.push({ type: "done", reason: output.stopReason, message: output });
	};
	void (async () => {
		try {
			const apiKey = options.apiKey;
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const account = codexAccount(apiKey),
				session = options.cacheRetention === "none" ? undefined : options.sessionId;
			const requestId = clampOpenAIPromptCacheKey(session);
			const grammar = createGrammarToolInputProperties(
				getDeclaredTools(transcript.messages),
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			let body = request(model, transcript, options, requestId, grammar);
			const replacement = await options.onPayload?.(body, model);
			if (replacement !== undefined) body = replacement as CodexRequest;
			const wsRequestId = requestId || uuidv7();
			const sseHeaders = codexHeaders(model.headers, options.headers, account, apiKey, "sse", requestId);
			const wsHeaders = codexHeaders(model.headers, options.headers, account, apiKey, "websocket", wsRequestId);
			const json = JSON.stringify(body),
				timeout = codexTimeout(options.timeoutMs),
				connectTimeout = codexTimeout(options.websocketConnectTimeoutMs);
			const transport = options.transport || "auto";
			let started = false;
			const start = () => {
				if (!started) {
					started = true;
					events.push({ type: "start", partial: output });
				}
			};
			const consumeResponses = (input: AsyncIterable<ResponseStreamEvent>) =>
				processResponsesStream(input, output, events, model, {
					grammarToolInputProperties: grammar,
					serviceTier: options.serviceTier,
					resolveServiceTier: (received, requested) =>
						received === "default" && (requested === "flex" || requested === "priority")
							? requested
							: (received ?? requested),
					applyServiceTierPricing: (usage, tier) => {
						const factor = tier === "flex" ? 0.5 : tier === "priority" ? (model.id === "gpt-5.5" ? 2.5 : 2) : 1;
						if (factor === 1) return;
						usage.cost.input *= factor;
						usage.cost.output *= factor;
						usage.cost.cacheRead *= factor;
						usage.cost.cacheWrite *= factor;
						usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
					},
				});
			const disabled = transport !== "sse" && websocketFallbackActive(session);
			if (disabled) recordWebsocketFallback(session);
			if (transport !== "sse" && !disabled) {
				let retriedLimit = false,
					retriedContinuation = false;
				for (;;) {
					let emitted = false;
					try {
						const url = new URL(codexUrl(model.baseUrl));
						if (url.protocol === "https:") url.protocol = "wss:";
						if (url.protocol === "http:") url.protocol = "ws:";
						await runCodexWebSocket({
							url: url.toString(),
							headers: wsHeaders,
							session,
							account,
							signal: options.signal,
							connectTimeout,
							idleTimeout: timeout,
							body,
							cached: options.transport === "auto" || options.transport === "websocket-cached",
							consume: async (frames) => {
								async function* mapped(): AsyncGenerator<ResponseStreamEvent> {
									for await (const event of codexEvents(frames, output, model, options.onProviderStreamEvent)) {
										if (!emitted) {
											emitted = true;
											start();
										}
										yield event;
									}
								}
								await consumeResponses(mapped());
								return {
									responseId: output.responseId,
									items: convertResponsesMessages(model, normalizeContext({ messages: [output] }), toolProviders, {
										includeSystemPrompt: false,
										grammarToolInputProperties: grammar,
									}).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output"),
								};
							},
						});
						if (options.signal?.aborted) throw new Error("Request was aborted");
						finish();
						return;
					} catch (error) {
						const aborted = options.signal?.aborted;
						const limit =
							!emitted && error instanceof CodexApiError && error.code === "websocket_connection_limit_reached";
						if (
							!aborted &&
							error instanceof CodexApiError &&
							error.code === "previous_response_not_found" &&
							!retriedContinuation
						) {
							retriedContinuation = true;
							continue;
						}
						if (!aborted && limit && !retriedLimit) {
							retriedLimit = true;
							continue;
						}
						if (
							aborted ||
							(!limit &&
								(error instanceof CodexApiError ||
									error instanceof CodexProtocolError ||
									error instanceof ProviderStreamEventCallbackError))
						)
							throw error;
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport: transport,
								...(emitted ? {} : { fallbackTransport: "sse" }),
								eventsEmitted: emitted,
								phase: emitted ? "after_message_stream_start" : "before_message_stream_start",
								requestBytes: new TextEncoder().encode(json).byteLength,
							}),
						);
						recordWebsocketFailure(session, error);
						if (emitted) throw error;
						recordWebsocketFallback(session);
						break;
					}
				}
			}
			const response = await http(codexUrl(model.baseUrl), json, sseHeaders, model, options, timeout);
			if (!response.body) throw new Error("No response body");
			start();
			await consumeResponses(
				codexEvents(codexSSE(response, options.signal), output, model, options.onProviderStreamEvent),
			);
			if (options.signal?.aborted) throw new Error("Request was aborted");
			finish();
		} catch (error) {
			for (const block of output.content) {
				Reflect.deleteProperty(block, "partialJson");
				Reflect.deleteProperty(block, "customInput");
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			events.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			events.end();
		}
	})();
	return events;
};
export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model,
	context,
	options,
) => {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	};
	const level = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return stream(model, context, {
		...base,
		reasoningEffort: level === "off" ? undefined : level,
	});
};
