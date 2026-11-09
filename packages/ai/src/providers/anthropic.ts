import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAnthropicOAuth } from "../auth/oauth/load.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import {
	ANTHROPIC_API_KEY_ENV,
	ANTHROPIC_AUTH_TOKEN_ENV,
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_OAUTH_TOKEN_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ProviderEnv } from "../types.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

function authentication(): ApiKeyAuth {
	const keys = envApiKeyAuth("Anthropic API key", [ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV]);
	return {
		name: keys.name,
		login: keys.login,
		async resolve(input) {
			const { ctx, credential, signal } = input;
			signal.throwIfAborted();
			if (credential?.key)
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			const token = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV);
			signal.throwIfAborted();
			if (token) return { auth: { headers: { Authorization: `Bearer ${token}` } }, source: ANTHROPIC_AUTH_TOKEN_ENV };
			for (const name of [ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV]) {
				const key = await ctx.env(name);
				signal.throwIfAborted();
				if (key) return { auth: { apiKey: key }, source: name };
			}
			const env: ProviderEnv = {};
			for (const name of [
				ANTHROPIC_FEDERATION_RULE_ID_ENV,
				ANTHROPIC_ORGANIZATION_ID_ENV,
				ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
			]) {
				const value = await ctx.env(name);
				signal.throwIfAborted();
				if (!value) return undefined;
				env[name] = value;
			}
			for (const name of [ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, ANTHROPIC_WORKSPACE_ID_ENV]) {
				const value = await ctx.env(name);
				signal.throwIfAborted();
				if (value) env[name] = value;
			}
			return { auth: {}, env, source: "workload identity federation" };
		},
	};
}
export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
		auth: {
			apiKey: authentication(),
			oauth: lazyOAuth({ name: "Anthropic (Claude Pro/Max)", isSubscription: true, load: loadAnthropicOAuth }),
		},
	});
}
