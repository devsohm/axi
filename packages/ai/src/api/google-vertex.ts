import { type GenerateContentParameters, GoogleGenAI, type HttpOptions, ResourceScope } from "@google/genai";
import type { Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { collapseSystemMessages } from "../utils/transcript.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { googleRequest, googleSimpleOptions } from "./google-request.ts";
import { retryGoogleRequest } from "./google-shared.ts";
import { googleStream } from "./google-stream.ts";
import type { GoogleVertexOptions } from "./options.ts";
export type { GoogleVertexOptions } from "./options.ts";
let toolId = 0;
function clientFor(model: Model<"google-vertex">, options: GoogleVertexOptions): GoogleGenAI {
	const httpOptions: HttpOptions = {
		headers: providerHeadersToRecord(getIdentityHeaders(model, options.identity), model.headers, options.headers),
	};
	const baseUrl = model.baseUrl.trim();
	if (baseUrl && !baseUrl.includes("{location}")) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		let path: string;
		try {
			path = new URL(baseUrl).pathname;
		} catch {
			path = baseUrl;
		}
		if (/(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(path)) httpOptions.apiVersion = "";
	}
	const apiKey = options.apiKey?.trim();
	if (apiKey && apiKey !== "gcp-vertex-credentials" && !/^<[^>]+>$/.test(apiKey))
		return new GoogleGenAI({ vertexai: true, apiVersion: "v1", apiKey, httpOptions });
	const env = (name: string) => getProviderEnvValue(name, options.env);
	const project = options.project || env("GOOGLE_CLOUD_PROJECT") || env("GCLOUD_PROJECT");
	if (!project)
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	const location = options.location || env("GOOGLE_CLOUD_LOCATION");
	if (!location)
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	const keyFilename = env("GOOGLE_APPLICATION_CREDENTIALS");
	return new GoogleGenAI({
		vertexai: true,
		apiVersion: "v1",
		project,
		location,
		httpOptions,
		...(keyFilename ? { googleAuthOptions: { keyFilename } } : {}),
	});
}
export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (model, context, options = {}) => {
	const transcript = collapseSystemMessages(context);
	return googleStream(
		model,
		options,
		async () => {
			if (options.fetch && options.fetch !== globalThis.fetch)
				throw new Error("Custom fetch is not supported by the Google Vertex adapter");
			const client = clientFor(model, options),
				params = googleRequest(model, transcript, options);
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
export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (model, context, options = {}) =>
	stream(model, context, googleSimpleOptions(model, context, options));
