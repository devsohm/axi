import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { Api, AssistantMessage, Model, StreamOptions } from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { type OpenAIResponsesStreamOptions, processResponsesStream } from "./openai-responses-shared.ts";

interface PreparedRequest {
	client: Pick<OpenAI, "responses">;
	body: ResponseCreateParamsStreaming;
	parsing?: OpenAIResponsesStreamOptions;
}
export function createResponsesRequest<A extends Api>({
	model,
	options,
	label,
	errorPrefix,
	prepare,
	providerThinkingLevel,
	formatError,
}: {
	model: Model<A>;
	options: StreamOptions;
	label: string;
	errorPrefix: string;
	prepare: () => PreparedRequest;
	providerThinkingLevel?: string;
	formatError?: (message: string) => string;
}): AssistantMessageEventStream {
	const events = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		...(providerThinkingLevel === undefined ? {} : { providerThinkingLevel }),
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
	void (async () => {
		try {
			const prepared = prepare();
			const replacement = await options.onPayload?.(prepared.body, model);
			const body = replacement === undefined ? prepared.body : (replacement as ResponseCreateParamsStreaming);
			const requestOptions = {
				...(options.signal ? { signal: options.signal } : {}),
				...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data, response } = await retryProviderRequest(
				() => prepared.client.responses.create(body, requestOptions).withResponse(),
				{ maxRetries: options.maxRetries, maxRetryDelayMs: options.maxRetryDelayMs, signal: options.signal },
			);
			await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			events.push({ type: "start", partial: output });
			await processResponsesStream(data, output, events, model, {
				...prepared.parsing,
				onProviderStreamEvent: options.onProviderStreamEvent,
			});
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") throw new Error(`${label} Responses stream ended without a stop reason`);
			if (output.stopReason === "error" || output.stopReason === "aborted")
				throw new Error(output.errorMessage || "An unknown error occurred");
			events.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			for (const block of output.content)
				for (const field of ["index", "partialJson", "customInput"]) Reflect.deleteProperty(block, field);
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			const message = formatProviderError(normalizeProviderError(error), errorPrefix);
			output.errorMessage = formatError ? formatError(message) : message;
			events.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			events.end();
		}
	})();
	return events;
}
