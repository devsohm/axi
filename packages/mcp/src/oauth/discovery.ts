import type { McpFetch } from "../auth-provider.ts";
import { LATEST_PROTOCOL_VERSION } from "../protocol/types.ts";
import { OAuthIssuerMismatchError } from "./errors.ts";
import {
	parseAuthorizationServerMetadata,
	parseProtectedResourceMetadata,
	type AuthorizationServerMetadata,
	type OAuthChallenge,
	type OAuthProtectedResourceMetadata,
	type OAuthServerInfo,
} from "./types.ts";
const discard = (response: Response): void => {
	void response.body?.cancel().catch(() => undefined);
};
const miss = (status: number): boolean => status === 502 || (status >= 400 && status < 500);
const suffix = (path: string): string => (path.endsWith("/") ? path.slice(0, -1) : path);
function fetchMetadata(
	url: URL,
	fetch: McpFetch,
	version = LATEST_PROTOCOL_VERSION,
	signal?: AbortSignal,
): Promise<Response> {
	return fetch(url, { headers: { Accept: "application/json", "MCP-Protocol-Version": version }, signal });
}
function challengeField(header: string, name: string): string | undefined {
	const match = header.match(new RegExp(`(?:^|[,\\s])${name}=(?:"([^"]*)"|([^\\s,]+))`, "i"));
	return match?.[1] || match?.[2] || undefined;
}
export function parseWwwAuthenticate(header: string | null): OAuthChallenge {
	if (!header) return {};
	const scheme = header.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
	if (scheme !== "bearer" && scheme !== "dpop") return {};
	const metadata = challengeField(header, "resource_metadata");
	let resourceMetadataUrl: URL | undefined;
	if (metadata) {
		try {
			resourceMetadataUrl = new URL(metadata);
		} catch {}
	}
	return {
		resourceMetadataUrl,
		scope: challengeField(header, "scope"),
		error: challengeField(header, "error"),
		errorDescription: challengeField(header, "error_description"),
	};
}
export async function discoverProtectedResourceMetadata(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: string | URL;
		protocolVersion?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	} = {},
): Promise<OAuthProtectedResourceMetadata> {
	const server = new URL(serverUrl),
		fetch = options.fetch ?? globalThis.fetch,
		version = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
	let response = await fetchMetadata(
		options.resourceMetadataUrl
			? new URL(options.resourceMetadataUrl)
			: new URL("/.well-known/oauth-protected-resource" + suffix(server.pathname), server.origin),
		fetch,
		version,
		options.signal,
	);
	if (!options.resourceMetadataUrl && server.pathname !== "/" && miss(response.status)) {
		discard(response);
		response = await fetchMetadata(
			new URL("/.well-known/oauth-protected-resource", server.origin),
			fetch,
			version,
			options.signal,
		);
	}
	if (!response.ok) {
		discard(response);
		throw new Error(`HTTP ${response.status} loading OAuth protected resource metadata`);
	}
	return parseProtectedResourceMetadata(await response.json());
}
export function buildAuthorizationServerDiscoveryUrls(
	authorizationServerUrl: string | URL,
): { url: URL; type: "oauth" | "oidc" }[] {
	const issuer = new URL(authorizationServerUrl),
		path = suffix(issuer.pathname);
	const result: { url: URL; type: "oauth" | "oidc" }[] = [
		{ url: new URL("/.well-known/oauth-authorization-server" + path, issuer.origin), type: "oauth" },
		{ url: new URL("/.well-known/openid-configuration" + path, issuer.origin), type: "oidc" },
	];
	if (path) result.push({ url: new URL(path + "/.well-known/openid-configuration", issuer.origin), type: "oidc" });
	return result;
}
export async function discoverAuthorizationServerMetadata(
	authorizationServerUrl: string | URL,
	options: { fetch?: McpFetch; protocolVersion?: string; skipIssuerValidation?: boolean; signal?: AbortSignal } = {},
): Promise<AuthorizationServerMetadata | undefined> {
	const fetch = options.fetch ?? globalThis.fetch;
	for (const { url } of buildAuthorizationServerDiscoveryUrls(authorizationServerUrl)) {
		const response = await fetchMetadata(
			url,
			fetch,
			options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
			options.signal,
		);
		if (!response.ok) {
			discard(response);
			if (miss(response.status)) continue;
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(await response.json());
		if (!options.skipIssuerValidation) {
			const expected = String(authorizationServerUrl);
			if (suffix(metadata.issuer) !== suffix(expected)) throw new OAuthIssuerMismatchError(expected, metadata.issuer);
		}
		return metadata;
	}
}
export async function discoverOAuthServerInfo(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: URL;
		authorizationServerMetadataUrl?: URL;
		fetch?: McpFetch;
		skipIssuerValidation?: boolean;
		signal?: AbortSignal;
	} = {},
): Promise<OAuthServerInfo> {
	let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
	try {
		resourceMetadata = await discoverProtectedResourceMetadata(serverUrl, {
			resourceMetadataUrl: options.resourceMetadataUrl,
			fetch: options.fetch,
			signal: options.signal,
		});
	} catch (error) {
		if (error instanceof TypeError) throw error;
	}
	if (options.authorizationServerMetadataUrl) {
		const url = options.authorizationServerMetadataUrl,
			response = await fetchMetadata(url, options.fetch ?? globalThis.fetch, LATEST_PROTOCOL_VERSION, options.signal);
		if (!response.ok) {
			discard(response);
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(await response.json());
		return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata, resourceMetadata };
	}
	const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? String(new URL("/", serverUrl));
	return {
		authorizationServerUrl,
		authorizationServerMetadata: await discoverAuthorizationServerMetadata(authorizationServerUrl, {
			fetch: options.fetch,
			skipIssuerValidation: options.skipIssuerValidation,
			signal: options.signal,
		}),
		resourceMetadata,
	};
}
export function resourceUrlFromServerUrl(value: string | URL): URL {
	const result = new URL(value);
	result.hash = "";
	return result;
}
export function selectResource(serverUrl: string | URL, metadata?: OAuthProtectedResourceMetadata): string | undefined {
	if (!metadata) return;
	const requested = resourceUrlFromServerUrl(serverUrl),
		configured = new URL(metadata.resource);
	if (requested.origin !== configured.origin)
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : requested.pathname + "/";
	const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : configured.pathname + "/";
	if (!requestedPath.startsWith(configuredPath))
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	return metadata.resource;
}
