import type { BedrockRuntimeClientConfig } from "@aws-sdk/client-bedrock-runtime";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { BuildMiddleware, DeserializeMiddleware, HttpResponse, MetadataBearer } from "@smithy/types";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Agent } from "node:https";
import type { Model } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import type { BedrockOptions } from "./options.ts";
function endpointRegion(baseUrl: string): string | undefined {
	try {
		return /^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(
			new URL(baseUrl).hostname.toLowerCase(),
		)?.[1];
	} catch {
		return undefined;
	}
}
function configuration(model: Model<"bedrock-converse-stream">, options: BedrockOptions): BedrockRuntimeClientConfig {
	const env = (key: string) => getProviderEnvValue(key, options.env),
		explicitProfile = options.profile || options.env?.AWS_PROFILE;
	const configuredRegion = options.region || env("AWS_REGION") || env("AWS_DEFAULT_REGION");
	const ambientProfile = Boolean(getProviderEnvValue("AWS_PROFILE"));
	const fromEndpoint = endpointRegion(model.baseUrl),
		explicitEndpoint = !fromEndpoint || (!configuredRegion && !ambientProfile);
	const config: BedrockRuntimeClientConfig = {
		profile: explicitProfile || env("AWS_PROFILE"),
		...(explicitEndpoint ? { endpoint: model.baseUrl } : {}),
	};
	const skipAuth = env("AWS_BEDROCK_SKIP_AUTH") === "1",
		token = options.bearerToken || options.apiKey || env("AWS_BEARER_TOKEN_BEDROCK");
	if (typeof process !== "undefined" && process.versions?.node) {
		const arn = /^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/.exec(model.id);
		const region =
			arn?.[1] ||
			configuredRegion ||
			(explicitEndpoint ? fromEndpoint : undefined) ||
			(!ambientProfile ? "us-east-1" : undefined);
		if (region) config.region = region;
		if (skipAuth) config.credentials = { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" };
		const accessKeyId = env("AWS_ACCESS_KEY_ID"),
			secretAccessKey = env("AWS_SECRET_ACCESS_KEY"),
			sessionToken = env("AWS_SESSION_TOKEN");
		if (!skipAuth && !explicitProfile && accessKeyId && secretAccessKey)
			config.credentials = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
		const proxy = resolveHttpProxyUrlForTarget(model.baseUrl, options.env);
		if (proxy)
			config.requestHandler = new NodeHttpHandler({
				httpAgent: new HttpProxyAgent(proxy),
				httpsAgent: new HttpsProxyAgent(proxy) as unknown as Agent,
			});
		else if (env("AWS_BEDROCK_FORCE_HTTP1") === "1") config.requestHandler = new NodeHttpHandler();
	} else config.region = configuredRegion || (explicitEndpoint ? fromEndpoint : undefined) || "us-east-1";
	if (token !== undefined && !skipAuth) {
		config.token = { token };
		config.authSchemePreference = ["httpBearerAuth"];
	}
	return config;
}
function httpResponse(value: unknown): value is HttpResponse {
	return (
		value !== null &&
		typeof value === "object" &&
		"statusCode" in value &&
		typeof value.statusCode === "number" &&
		"headers" in value &&
		value.headers !== null &&
		typeof value.headers === "object"
	);
}
export function bedrockClient(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): { client: BedrockRuntimeClient; observedResponse: () => boolean } {
	const client = new BedrockRuntimeClient(configuration(model, options));
	let observed = false;
	if (options.onResponse) {
		const onResponse = options.onResponse;
		const middleware: DeserializeMiddleware<object, MetadataBearer> = (next) => async (args) => {
			const result = await next(args);
			if (httpResponse(result.response)) {
				observed = true;
				await onResponse({ status: result.response.statusCode, headers: { ...result.response.headers } }, model);
			}
			return result;
		};
		client.middlewareStack.add(middleware, { step: "deserialize", name: "axi-response-headers" });
	}
	const headers = providerHeadersToRecord(options.headers);
	if (headers) {
		const middleware: BuildMiddleware<object, MetadataBearer> = (next) => async (args) => {
			if (args.request && typeof args.request === "object" && "headers" in args.request) {
				const target = args.request.headers as Record<string, string>;
				for (const [name, value] of Object.entries(headers))
					if (!/^(?:authorization|host)$|^x-amz-/i.test(name)) target[name] = value;
			}
			return next(args);
		};
		client.middlewareStack.add(middleware, { step: "build", name: "axi-custom-headers", priority: "low" });
	}
	return { client, observedResponse: () => observed };
}
