import { type GenerateContentParameters, GoogleGenAI } from "@google/genai";
import type { SimpleStreamOptions, StreamFunction } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { collapseSystemMessages } from "../utils/transcript.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { googleRequest, googleSimpleOptions } from "./google-request.ts";
import { retryGoogleRequest } from "./google-shared.ts";
import { googleStream } from "./google-stream.ts";
import type { GoogleOptions } from "./options.ts";
export type { GoogleOptions } from "./options.ts";
let toolId = 0;
export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (model, context, options = {}) => {
	const transcript = collapseSystemMessages(context);
	return googleStream(
		model,
		options,
		async () => {
			if (options.fetch && options.fetch !== globalThis.fetch)
				throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
			if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const client = new GoogleGenAI({
				apiKey: options.apiKey,
				httpOptions: {
					...(model.baseUrl ? { baseUrl: model.baseUrl, apiVersion: "" } : {}),
					headers: providerHeadersToRecord(getIdentityHeaders(model, options.identity), model.headers, options.headers),
				},
			});
			const params = googleRequest(model, transcript, options);
			const replacement = await options.onPayload?.(params, model);
			return retryGoogleRequest(
				() =>
					client.models.generateContentStream(
						replacement === undefined ? params : (replacement as GenerateContentParameters),
					),
				options,
			);
		},
		(name) => `${name}_${Date.now()}_${++toolId}`,
	);
};
export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model,
	context,
	options = {},
) => {
	if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	return stream(model, context, googleSimpleOptions(model, context, options));
};
