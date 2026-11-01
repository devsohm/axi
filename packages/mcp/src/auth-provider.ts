export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface UnauthorizedContext {
	response: Response;
	serverUrl: URL;
	fetch: McpFetch;
	token?: string;
}
export interface AuthProvider {
	token(): Promise<string | undefined>;
	onUnauthorized?(context: UnauthorizedContext): Promise<void>;
}
