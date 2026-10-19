import { isObject } from "../protocol/jsonrpc.ts";
export interface OAuthProtectedResourceMetadata {
	resource: string;
	authorization_servers?: string[];
	scopes_supported?: string[];
	[key: string]: unknown;
}
export interface AuthorizationServerMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	response_types_supported: string[];
	registration_endpoint?: string;
	scopes_supported?: string[];
	grant_types_supported?: string[];
	token_endpoint_auth_methods_supported?: string[];
	code_challenge_methods_supported?: string[];
	client_id_metadata_document_supported?: boolean;
	authorization_response_iss_parameter_supported?: boolean;
	[key: string]: unknown;
}
export interface OAuthTokens {
	access_token: string;
	token_type: string;
	expires_in?: number;
	scope?: string;
	refresh_token?: string;
	id_token?: string;
}
export interface OAuthClientMetadata {
	redirect_uris: string[];
	token_endpoint_auth_method?: string;
	grant_types?: string[];
	response_types?: string[];
	application_type?: string;
	client_name?: string;
	client_uri?: string;
	logo_uri?: string;
	scope?: string;
	contacts?: string[];
	tos_uri?: string;
	policy_uri?: string;
	jwks_uri?: string;
	jwks?: unknown;
	software_id?: string;
	software_version?: string;
	software_statement?: string;
}
export interface OAuthClientInformation {
	client_id: string;
	client_secret?: string;
	client_id_issued_at?: number;
	client_secret_expires_at?: number;
}
export type OAuthClientInformationFull = OAuthClientInformation & OAuthClientMetadata;
export type OAuthClientInformationMixed = OAuthClientInformation | OAuthClientInformationFull;
export interface OAuthDiscoveryState {
	authorizationServerUrl: string;
	authorizationServerMetadata?: AuthorizationServerMetadata;
	resourceMetadata?: OAuthProtectedResourceMetadata;
	resourceMetadataUrl?: string;
}
export interface OAuthServerInfo {
	authorizationServerUrl: string;
	authorizationServerMetadata?: AuthorizationServerMetadata;
	resourceMetadata?: OAuthProtectedResourceMetadata;
}
export interface OAuthChallenge {
	resourceMetadataUrl?: URL;
	scope?: string;
	error?: string;
	errorDescription?: string;
}
function input(value: unknown, name: string): Record<string, unknown> {
	if (!isObject(value)) throw new Error(`Invalid ${name}`);
	return value;
}
function string(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Invalid ${name}`);
	return value;
}
function absent(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}
function optional(value: unknown, name: string): string | undefined {
	return absent(value) ? undefined : string(value, name);
}
function strings(value: unknown, name: string): string[] | undefined {
	if (value === undefined || value === null) return;
	if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string"))
		throw new Error(`Invalid ${name}`);
	return [...value];
}
function url(value: unknown, name: string): string {
	const text = string(value, name);
	if (!URL.canParse(text) || ["javascript:", "data:", "vbscript:"].includes(new URL(text).protocol))
		throw new Error(`Invalid ${name}`);
	return text;
}
function optionalUrl(value: unknown, name: string): string | undefined {
	return absent(value) ? undefined : url(value, name);
}
function defined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
export function parseProtectedResourceMetadata(value: unknown): OAuthProtectedResourceMetadata {
	const row = input(value, "OAuth protected resource metadata");
	return defined({
		...row,
		resource: url(row.resource, "OAuth protected resource metadata resource"),
		authorization_servers: strings(row.authorization_servers, "authorization_servers")?.map((v) =>
			url(v, "authorization server URL"),
		),
		scopes_supported: strings(row.scopes_supported, "scopes_supported"),
	});
}
export function parseAuthorizationServerMetadata(value: unknown): AuthorizationServerMetadata {
	const row = input(value, "authorization server metadata"),
		response = strings(row.response_types_supported, "response_types_supported");
	if (!response) throw new Error("Invalid response_types_supported");
	return defined({
		...row,
		issuer: url(row.issuer, "authorization server issuer"),
		authorization_endpoint: url(row.authorization_endpoint, "authorization endpoint"),
		token_endpoint: url(row.token_endpoint, "token endpoint"),
		registration_endpoint: optionalUrl(row.registration_endpoint, "registration endpoint"),
		scopes_supported: strings(row.scopes_supported, "scopes_supported"),
		response_types_supported: response,
		grant_types_supported: strings(row.grant_types_supported, "grant_types_supported"),
		token_endpoint_auth_methods_supported: strings(
			row.token_endpoint_auth_methods_supported,
			"token_endpoint_auth_methods_supported",
		),
		code_challenge_methods_supported: strings(row.code_challenge_methods_supported, "code_challenge_methods_supported"),
		client_id_metadata_document_supported:
			typeof row.client_id_metadata_document_supported === "boolean"
				? row.client_id_metadata_document_supported
				: undefined,
		authorization_response_iss_parameter_supported:
			typeof row.authorization_response_iss_parameter_supported === "boolean"
				? row.authorization_response_iss_parameter_supported
				: undefined,
	});
}
export function parseOAuthTokens(value: unknown): OAuthTokens {
	const row = input(value, "OAuth token response"),
		expires = absent(row.expires_in) ? undefined : Number(row.expires_in);
	if (expires !== undefined && !Number.isFinite(expires)) throw new Error("Invalid expires_in");
	return defined({
		access_token: string(row.access_token, "access_token"),
		token_type: string(row.token_type, "token_type"),
		expires_in: expires,
		scope: optional(row.scope, "scope"),
		refresh_token: optional(row.refresh_token, "refresh_token"),
		id_token: optional(row.id_token, "id_token"),
	});
}
export function parseClientInformation(value: unknown): OAuthClientInformationFull {
	const row = input(value, "OAuth client registration response");
	return defined({
		...row,
		client_id: string(row.client_id, "client_id"),
		client_secret: optional(row.client_secret, "client_secret"),
		client_id_issued_at: typeof row.client_id_issued_at === "number" ? row.client_id_issued_at : undefined,
		client_secret_expires_at:
			typeof row.client_secret_expires_at === "number" ? row.client_secret_expires_at : undefined,
		redirect_uris: strings(row.redirect_uris, "redirect_uris") ?? [],
	});
}
