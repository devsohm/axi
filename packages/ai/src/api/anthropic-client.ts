import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type { CacheRetention, Model, ProviderEnv, ProviderHeaders, TranscriptContext } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import type { AnthropicOptions } from "./options.ts";

export function anthropicCompat(model: Model<"anthropic-messages">) {
	const router = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? router,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? (router ? "openrouter" : undefined),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
	};
}
export function anthropicRetention(options: AnthropicOptions): CacheRetention {
	return (
		options.cacheRetention ?? (getProviderEnvValue("AXI_CACHE_RETENTION", options.env) === "long" ? "long" : "short")
	);
}
function authenticated(key: string | undefined, headers: ProviderHeaders | undefined): boolean {
	return (
		!!key ||
		Object.entries(headers ?? {}).some(
			([name, value]) =>
				["authorization", "x-api-key", "cf-aig-authorization"].includes(name.toLowerCase()) && !!value?.trim(),
		)
	);
}
export function assertAnthropicAuth(model: Model<"anthropic-messages">, options: AnthropicOptions): void {
	if (!authenticated(options.apiKey, options.headers)) throw new Error(`No API key for provider: ${model.provider}`);
}
type Federation = NonNullable<ClientOptions["config"]>;
export function anthropicFederation(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
): Federation | undefined {
	if (model.provider !== "anthropic" || authenticated(options.apiKey, options.headers)) return undefined;
	const env: ProviderEnv | undefined = options.env;
	const read = (name: string) => getProviderEnvValue(`ANTHROPIC_${name}`, env);
	const rule = read("FEDERATION_RULE_ID"),
		organization = read("ORGANIZATION_ID"),
		path = read("IDENTITY_TOKEN_FILE");
	if (!rule || !organization || !path) return undefined;
	return {
		organization_id: organization,
		workspace_id: read("WORKSPACE_ID"),
		authentication: {
			type: "oidc_federation",
			federation_rule_id: rule,
			service_account_id: read("SERVICE_ACCOUNT_ID"),
			identity_token: { source: "file", path },
		},
	};
}
class ExplicitAnthropic extends Anthropic {
	protected override _shouldResolveDefaultCredentials(): boolean {
		return false;
	}
}
let cachedFederation: { key: string; fetch: typeof globalThis.fetch | undefined; client: Anthropic } | undefined;
export function anthropicClient(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
): { client: Anthropic; oauth: boolean } {
	if (options.client) return { client: options.client, oauth: false };
	const federation = anthropicFederation(model, options);
	if (!federation) assertAnthropicAuth(model, options);
	const copilot = model.provider === "github-copilot";
	const oauth = !copilot && !!options.apiKey?.includes("sk-ant-oat");
	const headers: ProviderHeaders = {
		...(oauth ? {} : getIdentityHeaders(model, options.identity)),
		accept: "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
	};
	if (copilot)
		Object.assign(
			headers,
			model.headers,
			buildCopilotDynamicHeaders({ messages: context.messages, hasImages: hasCopilotVisionInput(context.messages) }),
		);
	else if (oauth) Object.assign(headers, { "user-agent": "claude-cli/2.1.280", "x-app": "cli" }, model.headers);
	else {
		const compat = anthropicCompat(model);
		if (options.sessionId && anthropicRetention(options) !== "none" && compat.sendSessionAffinityHeaders)
			headers[compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity"] =
				options.sessionId;
		Object.assign(headers, model.headers);
	}
	Object.assign(headers, options.headers);
	const base: ClientOptions = {
		apiKey: null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch: options.fetch,
	};
	if (federation) {
		const key = JSON.stringify([model.baseUrl, federation]);
		if (cachedFederation?.key !== key || cachedFederation.fetch !== options.fetch)
			cachedFederation = { key, fetch: options.fetch, client: new ExplicitAnthropic({ ...base, config: federation }) };
		return { client: cachedFederation.client.withOptions({ defaultHeaders: headers }), oauth: false };
	}
	return {
		client: new ExplicitAnthropic({
			...base,
			...(copilot || oauth ? { authToken: options.apiKey ?? null } : { apiKey: options.apiKey ?? null }),
			defaultHeaders: headers,
		}),
		oauth,
	};
}
