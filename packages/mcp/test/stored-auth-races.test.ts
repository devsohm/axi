import { afterEach, expect, test, vi } from "vitest";
import type { UnauthorizedContext, McpFetch } from "../src/auth-provider.ts";
import { createMcpAuthProvider } from "../src/oauth/auth-provider.ts";
import type { McpOAuthServerStore } from "../src/oauth/client-settings.ts";
import type { McpOAuthState } from "../src/oauth/provider.ts";

afterEach(() => vi.unstubAllGlobals());
const serverUrl = "https://mcp.example.test/mcp";
function initial(): McpOAuthState {
	return {
		serverUrl,
		clientInformation: { client_id: "local-client" },
		tokens: { access_token: "old", refresh_token: "rotate", token_type: "Bearer" },
		discovery: {
			authorizationServerUrl: "https://issuer.example.test",
			authorizationServerMetadata: {
				issuer: "https://issuer.example.test",
				authorization_endpoint: "https://issuer.example.test/authorize",
				token_endpoint: "https://issuer.example.test/token",
				response_types_supported: ["code"],
				token_endpoint_auth_methods_supported: ["none"],
			},
		},
	};
}
function unauthorized(fetch: McpFetch, token = "old", challenge = "Bearer"): UnauthorizedContext {
	return {
		fetch,
		token,
		serverUrl: new URL(serverUrl),
		response: new Response(null, { status: 401, headers: { "www-authenticate": challenge } }),
	};
}

test("a second process's rotated token is used after acquiring the refresh lock", async () => {
	let state = initial();
	let locks = 0,
		requests = 0;
	const store: McpOAuthServerStore = {
		load: () => structuredClone(state),
		save(next) {
			state = next;
		},
		async withRefreshLock(fn) {
			locks++;
			state.tokens = { access_token: "newer", token_type: "Bearer" };
			return fn();
		},
	};
	const provider = createMcpAuthProvider({
		serverUrl,
		clientName: "test",
		store,
		settings: () => ({}),
		onChallenge() {},
	});
	await provider.onUnauthorized?.(
		unauthorized(async () => {
			requests++;
			throw new Error("Unexpected request");
		}),
	);
	expect(await provider.token()).toBe("newer");
	expect({ locks, requests }).toEqual({ locks: 1, requests: 0 });
});

test("concurrent unauthorized requests share one refresh and token readers await the committed rotation", async () => {
	let state = initial();
	let locks = 0,
		requests = 0;
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const store: McpOAuthServerStore = {
		load: () => structuredClone(state),
		save(next) {
			state = next;
		},
		async withRefreshLock(fn) {
			locks++;
			return fn();
		},
	};
	const fetch: McpFetch = async (url, options) => {
		requests++;
		expect(String(url)).toBe("https://issuer.example.test/token");
		expect(new URLSearchParams(String(options?.body)).get("refresh_token")).toBe("rotate");
		entered.resolve();
		await release.promise;
		return Response.json({ access_token: "fresh", refresh_token: "rotated", token_type: "Bearer" });
	};
	const provider = createMcpAuthProvider({
		serverUrl,
		clientName: "test",
		store,
		settings: () => ({}),
		onChallenge() {},
	});
	const first = provider.onUnauthorized?.(unauthorized(fetch));
	await entered.promise;
	const second = provider.onUnauthorized?.(unauthorized(fetch));
	const token = provider.token(),
		settled = provider.settled();
	try {
		expect(requests).toBe(1);
		release.resolve();
		await Promise.all([first, second, settled]);
		expect(await token).toBe("fresh");
		await provider.onUnauthorized?.(unauthorized(fetch));
		expect({ locks, requests }).toEqual({ locks: 2, requests: 1 });
		expect(state.tokens).toMatchObject({ access_token: "fresh", refresh_token: "rotated" });
	} finally {
		release.resolve();
	}
});

test("an insufficient-scope challenge requires interaction without using the refresh token", async () => {
	let locks = 0;
	const challenges: unknown[] = [];
	const store: McpOAuthServerStore = {
		load: initial,
		save() {},
		async withRefreshLock(fn) {
			locks++;
			return fn();
		},
	};
	const provider = createMcpAuthProvider({
		serverUrl,
		clientName: "test",
		store,
		settings: () => ({}),
		onChallenge: (value) => challenges.push(value),
	});
	await expect(
		provider.onUnauthorized?.(
			unauthorized(
				async () => {
					throw new Error("Unexpected request");
				},
				"old",
				'Bearer error="insufficient_scope", scope="write"',
			),
		),
	).rejects.toMatchObject({ name: "McpOAuthAuthorizationRequiredError" });
	expect(challenges).toMatchObject([{ error: "insufficient_scope", scope: "write" }]);
	expect(locks).toBe(0);
	expect(await provider.token()).toBe("old");
});

test.each(["missing-refresh-token", "missing-client"] as const)(
	"refresh requiring interaction clears its pending operation: %s",
	async (mode) => {
		const state = initial();
		if (mode === "missing-refresh-token") delete state.tokens?.refresh_token;
		else delete state.clientInformation;
		const store: McpOAuthServerStore = {
			load: () => state,
			save() {},
			async withRefreshLock(fn) {
				return fn();
			},
		};
		const provider = createMcpAuthProvider({
			serverUrl,
			clientName: "test",
			store,
			settings: () => ({}),
			onChallenge() {},
		});
		await expect(
			provider.onUnauthorized?.(
				unauthorized(async () => {
					throw new Error("Unexpected request");
				}),
			),
		).rejects.toMatchObject({ name: "McpOAuthAuthorizationRequiredError" });
		await provider.settled();
		expect(await provider.token()).toBe("old");
	},
);

test("a failed proactive refresh keeps the old token and a later request can retry", async () => {
	let state = { ...initial(), tokensExpireAt: 0 };
	let requests = 0;
	const store: McpOAuthServerStore = {
		load: () => structuredClone(state),
		save(next) {
			state = { ...next, tokensExpireAt: next.tokensExpireAt ?? 0 };
		},
		async withRefreshLock(fn) {
			return fn();
		},
	};
	const fetch: McpFetch = async () => {
		requests++;
		if (requests === 1) throw new Error("Network unavailable");
		return Response.json({ access_token: "retried", token_type: "Bearer", expires_in: 3600 });
	};
	vi.stubGlobal("fetch", fetch);
	const provider = createMcpAuthProvider({
		serverUrl,
		clientName: "test",
		store,
		settings: () => ({}),
		onChallenge() {},
	});
	expect(await provider.token()).toBe("old");
	await provider.settled();
	expect(await provider.token()).toBe("retried");
	expect(requests).toBe(2);
});
