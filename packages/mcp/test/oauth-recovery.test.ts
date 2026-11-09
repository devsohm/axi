import { expect, test, vi } from "vitest";
import {
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	MemoryOAuthStateStore,
	OAuthInsecureEndpointError,
	type McpOAuthState,
	type OAuthClientProvider,
} from "../src/oauth/index.ts";
import type { McpFetch } from "../src/index.ts";

const serverUrl = "https://tools.example/mcp";
const metadata = {
	issuer: "https://identity.example",
	authorization_endpoint: "https://identity.example/authorize",
	token_endpoint: "https://identity.example/token",
	registration_endpoint: "https://identity.example/register",
	response_types_supported: ["code"],
};
function setup() {
	const store = new MemoryOAuthStateStore();
	store.save({
		serverUrl,
		clientInformation: { client_id: "old-client" },
		tokens: { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" },
		discovery: { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata },
		codeVerifier: "original-verifier",
		oauthState: "original-state",
	});
	const redirect = vi.fn<(url: URL) => void>();
	const provider = new McpOAuthProvider({
		serverUrl,
		redirectUrl: "http://localhost/callback",
		clientMetadata: { client_name: "test-client" },
		store,
		onRedirect: redirect,
	});
	return { store, provider, redirect };
}
function discovery(input: string | URL): Response {
	const url = new URL(input);
	if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
		return Response.json({ resource: serverUrl, authorization_servers: [metadata.issuer] });
	if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json(metadata);
	throw new Error(`Unexpected discovery request ${url}`);
}
function saved(store: MemoryOAuthStateStore): McpOAuthState {
	const value = store.load();
	if (!value) throw new Error("Missing saved authorization state");
	return value;
}

test.each(["invalid_client", "unauthorized_client"])(
	"%s discards an unusable registration before starting fresh authorization",
	async (code) => {
		const { store, provider, redirect } = setup();
		const tokenRequests: URLSearchParams[] = [];
		const fetch: McpFetch = async (input, init) => {
			if (String(input) === metadata.token_endpoint) {
				tokenRequests.push(new URLSearchParams(String(init?.body)));
				return Response.json({ error: code }, { status: 401 });
			}
			if (String(input) === metadata.registration_endpoint)
				return Response.json({ client_id: "fresh-client", redirect_uris: [provider.redirectUrl] });
			return discovery(input);
		};
		expect(await authorizeMcp(provider, { serverUrl, fetch })).toBe("REDIRECT");
		expect(tokenRequests.map((body) => body.get("client_id"))).toEqual(["old-client"]);
		expect(saved(store).clientInformation?.client_id).toBe("fresh-client");
		expect(saved(store).tokens).toBeUndefined();
		expect(saved(store).oauthState).not.toBe("original-state");
		expect(redirect.mock.calls[0]?.[0].searchParams.get("client_id")).toBe("fresh-client");
	},
);

test.each(["invalid_client", "unauthorized_client"])(
	"refresh-only %s clears the rejected client without opening a browser",
	async (code) => {
		const { store, provider, redirect } = setup();
		const fetch: McpFetch = async (input) =>
			String(input) === metadata.token_endpoint ? Response.json({ error: code }, { status: 401 }) : discovery(input);
		expect(await authorizeMcp(provider, { serverUrl, fetch, refreshOnly: true })).toBe("REDIRECT");
		expect(saved(store)).toMatchObject({ codeVerifier: "original-verifier", oauthState: "original-state" });
		expect(saved(store).clientInformation).toBeUndefined();
		expect(saved(store).tokens).toBeUndefined();
		expect(redirect).not.toHaveBeenCalled();
	},
);

test("refresh-only recovery keeps a registration another caller has already replaced", async () => {
	const { store, provider, redirect } = setup();
	const clients: (string | null)[] = [];
	const fetch: McpFetch = async (_input, init) => {
		const body = new URLSearchParams(String(init?.body));
		clients.push(body.get("client_id"));
		if (clients.length === 1) {
			store.save({
				...saved(store),
				clientInformation: { client_id: "replacement-client" },
				tokens: { access_token: "replacement-access", refresh_token: "replacement-refresh", token_type: "Bearer" },
			});
			return Response.json({ error: "invalid_client" }, { status: 401 });
		}
		expect(body.get("refresh_token")).toBe("replacement-refresh");
		return Response.json({ access_token: "fresh-access", token_type: "Bearer" });
	};
	expect(await authorizeMcp(provider, { serverUrl, fetch, refreshOnly: true })).toBe("AUTHORIZED");
	expect(clients).toEqual(["old-client", "replacement-client"]);
	expect(saved(store).clientInformation?.client_id).toBe("replacement-client");
	expect(saved(store).tokens?.access_token).toBe("fresh-access");
	expect(redirect).not.toHaveBeenCalled();
});

test("an invalid grant removes the rejected tokens while keeping registration and login state", async () => {
	const { store, provider, redirect } = setup();
	const fetch = vi.fn<McpFetch>(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
	expect(await authorizeMcp(provider, { serverUrl, fetch })).toBe("REDIRECT");
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(saved(store)).toMatchObject({ clientInformation: { client_id: "old-client" }, oauthState: "original-state" });
	expect(saved(store).tokens).toBeUndefined();
	expect(redirect.mock.calls[0]?.[0].searchParams.get("client_id")).toBe("old-client");
});

test("cancellation during a refresh preserves the cancellation error and saved credentials", async () => {
	const { store, provider, redirect } = setup();
	const controller = new AbortController();
	const failure = new Error("refresh cancelled");
	const before = saved(store);
	const fetch: McpFetch = async (_input, init) => {
		expect(init?.signal).toBe(controller.signal);
		controller.abort(failure);
		throw failure;
	};
	await expect(authorizeMcp(provider, { serverUrl, fetch, signal: controller.signal })).rejects.toBe(failure);
	expect(saved(store)).toEqual(before);
	expect(redirect).not.toHaveBeenCalled();
});

test("an insecure token endpoint fails without falling back to browser authorization", async () => {
	const { store, provider, redirect } = setup();
	store.save({
		...saved(store),
		discovery: {
			authorizationServerUrl: metadata.issuer,
			authorizationServerMetadata: { ...metadata, token_endpoint: "http://identity.example/token" },
		},
	});
	const fetch = vi.fn<McpFetch>();
	await expect(authorizeMcp(provider, { serverUrl, fetch })).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
	expect(fetch).not.toHaveBeenCalled();
	expect(redirect).not.toHaveBeenCalled();
	expect(saved(store).tokens?.access_token).toBe("old-access");
});

test.each([new Error("connection lost"), "connection lost"])(
	"a transport refresh failure can fall back to an interactive authorization: %j",
	async (failure) => {
		const { provider, redirect } = setup();
		expect(
			await authorizeMcp(provider, {
				serverUrl,
				fetch: async () => {
					throw failure;
				},
			}),
		).toBe("REDIRECT");
		expect(redirect).toHaveBeenCalledTimes(1);
	},
);

test("saved issuer metadata is discovered when only its issuer URL was persisted", async () => {
	const { store, provider, redirect } = setup();
	store.save({ ...saved(store), tokens: undefined, discovery: { authorizationServerUrl: metadata.issuer } });
	const fetch = vi.fn<McpFetch>(async (input) => discovery(input));
	expect(await authorizeMcp(provider, { serverUrl, fetch })).toBe("REDIRECT");
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(String(fetch.mock.calls[0]?.[0])).toBe(metadata.issuer + "/.well-known/oauth-authorization-server");
	expect(saved(store).discovery?.authorizationServerMetadata).toEqual(metadata);
	expect(redirect.mock.calls[0]?.[0].origin).toBe(metadata.issuer);
});

test.each(["http://app.example/client.json", "https://app.example/"])(
	"an invalid client metadata document URL is rejected before authorization: %s",
	async (url) => {
		const { store } = setup();
		store.save({ ...saved(store), clientInformation: undefined, tokens: undefined });
		const redirect = vi.fn();
		const provider = new McpOAuthProvider({
			serverUrl,
			store,
			redirectUrl: "http://localhost/callback",
			clientMetadata: {},
			onRedirect: redirect,
			clientMetadataDocument: () => ({ url, redirectUrl: "http://localhost/callback" }),
		});
		const fetch = vi.fn<McpFetch>();
		await expect(authorizeMcp(provider, { serverUrl, fetch })).rejects.toThrow("Invalid OAuth client metadata URL");
		expect(fetch).not.toHaveBeenCalled();
		expect(redirect).not.toHaveBeenCalled();
	},
);

test("a code cannot be exchanged after its client registration was removed", async () => {
	const { store, provider, redirect } = setup();
	store.save({ ...saved(store), clientInformation: undefined });
	const fetch = vi.fn<McpFetch>();
	await expect(authorizeMcp(provider, { serverUrl, fetch, authorizationCode: "code" })).rejects.toThrow(
		"client information is missing",
	);
	expect(fetch).not.toHaveBeenCalled();
	expect(redirect).not.toHaveBeenCalled();
});

test("registration requires a provider that can persist its resulting client", async () => {
	const { provider } = setup();
	const readOnlyProvider: OAuthClientProvider = {
		redirectUrl: provider.redirectUrl,
		clientMetadata: provider.clientMetadata,
		clientInformation: () => undefined,
		tokens: () => undefined,
		saveTokens: (tokens) => provider.saveTokens(tokens),
		redirectToAuthorization: (url) => provider.redirectToAuthorization(url),
		saveCodeVerifier: (code) => provider.saveCodeVerifier(code),
		codeVerifier: () => provider.codeVerifier(),
		discoveryState: () => provider.discoveryState(),
	};
	const fetch = vi.fn<McpFetch>();
	await expect(authorizeMcp(readOnlyProvider, { serverUrl, fetch })).rejects.toThrow("cannot be persisted");
	expect(fetch).not.toHaveBeenCalled();
});

test.each([undefined, "read", "read write"])(
	"an insufficient-scope challenge merges %j with newly requested scopes without refreshing",
	async (scope) => {
		const { store, provider, redirect } = setup();
		store.save({
			...saved(store),
			tokens: { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer", scope },
		});
		const auth = adaptOAuthProvider(provider);
		const fetch = vi.fn<McpFetch>();
		const context = {
			serverUrl: new URL(serverUrl),
			token: "old-access",
			fetch,
			response: new Response(null, {
				status: 403,
				headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="write admin"' },
			}),
		};
		await expect(auth.onUnauthorized?.(context)).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		expect(fetch).not.toHaveBeenCalled();
		expect(redirect.mock.calls[0]?.[0].searchParams.get("scope")).toBe(scope ? "read write admin" : "write admin");
	},
);
