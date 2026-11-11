export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface UnauthorizedContext {
	response: Response;
	serverUrl: URL;
	fetch: McpFetch;
	token?: string;
}
export interface AuthProvider {
	token(): Promise<string | undefined>;
	/** The HTTP transport calls this once for an authorization failure, then reads the token again for one retry. */
	onUnauthorized?(context: UnauthorizedContext): Promise<void>;
}
