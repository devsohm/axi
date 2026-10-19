import type { AuthProvider, McpFetch, UnauthorizedContext } from "../auth-provider.ts";
import { isObject } from "../protocol/jsonrpc.ts";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	parseWwwAuthenticate,
	selectResource,
} from "./discovery.ts";
import {
	McpOAuthAuthorizationRequiredError,
	OAuthError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRegistrationError,
} from "./errors.ts";
import {
	type AuthorizationServerMetadata,
	type OAuthClientInformationFull,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthDiscoveryState,
	type OAuthTokens,
	parseClientInformation,
	parseOAuthTokens,
} from "./types.ts";
export type AddClientAuthentication = (
	headers: Headers,
	params: URLSearchParams,
	url: string | URL,
	metadata?: AuthorizationServerMetadata,
) => void | Promise<void>;
export interface OAuthClientMetadataDocument {
	url: string;
	redirectUrl: string;
}
export interface OAuthClientProvider {
	readonly redirectUrl: string | URL;
	readonly clientMetadata: OAuthClientMetadata;
	clientMetadataDocument?(metadata: AuthorizationServerMetadata | undefined): OAuthClientMetadataDocument | undefined;
	state?(): string | Promise<string>;
	clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
	saveClientInformation?(information: OAuthClientInformationMixed): void | Promise<void>;
	tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
	saveTokens(tokens: OAuthTokens): void | Promise<void>;
	redirectToAuthorization(url: URL): void | Promise<void>;
	saveCodeVerifier(verifier: string): void | Promise<void>;
	codeVerifier(): string | Promise<string>;
	addClientAuthentication?: AddClientAuthentication;
	invalidateCredentials?(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): void | Promise<void>;
	saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;
	discoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
}
export interface OAuthFlowOptions {
	serverUrl: string | URL;
	authorizationCode?: string;
	iss?: string;
	scope?: string;
	resourceMetadataUrl?: URL;
	authorizationServerMetadataUrl?: URL;
	fetch?: McpFetch;
	signal?: AbortSignal;
	skipIssuerValidation?: boolean;
	skipRefresh?: boolean;
}
export type OAuthFlowResult = "AUTHORIZED" | "REDIRECT";
export interface TokenRequestOptions {
	metadata?: AuthorizationServerMetadata;
	clientInformation: OAuthClientInformationMixed;
	resource?: string;
	addClientAuthentication?: AddClientAuthentication;
	fetch?: McpFetch;
	signal?: AbortSignal;
}
const loopback = (name: string): boolean =>
	name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
