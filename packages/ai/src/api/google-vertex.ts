import { type GenerateContentParameters, GoogleGenAI, type HttpOptions, ResourceScope } from "@google/genai";
import type { FetchFunction, Model, ProviderHeaders, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { collapseSystemMessages } from "../utils/transcript.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { googleRequest, googleSimpleOptions } from "./google-request.ts";
import { retryGoogleRequest } from "./google-shared.ts";
import { googleStream } from "./google-stream.ts";
import type { GoogleVertexOptions } from "./options.ts";
export type { GoogleVertexOptions } from "./options.ts";
let toolId = 0;
function vertexHttp(
	model: Model<"google-vertex">,
	headers: ProviderHeaders | undefined,
	identity: ClientIdentity | undefined,
	fetch: FetchFunction | undefined,
): HttpOptions {
	// Supplying fetch keeps the SDK from overriding dispatcher timeouts.
	const httpOptions: HttpOptions = { fetch: fetch ?? globalThis.fetch };
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
	httpOptions.headers = providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, headers);
	return httpOptions;
}
function clientFor(model: Model<"google-vertex">, options: GoogleVertexOptions): GoogleGenAI {
	// Select auth routing before a dynamic header supplier can change the options.
	const apiKey = options.apiKey?.trim();
	if (apiKey && apiKey !== "gcp-vertex-credentials" && !/^<[^>]+>$/.test(apiKey))
		return new GoogleGenAI({
			vertexai: true,
			apiVersion: "v1",
			apiKey,
			httpOptions: vertexHttp(model, options.headers, options.identity, options.fetch),
		});
	const project =
		options.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options.env);
	if (!project)
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	const location = options.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options.env);
	if (!location)
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	const headers = options.headers,
		env = options.env,
		identity = options.identity,
		fetch = options.fetch;
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	return new GoogleGenAI({
		vertexai: true,
		apiVersion: "v1",
		project,
		location,
		...(keyFilename ? { googleAuthOptions: { keyFilename } } : {}),
		httpOptions: vertexHttp(model, headers, identity, fetch),
	});
}
export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (model, context, options = {}) => {
	const transcript = collapseSystemMessages(context);
	return googleStream(
		model,
		options,
		async () => {
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
