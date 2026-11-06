interface McpServerConfigBase {
	description?: string;
	enabled?: boolean;
	timeout?: number;
}
export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}
export interface McpOAuthConfig {
	clientId?: string;
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
	clientName?: string;
	clientRegistration?: "auto" | "dcr" | "cimd";
	authServerMetadataUrl?: string;
}
export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
}
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
export type McpServerConfigResult =
	| { kind: "stdio"; config: McpStdioServerConfig & Record<string, unknown> }
	| { kind: "http"; config: McpHttpServerConfig & Record<string, unknown> }
	| { kind: "invalid"; error: string };
export interface McpServerConfigOptions {
	checkMetadataDocumentCallback?(callbackUrl: string | undefined): string | undefined;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringMap(value: unknown): value is Record<string, string> {
	return record(value) && Object.values(value).every((item) => typeof item === "string");
}
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
function oauthError(value: unknown, options: McpServerConfigOptions): string | undefined {
	if (value === undefined) return;
	if (!record(value)) return "oauth must be an object";
	for (const field of ["clientId", "clientSecret"])
		if (value[field] !== undefined && typeof value[field] !== "string") return `oauth.${field} must be a string`;
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535))
		return "oauth.callbackPort must be a port number";
	if (value.callbackUrl !== undefined) {
		const uri = typeof value.callbackUrl === "string" ? URL.parse(value.callbackUrl) : null;
		if (!uri || uri.protocol !== "http:" || !loopback.has(uri.hostname) || uri.search || uri.hash)
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		if (uri.port && port !== undefined && Number(uri.port) !== port)
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim()))
		return "oauth.clientName must be a non-empty string";
	if (
		value.clientRegistration !== undefined &&
		value.clientRegistration !== "auto" &&
		value.clientRegistration !== "dcr" &&
		value.clientRegistration !== "cimd"
	)
		return 'oauth.clientRegistration must be "auto", "dcr", or "cimd"';
	if (value.clientRegistration === "cimd") {
		if (value.clientId !== undefined || value.clientName !== undefined)
			return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		if (!options.checkMetadataDocumentCallback)
			return 'oauth.clientRegistration "cimd" is not supported: there are no Client ID Metadata Documents';
		const error = options.checkMetadataDocumentCallback(
			typeof value.callbackUrl === "string" ? value.callbackUrl : undefined,
		);
		if (error) return error;
	}
	if (value.authServerMetadataUrl !== undefined) {
		const uri = typeof value.authServerMetadataUrl === "string" ? URL.parse(value.authServerMetadataUrl) : null;
		if (!uri || !(uri.protocol === "https:" || (uri.protocol === "http:" && loopback.has(uri.hostname))))
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
	}
}

export function validateMcpServerConfig(
	name: string,
	raw: unknown,
	options: McpServerConfigOptions = {},
): McpServerConfigResult {
	const invalid = (error: string): McpServerConfigResult => ({ kind: "invalid", error });
	if (!/^[A-Za-z0-9_-]+$/.test(name))
		return invalid(`invalid server name "${name}" (use letters, digits, "_" and "-")`);
	if (!record(raw)) return invalid(`server "${name}" must be an object`);
	const fail = (error: string) => invalid(`server "${name}": ${error}`);
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return fail("enabled must be a boolean");
	if (raw.description !== undefined && typeof raw.description !== "string") return fail("description must be a string");
	if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || !(raw.timeout > 0)))
		return fail("timeout must be a positive number of seconds");
	if (raw.type === "sse") return fail("legacy SSE transport is not supported; use the streamable HTTP URL");
	if (
		typeof raw.url === "string" &&
		(raw.type === undefined || raw.type === "http" || raw.type === "streamable-http")
	) {
		const uri = URL.parse(raw.url);
		if (!uri || !["http:", "https:"].includes(uri.protocol)) return fail("url must be an http or https URL");
		if (raw.headers !== undefined && !stringMap(raw.headers)) return fail("headers must map names to strings");
		const error = oauthError(raw.oauth, options);
		return error ? fail(error) : { kind: "http", config: raw as McpHttpServerConfig & Record<string, unknown> };
	}
	if (typeof raw.command === "string" && (raw.type === undefined || raw.type === "stdio")) {
		if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((item) => typeof item === "string")))
			return fail("args must be an array of strings");
		if (raw.env !== undefined && !stringMap(raw.env)) return fail("env must map names to strings");
		if (raw.cwd !== undefined && typeof raw.cwd !== "string") return fail("cwd must be a string");
		return { kind: "stdio", config: raw as McpStdioServerConfig & Record<string, unknown> };
	}
	return invalid(`server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`);
}
export function isMcpServerOverride(entry: Record<string, unknown>): boolean {
	return entry.command === undefined && entry.url === undefined && entry.type === undefined;
}