function applicationType(uris: readonly string[]): "native" | "web" {
	return uris.some((uri) => {
		if (!URL.canParse(uri)) return false;
		const url = new URL(uri);
		return (url.protocol !== "http:" && url.protocol !== "https:") || loopback(url.hostname);
	})
		? "native"
		: "web";
}
function endpoint(value: string | URL): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" && !loopback(url.hostname)) throw new OAuthInsecureEndpointError(url.href);
	return url;
}
type AuthMethod = "client_secret_basic" | "client_secret_post" | "none";
function authentication(client: OAuthClientInformationMixed, supported: string[]): AuthMethod {
	const hint = "token_endpoint_auth_method" in client ? client.token_endpoint_auth_method : undefined;
	if (
		(hint === "client_secret_basic" || hint === "client_secret_post" || hint === "none") &&
		(!supported.length || supported.includes(hint))
	)
		return hint;
	if (!supported.length) return client.client_secret ? "client_secret_basic" : "none";
	if (client.client_secret && supported.includes("client_secret_basic")) return "client_secret_basic";
	if (client.client_secret && supported.includes("client_secret_post")) return "client_secret_post";
	return supported.includes("none") ? "none" : client.client_secret ? "client_secret_post" : "none";
}
export async function startAuthorization(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientInformation: OAuthClientInformationMixed;
		redirectUrl: string | URL;
		scope?: string;
		state?: string;
		resource?: string;
	},
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
	const metadata = options.metadata;
	if (metadata && !metadata.response_types_supported.includes("code"))
		throw new Error("Authorization server does not support authorization codes");
	if (metadata?.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256"))
		throw new Error("Authorization server does not support PKCE S256");
	const authorizationUrl = new URL(metadata?.authorization_endpoint ?? new URL("/authorize", authorizationServerUrl));
	const codeVerifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
	const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))).toString(
		"base64url",
	);
	authorizationUrl.searchParams.set("response_type", "code");
	authorizationUrl.searchParams.set("client_id", options.clientInformation.client_id);
	authorizationUrl.searchParams.set("code_challenge", challenge);
	authorizationUrl.searchParams.set("code_challenge_method", "S256");
	authorizationUrl.searchParams.set("redirect_uri", String(options.redirectUrl));
	if (options.state) authorizationUrl.searchParams.set("state", options.state);
	if (options.scope) authorizationUrl.searchParams.set("scope", options.scope);
	if (options.scope?.split(/\s+/).includes("offline_access")) authorizationUrl.searchParams.set("prompt", "consent");
	if (options.resource) authorizationUrl.searchParams.set("resource", options.resource);
	return { authorizationUrl, codeVerifier };
}
async function requestToken(
	server: string | URL,
	options: TokenRequestOptions,
	params: URLSearchParams,
): Promise<OAuthTokens> {
	const url = endpoint(options.metadata?.token_endpoint ?? new URL("/token", server));
	const headers = new Headers({ Accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
	if (options.resource) params.set("resource", options.resource);
	if (options.addClientAuthentication) await options.addClientAuthentication(headers, params, url, options.metadata);
	else {
		const method = authentication(
				options.clientInformation,
				options.metadata?.token_endpoint_auth_methods_supported ?? [],
			),
			client = options.clientInformation;
		if (method === "client_secret_basic") {
			if (!client.client_secret) throw new Error("client_secret_basic requires a client secret");
			headers.set(
				"Authorization",
				"Basic " + Buffer.from(client.client_id + ":" + client.client_secret).toString("base64"),
			);
		} else {
			params.set("client_id", client.client_id);
			if (method === "client_secret_post" && client.client_secret) params.set("client_secret", client.client_secret);
		}
	}
	const fetch = options.fetch ?? globalThis.fetch,
		response = await fetch(url, { method: "POST", headers, body: params, signal: options.signal }),
		text = await response.text();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {}
	if (isObject(value) && typeof value.error === "string")
		throw new OAuthError(
			value.error,
			typeof value.error_description === "string" ? value.error_description : value.error,
			typeof value.error_uri === "string" ? value.error_uri : undefined,
		);
	if (!response.ok) throw new OAuthError("server_error", `HTTP ${response.status}: ${text}`);
	return parseOAuthTokens(value);
}
export async function registerClient(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientMetadata: OAuthClientMetadata;
		scope?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	},
): Promise<OAuthClientInformationFull> {
	const registrationEndpoint = options.metadata?.registration_endpoint;
	if (options.metadata && !registrationEndpoint)
		throw new Error("Authorization server does not support dynamic client registration");
	const fetch = options.fetch ?? globalThis.fetch,
		response = await fetch(new URL(registrationEndpoint ?? new URL("/register", authorizationServerUrl)), {
			method: "POST",
			headers: { Accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({
				...options.clientMetadata,
				application_type:
					options.clientMetadata.application_type ?? applicationType(options.clientMetadata.redirect_uris),
				...(options.scope ? { scope: options.scope } : {}),
			}),
			signal: options.signal,
		});
	if (!response.ok) throw new OAuthRegistrationError(response.status, await response.text());
	return parseClientInformation(await response.json());
}
export async function exchangeAuthorizationCode(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { code: string; codeVerifier: string; redirectUrl: string | URL },
): Promise<OAuthTokens> {
	return requestToken(
		authorizationServerUrl,
		options,
		new URLSearchParams({
			grant_type: "authorization_code",
			code: options.code,
			code_verifier: options.codeVerifier,
			redirect_uri: String(options.redirectUrl),
		}),
	);
}
export async function refreshAuthorization(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { refreshToken: string },
): Promise<OAuthTokens> {
	const tokens = await requestToken(
		authorizationServerUrl,
		options,
		new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken }),
	);
	return { refresh_token: options.refreshToken, ...tokens };
}
export function stepUpScope(granted: string | undefined, challenged: string | undefined): string | undefined {
	return challenged
		? [...new Set([granted, challenged].flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []))].join(" ")
		: undefined;
}
function scopeOf(tokens: OAuthTokens, scope?: string): OAuthTokens {
	return tokens.scope === undefined && scope ? { ...tokens, scope } : tokens;
}
async function flow(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	const metadataUrl = options.authorizationServerMetadataUrl && endpoint(options.authorizationServerMetadataUrl),
		saved = metadataUrl ? undefined : await provider.discoveryState?.();
	const info = saved?.authorizationServerUrl
		? {
				authorizationServerUrl: saved.authorizationServerUrl,
				authorizationServerMetadata:
					saved.authorizationServerMetadata ??
					(await discoverAuthorizationServerMetadata(saved.authorizationServerUrl, {
						fetch: options.fetch,
						skipIssuerValidation: options.skipIssuerValidation,
						signal: options.signal,
					})),
				resourceMetadata: saved.resourceMetadata,
			}
		: await discoverOAuthServerInfo(options.serverUrl, {
				resourceMetadataUrl: options.resourceMetadataUrl,
				authorizationServerMetadataUrl: metadataUrl,
				fetch: options.fetch,
				skipIssuerValidation: options.skipIssuerValidation,
				signal: options.signal,
			});
	if (!metadataUrl)
		await provider.saveDiscoveryState?.({
			...info,
			...(options.resourceMetadataUrl ? { resourceMetadataUrl: options.resourceMetadataUrl.href } : {}),
		});
	const metadata = info.authorizationServerMetadata,
		resource = selectResource(options.serverUrl, info.resourceMetadata),
		scope = options.scope || info.resourceMetadata?.scopes_supported?.join(" ") || provider.clientMetadata.scope;
	const stored = await provider.clientInformation(),
		document = stored ? undefined : provider.clientMetadataDocument?.(metadata);
	if (document) {
		const url = new URL(document.url);
		if (url.protocol !== "https:" || url.pathname === "/") throw new Error("Invalid OAuth client metadata URL");
	}
	let client = stored ?? (document && { client_id: document.url });
	if (!client) {
		if (options.authorizationCode) throw new Error("OAuth client information is missing during code exchange");
		if (!provider.saveClientInformation) throw new Error("OAuth client information cannot be persisted");
		client = await registerClient(info.authorizationServerUrl, {
			metadata,
			clientMetadata: provider.clientMetadata,
			scope,
			fetch: options.fetch,
			signal: options.signal,
		});
		await provider.saveClientInformation(client);
	}
	const redirectUrl = document?.redirectUrl ?? provider.redirectUrl;
	const tokenOptions: TokenRequestOptions = {
		metadata,
		clientInformation: client,
		resource,
		addClientAuthentication: provider.addClientAuthentication,
		fetch: options.fetch,
		signal: options.signal,
	};
	if (options.authorizationCode) {
		const iss = options.iss;
		if ((iss !== undefined || metadata?.authorization_response_iss_parameter_supported) && iss !== metadata?.issuer)
			throw new OAuthIssuerMismatchError(metadata?.issuer, iss);
		const tokens = await exchangeAuthorizationCode(info.authorizationServerUrl, {
			...tokenOptions,
			code: options.authorizationCode,
			codeVerifier: await provider.codeVerifier(),
			redirectUrl,
		});
		await provider.saveTokens(scopeOf(tokens, scope));
		return "AUTHORIZED";
	}
	const previous = options.skipRefresh ? undefined : await provider.tokens();
	if (previous?.refresh_token) {
		try {
			const tokens = await refreshAuthorization(info.authorizationServerUrl, {
				...tokenOptions,
				refreshToken: previous.refresh_token,
			});
			await provider.saveTokens(scopeOf(tokens, previous.scope));
			return "AUTHORIZED";
		} catch (error) {
			if (
				options.signal?.aborted ||
				error instanceof OAuthInsecureEndpointError ||
				(error instanceof OAuthError && error.code !== "server_error")
			)
				throw error;
		}
	}
	const state = await provider.state?.(),
		authorization = await startAuthorization(info.authorizationServerUrl, {
			metadata,
			clientInformation: client,
			redirectUrl,
			scope,
			state,
			resource,
		});
	await provider.saveCodeVerifier(authorization.codeVerifier);
	await provider.redirectToAuthorization(authorization.authorizationUrl);
	return "REDIRECT";
}
export async function authorizeMcp(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	try {
		return await flow(provider, options);
	} catch (error) {
		if (error instanceof OAuthError) {
			if (error.code === "invalid_client" || error.code === "unauthorized_client") {
				await provider.invalidateCredentials?.("all");
				return flow(provider, options);
			}
			if (error.code === "invalid_grant") {
				await provider.invalidateCredentials?.("tokens");
				return flow(provider, options);
			}
		}
		throw error;
	}
}
export function adaptOAuthProvider(provider: OAuthClientProvider): AuthProvider {
	let recovery: Promise<void> | undefined;
	return {
		token: async () => (await provider.tokens())?.access_token,
		onUnauthorized: async (context: UnauthorizedContext) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate")),
				stepUp = challenge.error === "insufficient_scope";
			if (!stepUp && !recovery && context.token !== undefined) {
				const current = (await provider.tokens())?.access_token;
				if (current !== undefined && current !== context.token) return;
			}
			recovery ??= Promise.resolve(stepUp ? provider.tokens() : undefined)
				.then((tokens) =>
					authorizeMcp(provider, {
						serverUrl: context.serverUrl,
						resourceMetadataUrl: challenge.resourceMetadataUrl,
						scope: stepUp ? stepUpScope(tokens?.scope, challenge.scope) : challenge.scope,
						fetch: context.fetch,
						skipRefresh: stepUp,
					}),
				)
				.then((result) => {
					if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
				})
				.finally(() => {
					recovery = undefined;
				});
			await recovery;
		},
	};
}
