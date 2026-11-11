import { refreshStoredTokens } from "./auth-provider.ts";
import type { OAuthCallback } from "./callback.ts";
import {
	createOAuthClientProvider,
	offersClientMetadataDocument,
	registeredRedirectUrls,
	timedFetch,
	type McpOAuthClientOptions,
} from "./client-settings.ts";
import { McpRefreshLockBusyError } from "./errors.ts";
import { authorizeMcp, stepUpScope, type OAuthFlowOptions } from "./flow.ts";
import type { OAuthChallenge } from "./types.ts";

export interface McpSignInOptions extends McpOAuthClientOptions {
	redirectUrl: string;
	challenge?: OAuthChallenge;
	signal?: AbortSignal;
}
export interface McpSignInRedirect {
	kind: "redirect";
	authorizationUrl: string;
	redirectUrl: string;
	state: string;
	scope?: string;
}
export type McpSignInStart = { kind: "authorized" } | McpSignInRedirect;
export type McpAuthorizationResponse = OAuthCallback;
export class McpSignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "McpSignInCancelledError";
	}
}
export async function cancellable<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	if (signal?.aborted) throw new McpSignInCancelledError();
	try {
		return await fn();
	} catch (error) {
		if (signal?.aborted) throw new McpSignInCancelledError();
		throw error;
	}
}
async function waitForRefresh<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	let abort = () => {};
	try {
		return await new Promise<T>((resolve, reject) => {
			abort = () => reject(new McpSignInCancelledError());
			signal.addEventListener("abort", abort, { once: true });
			promise.then(resolve, reject);
		});
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
function flowOptions(options: McpSignInOptions): OAuthFlowOptions {
	return {
		serverUrl: options.serverUrl,
		fetch: timedFetch(),
		signal: options.signal,
		resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
		authorizationServerMetadataUrl: options.settings.authServerMetadataUrl,
	};
}
export async function startMcpSignIn(options: McpSignInOptions): Promise<McpSignInStart> {
	if (options.signal?.aborted) throw new McpSignInCancelledError();
	const stepUp = options.challenge?.error === "insufficient_scope";
	if (!stepUp) {
		const { settings, store, challenge, redirectUrl, signal } = options;
		const refresh = store.withRefreshLock(async () => {
			if (signal?.aborted) return "REDIRECT";
			const state = await store.load();
			if (
				!state?.tokens?.refresh_token ||
				(settings.clientRegistration === "cimd" && state.clientInformation && !settings.clientId)
			)
				return "REDIRECT";
			return refreshStoredTokens(options, state, { challenge, redirectUrl });
		});
		try {
			if ((await waitForRefresh(refresh, signal)) === "AUTHORIZED") return { kind: "authorized" };
		} catch (error) {
			if (!(error instanceof McpRefreshLockBusyError)) throw error;
		}
	}
	return cancellable(options.signal, async () => {
		// A browser step keeps its scope and callback paired across storage awaits.
		const { settings, store, challenge, redirectUrl } = options;
		const stored = await store.load();
		if (stored) {
			const { settings, redirectUrl } = options;
			const next = { ...stored };
			delete next.oauthState;
			const usable =
				settings.clientId ||
				(stored.clientInformation
					? settings.clientRegistration !== "cimd" &&
						registeredRedirectUrls(stored.clientInformation).includes(redirectUrl)
					: offersClientMetadataDocument(settings, options.clientMetadataDocuments, redirectUrl));
			if (!usable) {
				delete next.clientInformation;
				delete next.tokens;
				delete next.tokensExpireAt;
			}
			await store.save(next);
		}
		let redirect: URL | undefined;
		const provider = createOAuthClientProvider(options, redirectUrl, (url) => {
			redirect = url;
		});
		const scopes = [settings.scope, stepUp ? stepUpScope(stored?.tokens?.scope, challenge?.scope) : challenge?.scope];
		const scope =
			[...new Set(scopes.flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []))].join(" ") || undefined;
		await authorizeMcp(provider, { ...flowOptions(options), scope, skipRefresh: true });
		if (!redirect) throw new Error("OAuth flow did not produce an authorization URL");
		const requested = redirect.searchParams.get("scope");
		return {
			kind: "redirect",
			authorizationUrl: redirect.href,
			redirectUrl: redirect.searchParams.get("redirect_uri") ?? redirectUrl,
			state: await provider.state(),
			...(requested ? { scope: requested } : {}),
		};
	});
}
export async function completeMcpSignIn(
	options: McpSignInOptions & { authorization: McpSignInRedirect; response: McpAuthorizationResponse },
): Promise<void> {
	await cancellable(options.signal, async () => {
		const { authorization, response } = options;
		if (response.state !== authorization.state)
			throw new Error("The authorization response belongs to a different sign-in");
		if ((await options.store.load())?.oauthState !== authorization.state)
			throw new Error("Another sign-in to this MCP server started since; sign in again");
		await authorizeMcp(createOAuthClientProvider(options, options.redirectUrl), {
			...flowOptions(options),
			authorizationCode: response.code,
			iss: response.iss,
			authorizationRedirectUrl: authorization.redirectUrl,
			scope: authorization.scope,
		});
	});
}
