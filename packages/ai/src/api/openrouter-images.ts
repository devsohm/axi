import { getIdentityHeaders } from "../utils/identity.ts";
import OpenAI from "openai";
import type {
	ChatCompletionContentPart,
	ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions.js";
import type { AssistantImages, ImagesFunction, ImagesOptions, Usage } from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

export const generateImages: ImagesFunction<ImagesOptions> = async (model, context, options = {}) => {
	const result: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: "stop",
		output: [],
	};
	try {
		const apiKey = options.apiKey;
		if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		const client = new OpenAI({
			apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch: options.fetch,
			defaultHeaders: providerHeadersToRecord(
				getIdentityHeaders(model, options.identity),
				model.headers,
				options.headers,
			),
		});
		const content: ChatCompletionContentPart[] = context.input.map((block) =>
			block.type === "text"
				? { type: "text", text: sanitizeSurrogates(block.text) }
				: { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
		);
		const body = {
			model: model.id,
			stream: false as const,
			messages: [{ role: "user" as const, content }],
			modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
		};
		const replacement = await options.onPayload?.(body, model);
		const request = (replacement === undefined ? body : replacement) as ChatCompletionCreateParamsNonStreaming;
		const requestOptions = {
			...(options.signal ? { signal: options.signal } : {}),
			...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: 0,
		};
		const { data, response } = await retryProviderRequest(
			() => client.chat.completions.create(request, requestOptions).withResponse(),
			{
				maxRetries: options.maxRetries,
				maxRetryDelayMs: options.maxRetryDelayMs,
				signal: options.signal,
			},
		);
		await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		result.responseId = data.id;
		if (data.usage) {
			const raw = data.usage as typeof data.usage & { prompt_tokens_details?: { cache_write_tokens?: number } };
			const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens || 0;
			const cached = raw.prompt_tokens_details?.cached_tokens || 0;
			const cacheRead = cacheWrite > 0 ? Math.max(0, cached - cacheWrite) : cached;
			const input = Math.max(0, (raw.prompt_tokens || 0) - cacheRead - cacheWrite),
				output = raw.completion_tokens || 0;
			const usage: Usage = {
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output + cacheRead + cacheWrite,
				cost: {
					input: (model.cost.input / 1_000_000) * input,
					output: (model.cost.output / 1_000_000) * output,
					cacheRead: (model.cost.cacheRead / 1_000_000) * cacheRead,
					cacheWrite: (model.cost.cacheWrite / 1_000_000) * cacheWrite,
					total: 0,
					totalFromProvider: false,
				},
			};
			usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
			result.usage = usage;
		}
		const message:
			| ((typeof data.choices)[number]["message"] & { images?: { image_url?: string | { url?: string } }[] })
			| undefined = data.choices[0]?.message;
		if (typeof message?.content === "string" && message.content.length)
			result.output.push({ type: "text", text: message.content });
		if (message)
			for (const image of message.images ?? []) {
				const url = typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
				if (!url?.startsWith("data:")) continue;
				const parts = url.match(/^data:([^;]+);base64,(.+)$/);
				if (parts) result.output.push({ type: "image", mimeType: parts[1], data: parts[2] });
			}
	} catch (error) {
		result.stopReason = options.signal?.aborted ? "aborted" : "error";
		result.errorMessage = formatProviderError(normalizeProviderError(error));
	}
	return result;
};
