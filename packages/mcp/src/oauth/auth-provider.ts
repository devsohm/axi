import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import {
	createOAuthClientProvider,
	DEFAULT_REDIRECT_URL,
	loopbackSettings,
	registeredRedirectUrls,
	timedFetch,
	type McpOAuthClientOptions,
	type McpOAuthSettings,
} from "./client-settings.ts";
import { parseWwwAuthenticate } from "./discovery.ts";
import { McpOAuthAuthorizationRequiredError } from "./errors.ts";
import { authorizeMcp, type OAuthFlowResult } from "./flow.ts";
import type { McpOAuthState } from "./provider.ts";
import type { OAuthChallenge } from "./types.ts";

export interface McpAuthProvider extends AuthProvider {
	settled(): Promise<void>;
}
export async function refreshStoredTokens(
	client: McpOAuthClientOptions,
	state: McpOAuthState,
	options: { fetch?: McpFetch; challenge?: OAuthChallenge; redirectUrl?: string } = {},
): Promise<OAuthFlowResult> {
	const candidates = [
		options.redirectUrl,
		loopbackSettings(client.settings).fixedRedirectUrl,
		registeredRedirectUrls(state.clientInformation)[0],
	];
	const redirect =
		candidates.find((url) => url !== undefined && client.clientMetadataDocuments?.listsRedirectUrl(url)) ??
		DEFAULT_REDIRECT_URL;
	return authorizeMcp(createOAuthClientProvider(client, redirect), {
		serverUrl: client.serverUrl,
		resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
		authorizationServerMetadataUrl: client.settings.authServerMetadataUrl,
		fetch: timedFetch(options.fetch),
		refreshOnly: true,
	});
}
export function createMcpAuthProvider(
	options: Omit<McpOAuthClientOptions, "settings"> & {
		settings: () => McpOAuthSettings;
		onChallenge: (challenge: OAuthChallenge) => void;
		redirectUrl?: string;
	},
): McpAuthProvider {
	let pending: Promise<void> | undefined;
	const refresh = (stale: string | undefined, fetch?: McpFetch, challenge?: OAuthChallenge): Promise<void> => {
		pending ??= options.store
			.withRefreshLock(async () => {
				const stored = await options.store.load();
				if (stored?.tokens?.access_token !== stale) return;
				if (!stored?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				const result = await refreshStoredTokens({ ...options, settings: options.settings() }, stored, {
					fetch,
					challenge,
					redirectUrl: options.redirectUrl,
				});
				if (result !== "AUTHORIZED") throw new McpOAuthAuthorizationRequiredError();
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};
	return {
		token: async () => {
			await pending?.catch(() => undefined);
			const stored = await options.store.load();
			if (
				stored?.tokensExpireAt === undefined ||
				stored.tokensExpireAt > Date.now() + 30000 ||
				!stored.tokens?.refresh_token
			)
				return stored?.tokens?.access_token;
			await refresh(stored.tokens.access_token).catch(() => undefined);
			return (await options.store.load())?.tokens?.access_token;
		},
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			options.onChallenge(challenge);
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			await refresh(context.token, context.fetch, challenge);
		},
		settled: async () => {
			await pending?.catch(() => undefined);
		},
	};
}
