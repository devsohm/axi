import { OAuthCallbackServer, type OAuthCallbackPage } from "./callback.ts";
import {
	loopbackSettings,
	offersClientMetadataDocument,
	registeredRedirectUrls,
	serverSpecificPath,
	type McpOAuthSettings,
	type McpClientMetadataDocuments,
} from "./client-settings.ts";
import type { McpOAuthStateStore } from "./provider.ts";
import {
	cancellable,
	McpSignInCancelledError,
	type McpSignInRedirect,
	type McpAuthorizationResponse,
} from "./sign-in.ts";

export interface McpLoopbackCallback {
	callback: OAuthCallbackServer;
	redirectUrl: string;
}
export async function listenForLoopbackSignIn(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
	clientMetadataDocuments?: McpClientMetadataDocuments;
	renderPage?: (page: OAuthCallbackPage) => string;
}): Promise<McpLoopbackCallback> {
	const where = loopbackSettings(options.settings);
	const registered = registeredRedirectUrls((await options.store.load())?.clientInformation)[0];
	const preferred = where.port ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
	const base = {
		host: where.host,
		redirectHost: where.redirectHost,
		path: where.path,
		renderPage: options.renderPage,
		extraPaths: offersClientMetadataDocument(options.settings, options.clientMetadataDocuments, where.url)
			? [serverSpecificPath(where.path, options.serverUrl)]
			: [],
	};
	let callback: OAuthCallbackServer;
	try {
		callback = await OAuthCallbackServer.listen({ ...base, port: preferred ?? 0 });
	} catch (error) {
		if (where.port !== undefined || preferred === undefined) throw error;
		callback = await OAuthCallbackServer.listen(base);
	}
	return { callback, redirectUrl: where.fixedRedirectUrl ?? callback.redirectUrl };
}
export function responseFromRedirectUrl(
	input: string,
	authorization: Pick<McpSignInRedirect, "state" | "redirectUrl">,
): McpAuthorizationResponse {
	const url = URL.parse(input.trim());
	if (!url) throw new Error("Expected the full redirect URL from the browser address bar");
	const expected = new URL(authorization.redirectUrl);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname)
		throw new Error("The redirect URL does not match this sign-in's redirect URI");
	const error = url.searchParams.get("error");
	if (error) throw new Error(url.searchParams.get("error_description") ?? error);
	const state = url.searchParams.get("state");
	if (state !== authorization.state) throw new Error("The redirect URL belongs to a different sign-in");
	const code = url.searchParams.get("code");
	if (!code) throw new Error("The redirect URL does not contain an authorization code");
	const iss = url.searchParams.get("iss");
	return { code, state, ...(iss ? { iss } : {}) };
}
export async function waitForLoopbackSignIn(options: {
	callback: OAuthCallbackServer;
	authorization: McpSignInRedirect;
	promptForRedirectUrl?: (signal: AbortSignal) => Promise<string | undefined>;
	signal?: AbortSignal;
}): Promise<McpAuthorizationResponse> {
	const prompt = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, prompt.signal]) : prompt.signal;
	const browser = options.callback.waitForCallback(
		options.authorization.state,
		new URL(options.authorization.redirectUrl).pathname,
	);
	const manual = options.promptForRedirectUrl
		? options.promptForRedirectUrl(signal).then((input) => {
				if (!input?.trim()) throw new McpSignInCancelledError();
				return responseFromRedirectUrl(input, options.authorization);
			})
		: new Promise<never>((_, reject) => {
				signal.addEventListener("abort", () => reject(new McpSignInCancelledError()), { once: true });
			});
	try {
		return await cancellable(options.signal, () => Promise.race([browser, manual]));
	} finally {
		prompt.abort();
		void browser.catch(() => undefined);
		void manual.catch(() => undefined);
	}
}
