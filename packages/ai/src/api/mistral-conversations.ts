import { clampThinkingLevel } from "../models.ts";
import type { AssistantMessage, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { resolveTranscript } from "../utils/transcript.ts";
import { mistralError, mistralHttp } from "./mistral-http.ts";
import { type MistralPayload, mistralRequest } from "./mistral-request.ts";
import { consumeMistral } from "./mistral-stream.ts";
import type { MistralOptions } from "./options.ts";
import { buildBaseOptions } from "./simple-options.ts";

export type { MistralOptions } from "./options.ts";
export const stream: StreamFunction<"mistral-conversations", MistralOptions> = (model, context, options = {}) => {
	const transcript = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages),
		events = new AssistantMessageEventStream();
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			timestamp: Date.now(),
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
		try {
			const apiKey = options.apiKey;
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const params = mistralRequest(model, transcript, options),
				replacement = await options.onPayload?.(params, model);
			const source = await mistralHttp(
				model,
				replacement === undefined ? params : (replacement as MistralPayload),
				apiKey,
				options,
			);
			events.push({ type: "start", partial: output });
			await consumeMistral(source, model, output, events, options.onProviderStreamEvent);
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") throw new Error("Mistral stream ended without a finish reason");
			if (output.stopReason === "aborted" || output.stopReason === "error")
				throw new Error(output.errorMessage || "An unknown error occurred");
			events.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			for (const block of output.content) Reflect.deleteProperty(block, "partialArgs");
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = mistralError(error);
			events.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			events.end();
		}
	})();
	return events;
};
export const streamSimple: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
	model,
	context,
	options = {},
) => {
	const apiKey = options.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options.toolChoice,
	};
	const selected = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined,
		level = selected === "off" ? undefined : selected;
	const map = model.reasoning ? model.thinkingLevelMap : undefined;
	return stream(model, context, {
		...base,
		promptMode: model.reasoning && !map && level ? "reasoning" : undefined,
		reasoningEffort: (map
			? level
				? (map[level] ?? "high")
				: (map.off ?? undefined)
			: undefined) as MistralOptions["reasoningEffort"],
	});
};
