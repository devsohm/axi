import { createServer, type Server, type ServerResponse } from "node:http";
export interface OAuthCallback {
	code: string;
	state: string;
	iss?: string;
}
export type OAuthCallbackPage = { ok: true } | { ok: false; message: string; details?: string };
export interface OAuthCallbackServerOptions {
	host?: string;
	redirectHost?: string;
	port?: number;
	path?: string;
	extraPaths?: string[];
	timeoutMs?: number;
	renderPage?: (page: OAuthCallbackPage) => string;
}
type Waiting = {
	resolve(value: OAuthCallback): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	path?: string;
};
export class OAuthCallbackServer {
	readonly redirectUrl: string;
	readonly #server: Server;
	readonly #paths: string[];
	readonly #timeout: number;
	readonly #render?: (page: OAuthCallbackPage) => string;
	readonly #pending = new Map<string, Waiting>();
	private constructor(server: Server, redirectUrl: string, paths: string[], options: OAuthCallbackServerOptions) {
		this.#server = server;
		this.redirectUrl = redirectUrl;
		this.#paths = paths;
		this.#timeout = options.timeoutMs ?? 300000;
		this.#render = options.renderPage;
	}
	static async listen(options: OAuthCallbackServerOptions = {}): Promise<OAuthCallbackServer> {
		const host = options.host ?? "127.0.0.1",
			redirectHost = options.redirectHost ?? host,
			path = options.path ?? "/callback";
		let instance: OAuthCallbackServer | undefined;
		const server = createServer((request, response) => {
			if (instance) instance.#handle(request.url ?? "/", response);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 0, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("OAuth callback server did not bind to TCP");
		instance = new OAuthCallbackServer(
			server,
			`http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${address.port}${path}`,
			[path, ...(options.extraPaths ?? [])],
			options,
		);
		return instance;
	}
	waitForCallback(state: string, path?: string): Promise<OAuthCallback> {
		if (this.#pending.has(state)) throw new Error("OAuth state is already pending");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(state);
				reject(new Error("OAuth callback timed out"));
			}, this.#timeout);
			this.#pending.set(state, { resolve, reject, timer, path });
		});
	}
	#reply(response: ServerResponse, status: number, page: OAuthCallbackPage): void {
		if (this.#render) {
			response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(this.#render(page));
		} else
			response
				.writeHead(status, { "content-type": "text/plain; charset=utf-8" })
				.end(
					page.ok
						? "Authorization complete. You may close this window."
						: page.details
							? `${page.message}\n\n${page.details}`
							: page.message,
				);
	}
	#handle(input: string, response: ServerResponse): void {
		const url = new URL(input, this.redirectUrl);
		if (!this.#paths.includes(url.pathname)) {
			this.#reply(response, 404, { ok: false, message: "Not found" });
			return;
		}
		const state = url.searchParams.get("state"),
			waiting = state ? this.#pending.get(state) : undefined;
		if (!state || !waiting) {
			this.#reply(response, 400, { ok: false, message: "Invalid or expired OAuth state" });
			return;
		}
		clearTimeout(waiting.timer);
		this.#pending.delete(state);
		if (waiting.path !== undefined && waiting.path !== url.pathname) {
			waiting.reject(new Error("The authorization response arrived on another redirect URI"));
			this.#reply(response, 400, { ok: false, message: "Unexpected redirect URI" });
			return;
		}
		const error = url.searchParams.get("error");
		if (error) {
			const details = url.searchParams.get("error_description") ?? error;
			waiting.reject(new Error(details));
			this.#reply(response, 200, { ok: false, message: "Authorization failed. You may close this window.", details });
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			waiting.reject(new Error("OAuth callback did not include an authorization code"));
			this.#reply(response, 400, { ok: false, message: "Missing authorization code" });
			return;
		}
		const iss = url.searchParams.get("iss");
		waiting.resolve({ code, state, ...(iss ? { iss } : {}) });
		this.#reply(response, 200, { ok: true });
	}
	async close(): Promise<void> {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("OAuth callback server closed"));
		}
		this.#pending.clear();
		await new Promise<void>((resolve, reject) => this.#server.close((error) => (error ? reject(error) : resolve())));
	}
}
