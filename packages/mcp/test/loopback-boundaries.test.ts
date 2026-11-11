import { expect, test } from "vitest";
import { OAuthCallbackServer } from "../src/oauth/callback.ts";
import { listenForLoopbackSignIn, responseFromRedirectUrl, waitForLoopbackSignIn } from "../src/oauth/loopback.ts";
import { MemoryOAuthStateStore } from "../src/oauth/provider.ts";
import { serverSpecificPath } from "../src/oauth/client-settings.ts";
import type { McpSignInRedirect } from "../src/oauth/sign-in.ts";

function authorization(state: string, redirectUrl: string): McpSignInRedirect {
	return { kind: "redirect", state, redirectUrl, authorizationUrl: "https://login.invalid/authorize" };
}

test("default callback pages report invalid states, denied authorization and success", async () => {
	const callback = await OAuthCallbackServer.listen();
	try {
		const invalid = await fetch(callback.redirectUrl);
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).toBe("Invalid or expired OAuth state");
		const denied = expect(callback.waitForCallback("denied")).rejects.toThrow("access_denied");
		const response = await fetch(callback.redirectUrl + "?state=denied&error=access_denied");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("\n\naccess_denied");
		await denied;
		const ready = callback.waitForCallback("ready");
		expect(await (await fetch(callback.redirectUrl + "?state=ready&code=local")).text()).toContain(
			"Authorization complete",
		);
		expect(await ready).toEqual({ state: "ready", code: "local" });
	} finally {
		await callback.close();
	}
});

test.each([
	["not a URL", "full redirect URL"],
	["http://localhost/other?state=s&code=c", "does not match"],
	["http://other.invalid/callback?state=s&code=c", "does not match"],
	["http://localhost/callback?state=s&error=denied", "denied"],
	["http://localhost/callback?state=s&error=denied&error_description=No+access", "No access"],
	["http://localhost/callback?state=other&code=c", "different sign-in"],
	["http://localhost/callback?state=s", "authorization code"],
])("manual redirect rejects %s", (input, message) => {
	expect(() => responseFromRedirectUrl(input, { state: "s", redirectUrl: "http://localhost/callback" })).toThrow(
		message,
	);
});

test("manual callback accepts whitespace and issuer, and cancels the unused browser wait on close", async () => {
	const callback = await OAuthCallbackServer.listen();
	let promptSignal: AbortSignal | undefined;
	try {
		const response = await waitForLoopbackSignIn({
			callback,
			authorization: authorization("manual", callback.redirectUrl),
			promptForRedirectUrl: async (signal) => {
				promptSignal = signal;
				return `  ${callback.redirectUrl}?code=accepted&state=manual&iss=local  `;
			},
		});
		expect(response).toEqual({ code: "accepted", state: "manual", iss: "local" });
		expect(promptSignal?.aborted).toBe(true);
	} finally {
		await callback.close();
	}
});

test("browser completion cancels the manual prompt and preserves its response", async () => {
	const callback = await OAuthCallbackServer.listen();
	let promptSignal: AbortSignal | undefined;
	try {
		const pending = waitForLoopbackSignIn({
			callback,
			authorization: authorization("browser", callback.redirectUrl),
			promptForRedirectUrl: (signal) => {
				promptSignal = signal;
				return new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
				);
			},
		});
		await (await fetch(callback.redirectUrl + "?state=browser&code=accepted")).text();
		expect(await pending).toEqual({ state: "browser", code: "accepted" });
		expect(promptSignal?.aborted).toBe(true);
	} finally {
		await callback.close();
	}
});

test("a pending manual prompt keeps the authorization it started with", async () => {
	const callback = await OAuthCallbackServer.listen();
	const input = Promise.withResolvers<string>();
	const options = {
		callback,
		authorization: authorization("original", callback.redirectUrl),
		promptForRedirectUrl: () => input.promise,
	};
	try {
		const result = waitForLoopbackSignIn(options);
		options.authorization = authorization("replacement", callback.redirectUrl);
		input.resolve(`${callback.redirectUrl}?state=original&code=accepted`);
		await expect(result).resolves.toEqual({ state: "original", code: "accepted" });
	} finally {
		await callback.close();
	}
});

test.each([undefined, "", "  "])("an empty manual response cancels authorization: %j", async (input) => {
	const callback = await OAuthCallbackServer.listen();
	try {
		await expect(
			waitForLoopbackSignIn({
				callback,
				authorization: authorization("manual", callback.redirectUrl),
				promptForRedirectUrl: async () => input,
			}),
		).rejects.toThrow(/cancel/i);
	} finally {
		await callback.close();
	}
});

test("abort settles the browser-only wait without waiting for the callback timeout", async () => {
	const callback = await OAuthCallbackServer.listen();
	const controller = new AbortController();
	try {
		const result = expect(
			waitForLoopbackSignIn({
				callback,
				authorization: authorization("abort", callback.redirectUrl),
				signal: controller.signal,
			}),
		).rejects.toThrow(/cancel/i);
		controller.abort();
		await result;
	} finally {
		await callback.close();
	}
});

test("an occupied registered callback port falls back to a new one without changing saved credentials", async () => {
	const occupied = await OAuthCallbackServer.listen();
	const store = new MemoryOAuthStateStore();
	const state = {
		serverUrl: "https://mcp.invalid",
		clientInformation: { client_id: "local", redirect_uris: [occupied.redirectUrl] },
	};
	store.save(state);
	try {
		const { callback, redirectUrl } = await listenForLoopbackSignIn({
			serverUrl: state.serverUrl,
			store,
			settings: {},
		});
		try {
			expect(new URL(redirectUrl).port).not.toBe(new URL(occupied.redirectUrl).port);
			expect(store.load()).toEqual(state);
		} finally {
			await callback.close();
		}
		await expect(
			listenForLoopbackSignIn({
				serverUrl: state.serverUrl,
				store,
				settings: { callbackPort: Number(new URL(occupied.redirectUrl).port) },
			}),
		).rejects.toMatchObject({ code: "EADDRINUSE" });
	} finally {
		await occupied.close();
	}
});

test("metadata-document sign-ins accept the server-specific callback path", async () => {
	const serverUrl = "https://mcp.invalid/server";
	const { callback } = await listenForLoopbackSignIn({
		serverUrl,
		store: new MemoryOAuthStateStore(),
		settings: { clientRegistration: "cimd" },
	});
	try {
		const path = serverSpecificPath(new URL(callback.redirectUrl).pathname, serverUrl);
		const redirect = authorization("metadata", new URL(path, callback.redirectUrl).href);
		const pending = waitForLoopbackSignIn({ callback, authorization: redirect });
		expect((await fetch(redirect.redirectUrl + "?state=metadata&code=local")).status).toBe(200);
		expect(await pending).toEqual({ state: "metadata", code: "local" });
	} finally {
		await callback.close();
	}
});
