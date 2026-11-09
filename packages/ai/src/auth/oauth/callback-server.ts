import { createServer, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.ts";
import type { ProviderAuthInteraction } from "../types.ts";
export interface OAuthCallbackServerOptions<T> {
	providerName: string;
	host: string;
	port: number;
	path: string;
	redirectHost?: string;
	state?: string;
	complete: (code: string) => Promise<T>;
	signal?: AbortSignal;
	timeoutMs?: number;
}
export interface OAuthCallbackServer<T> {
	redirectUri: string;
	wait(): Promise<T | undefined>;
	cancel(): void;
	close(): void;
}
export async function startOAuthCallbackServer<T>(
	options: OAuthCallbackServerOptions<T>,
): Promise<OAuthCallbackServer<T>> {
	const { providerName, signal } = options;
	if (signal?.aborted) throw new Error("Login cancelled");
	const waiting = Promise.withResolvers<T | undefined>();
	void waiting.promise.catch(() => {});
	let claimed = false,
		settled = false,
		timer: ReturnType<typeof setTimeout> | undefined;
	const finish = (result: { value: T | undefined } | { error: Error }) => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if ("error" in result) waiting.reject(result.error);
		else waiting.resolve(result.value);
	};
	const abort = () => finish({ error: new Error("Login cancelled") });
	const send = (response: ServerResponse, status: number, html: string) => {
		response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(html);
	};
	const handle = async (request: import("node:http").IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (request.method !== "GET" || url.pathname !== options.path) {
			send(response, 404, oauthErrorHtml("Callback route not found."));
			return;
		}
		if (options.state !== undefined && url.searchParams.get("state") !== options.state) {
			send(response, 400, oauthErrorHtml("State mismatch."));
			return;
		}
		if (claimed || settled) {
			send(response, 409, oauthErrorHtml("This sign-in has already been handled."));
			return;
		}
		const error = url.searchParams.get("error");
		if (error) {
			const detail = url.searchParams.get("error_description") ?? error;
			send(response, 400, oauthErrorHtml(`${providerName} authorization failed.`, detail));
			finish({ error: new Error(`${providerName} authorization failed: ${detail}`) });
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			send(response, 400, oauthErrorHtml("Missing authorization code."));
			return;
		}
		claimed = true;
		try {
			const value = await options.complete(code);
			send(response, 200, oauthSuccessHtml(`Signed in to ${providerName}. You may now close this page.`));
			finish({ value });
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			send(response, 502, oauthErrorHtml(`${providerName} sign-in failed.`, failure.message));
			finish({ error: failure });
		}
	};
	const server = createServer((request, response) => {
		void handle(request, response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("OAuth callback server did not bind to TCP");
	}
	server.on("error", (error) => finish({ error }));
	signal?.addEventListener("abort", abort, { once: true });
	if (options.timeoutMs !== undefined)
		timer = setTimeout(() => finish({ error: new Error(`${providerName} sign-in timed out`) }), options.timeoutMs);
	const host = options.redirectHost ?? options.host;
	return {
		redirectUri: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}${options.path}`,
		wait: () => waiting.promise,
		cancel() {
			if (!claimed) finish({ value: undefined });
		},
		close() {
			finish({ error: new Error("OAuth callback server closed") });
			server.close();
		},
	};
}
export async function waitForCallbackOrManualInput<T>(
	interaction: ProviderAuthInteraction,
	callback: OAuthCallbackServer<T> | undefined,
	prompt: { message: string; placeholder: string },
): Promise<{ type: "callback"; value: T } | { type: "manual"; input: string }> {
	const controller = new AbortController();
	let failure: Error | undefined;
	const manual = interaction
		.prompt({ type: "manual_code", ...prompt, signal: controller.signal })
		.then((input) => {
			callback?.cancel();
			return input;
		})
		.catch((error) => {
			failure = error instanceof Error ? error : new Error(String(error));
			callback?.cancel();
			return undefined;
		});
	try {
		const value = await callback?.wait();
		if (failure) throw failure;
		if (value !== undefined) return { type: "callback", value };
		const input = await manual;
		if (failure) throw failure;
		return { type: "manual", input: input ?? "" };
	} finally {
		controller.abort();
	}
}
