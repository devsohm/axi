import { createHash } from "node:crypto";
import type { McpFetch } from "../auth-provider.ts";
import { McpOAuthProvider, type McpOAuthStateStore } from "./provider.ts";
import type { OAuthClientInformationMixed } from "./types.ts";

export interface McpOAuthSettings {
	clientId?: string;
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
	clientName?: string;
	clientRegistration?: "auto" | "dcr" | "cimd";
	authServerMetadataUrl?: URL;
}
export interface McpClientMetadataDocuments {
	baseUrl: string;
	listsRedirectUrl(redirectUrl: string): boolean;
}
export interface McpOAuthServerStore extends McpOAuthStateStore {
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}
export interface McpOAuthClientOptions {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: McpOAuthSettings;
	clientName: string;
	clientMetadataDocuments?: McpClientMetadataDocuments;
}
export function offersClientMetadataDocument(
	settings: McpOAuthSettings,
	documents: McpClientMetadataDocuments | undefined,
	redirectUrl: string,
): boolean {
	if (settings.clientRegistration && settings.clientRegistration !== "auto")
		return settings.clientRegistration === "cimd";
	return !settings.clientId && !settings.clientName && documents?.listsRedirectUrl(redirectUrl) === true;
}
function callbackId(serverUrl: string): string {
	const server = new URL(serverUrl);
	server.hash = "";
	return createHash("sha256").update(server.href).digest().subarray(0, 9).toString("base64url");
}
export function serverSpecificPath(path: string, serverUrl: string): string {
	return path.replace(/\/$/, "") + "/" + callbackId(serverUrl);
}
export function createOAuthClientProvider(
	options: McpOAuthClientOptions,
	redirectUrl: string,
	onRedirect: (url: URL) => void = () => {},
): McpOAuthProvider {
	const { settings, clientMetadataDocuments: documents } = options;
	return new McpOAuthProvider({
		serverUrl: options.serverUrl,
		redirectUrl,
		store: options.store,
		onRedirect,
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		clientMetadata: { client_name: settings.clientName ?? options.clientName },
		clientMetadataDocument: offersClientMetadataDocument(settings, documents, redirectUrl)
			? (metadata) => {
					if (!documents?.listsRedirectUrl(redirectUrl))
						throw new Error(
							`oauth.clientRegistration "cimd" needs Client ID Metadata Documents that list the redirect URI ${redirectUrl}`,
						);
					if (
						!metadata?.client_id_metadata_document_supported ||
						!metadata.token_endpoint_auth_methods_supported?.includes("none")
					) {
						if (settings.clientRegistration === "cimd")
							throw new Error(
								'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
							);
						return undefined;
					}
					if (metadata.authorization_response_iss_parameter_supported)
						return { url: documents.baseUrl + "/client.json", redirectUrl };
					const scoped = new URL(redirectUrl);
					scoped.pathname = serverSpecificPath(scoped.pathname, options.serverUrl);
					return {
						url: documents.baseUrl + "/" + callbackId(options.serverUrl) + "/client.json",
						redirectUrl: scoped.href,
					};
				}
			: undefined,
	});
}
export function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}
export function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return (input, init) => {
		const timer = AbortSignal.timeout(15000);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timer]) : timer });
	};
}
export const DEFAULT_REDIRECT_URL = "http://127.0.0.1/callback";
export interface LoopbackSettings {
	url: string;
	host: string;
	redirectHost: string;
	port: number | undefined;
	path: string;
	fixedRedirectUrl: string | undefined;
}
export function loopbackSettings(settings: McpOAuthSettings): LoopbackSettings {
	const configured = settings.callbackUrl ?? DEFAULT_REDIRECT_URL,
		parsed = new URL(configured);
	const redirectHost = parsed.hostname.replace(/^\[|\]$/g, "");
	const port = parsed.port ? Number(parsed.port) : settings.callbackPort;
	const fixed = parsed.port
		? settings.callbackUrl
		: port === undefined
			? undefined
			: (() => {
					parsed.port = String(port);
					return parsed.href;
				})();
	return {
		url: configured,
		host: redirectHost === "localhost" ? "127.0.0.1" : redirectHost,
		redirectHost,
		port,
		path: parsed.pathname,
		fixedRedirectUrl: fixed,
	};
}
