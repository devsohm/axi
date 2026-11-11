import { expect, test } from "vitest";
import { authorizeMcp } from "../src/oauth/flow.ts";
import {
	createOAuthClientProvider,
	loopbackSettings,
	offersClientMetadataDocument,
	registeredRedirectUrls,
	serverSpecificPath,
	timedFetch,
	type McpOAuthSettings,
	type McpOAuthServerStore,
} from "../src/oauth/client-settings.ts";
import type { McpOAuthState } from "../src/oauth/provider.ts";

const callback = "http://localhost/callback";
const documents = { baseUrl: "https://app.example.test", listsRedirectUrl: (url: string) => url === callback };

test("an existing provider keeps its server-specific metadata identity when caller options change", () => {
	const options = {
		serverUrl: "https://original.example.test/mcp",
		clientName: "Axi",
		settings: {},
		clientMetadataDocuments: documents,
		store: { load: () => undefined, save() {}, withRefreshLock: async <T>(fn: () => Promise<T>) => fn() },
	};
	const provider = createOAuthClientProvider(options, callback);
	const metadata = {
		issuer: "https://login.example.test",
		authorization_endpoint: "https://login.example.test/authorize",
		token_endpoint: "https://login.example.test/token",
		response_types_supported: ["code"],
		client_id_metadata_document_supported: true,
		token_endpoint_auth_methods_supported: ["none"],
	};
	const initial = provider.clientMetadataDocument?.(metadata);
	expect(initial?.redirectUrl).toBe("http://localhost" + serverSpecificPath("/callback", options.serverUrl));
	options.serverUrl = "https://replacement.example.test/mcp";
	expect(provider.clientMetadataDocument?.(metadata)).toEqual(initial);
});

test("client metadata registration respects explicit choices and automatic eligibility", () => {
	for (const [settings, listed, expected] of [
		[{}, true, true],
		[{}, false, false],
		[{ clientId: "fixed" }, true, false],
		[{ clientName: "custom" }, true, false],
		[{ clientRegistration: "dcr" }, true, false],
		[{ clientRegistration: "cimd" }, false, true],
		[{ clientRegistration: "auto" }, true, true],
	] satisfies [McpOAuthSettings, boolean, boolean][]) {
		expect(offersClientMetadataDocument(settings, { ...documents, listsRedirectUrl: () => listed }, callback)).toBe(
			expected,
		);
	}
	expect(offersClientMetadataDocument({}, undefined, callback)).toBe(false);
	const plain = serverSpecificPath("/callback/", "https://tools.example.test/mcp");
	expect(plain).toMatch(/^\/callback\/[\w-]{12}$/);
	expect(serverSpecificPath("/callback", "https://tools.example.test/mcp#ignored")).toBe(plain);
	expect(serverSpecificPath("/callback", "https://other.example.test/mcp")).not.toBe(plain);
});

test.each([false, true])(
	"metadata-document authorization scopes callbacks when issuer responses are supported: %s",
	async (issuerSupported) => {
		const issuer = "https://login.example.test",
			serverUrl = "https://tools.example.test/mcp";
		let state: McpOAuthState | undefined, redirected: URL | undefined;
		const store: McpOAuthServerStore = {
			load: () => state,
			save: (next) => {
				state = next;
			},
			withRefreshLock: async (fn) => fn(),
		};
		const provider = createOAuthClientProvider(
			{
				serverUrl,
				store,
				settings: { clientRegistration: "cimd" },
				clientName: "Axi",
				clientMetadataDocuments: documents,
			},
			callback,
			(url) => {
				redirected = url;
			},
		);
		const requests: URLSearchParams[] = [];
		const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
			const url = new URL(input);
			if (url.pathname.includes("oauth-protected-resource"))
				return Response.json({ resource: serverUrl, authorization_servers: [issuer] });
			if (url.pathname.includes("oauth-authorization-server"))
				return Response.json({
					issuer,
					authorization_endpoint: issuer + "/authorize",
					token_endpoint: issuer + "/token",
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
					client_id_metadata_document_supported: true,
					authorization_response_iss_parameter_supported: issuerSupported,
				});
			if (url.pathname === "/token") {
				requests.push(new URLSearchParams(String(init?.body)));
				return Response.json({ access_token: "local-token", token_type: "Bearer" });
			}
			throw new Error(`Unexpected OAuth endpoint ${url}`);
		};
		expect(await authorizeMcp(provider, { serverUrl, fetch })).toBe("REDIRECT");
		if (!redirected) throw new Error("Authorization did not redirect");
		const redirectUrl = issuerSupported ? callback : "http://localhost" + serverSpecificPath("/callback", serverUrl);
		const metadataUrl = issuerSupported
			? documents.baseUrl + "/client.json"
			: documents.baseUrl + "/" + serverSpecificPath("", serverUrl).slice(1) + "/client.json";
		expect(redirected.searchParams.get("client_id")).toBe(metadataUrl);
		expect(redirected.searchParams.get("redirect_uri")).toBe(redirectUrl);
		expect(redirected.searchParams.get("code_challenge_method")).toBe("S256");
		expect(
			await authorizeMcp(provider, {
				serverUrl,
				authorizationCode: "local-code",
				...(issuerSupported ? { iss: issuer } : {}),
				fetch,
			}),
		).toBe("AUTHORIZED");
		expect(requests.map((body) => Object.fromEntries(body))).toMatchObject([
			{ grant_type: "authorization_code", code: "local-code", client_id: metadataUrl, redirect_uri: redirectUrl },
		]);
		expect(await provider.tokens()).toMatchObject({ access_token: "local-token" });
	},
);

test("forced metadata documents fail clearly when redirect registration or public-client support is absent", () => {
	const store: McpOAuthServerStore = { load: () => undefined, save() {}, withRefreshLock: async (fn) => fn() };
	const options = {
		serverUrl: "https://tools.example.test/mcp",
		clientName: "Axi",
		store,
		settings: { clientRegistration: "cimd" } satisfies McpOAuthSettings,
	};
	const unlisted = createOAuthClientProvider(options, callback);
	expect(() => unlisted.clientMetadataDocument?.(undefined)).toThrow(/list the redirect URI/);
	const unsupported = createOAuthClientProvider({ ...options, clientMetadataDocuments: documents }, callback);
	expect(() => unsupported.clientMetadataDocument?.(undefined)).toThrow(/does not support/);
	const automatic = createOAuthClientProvider(
		{ ...options, settings: {}, clientMetadataDocuments: documents },
		callback,
	);
	expect(automatic.clientMetadataDocument?.(undefined)).toBeUndefined();
});

test("loopback configuration keeps explicit ports and maps localhost to its binding address", () => {
	expect(loopbackSettings({ callbackUrl: "http://localhost/custom", callbackPort: 4321 })).toEqual({
		url: "http://localhost/custom",
		host: "127.0.0.1",
		redirectHost: "localhost",
		port: 4321,
		path: "/custom",
		fixedRedirectUrl: "http://localhost:4321/custom",
	});
	expect(loopbackSettings({ callbackUrl: "http://127.0.0.1:1234/callback", callbackPort: 9999 })).toMatchObject({
		port: 1234,
		fixedRedirectUrl: "http://127.0.0.1:1234/callback",
	});
	expect(loopbackSettings({ callbackUrl: "http://[::1]/callback" })).toMatchObject({
		host: "::1",
		redirectHost: "::1",
		port: undefined,
		fixedRedirectUrl: undefined,
	});
	expect(registeredRedirectUrls(undefined)).toEqual([]);
	expect(registeredRedirectUrls({ client_id: "client" })).toEqual([]);
	expect(registeredRedirectUrls({ client_id: "client", redirect_uris: [callback] })).toEqual([callback]);
});

test("timed fetch combines cancellation with a deadline without changing request bodies or headers", async () => {
	const observed: RequestInit[] = [];
	const fetch = timedFetch(async (_input, init) => {
		observed.push(init ?? {});
		return Response.json({ accepted: true });
	});
	const controller = new AbortController();
	await fetch("https://tools.example.test", {
		signal: controller.signal,
		method: "POST",
		body: "payload",
		headers: { "X-Request": "one" },
	});
	await fetch("https://tools.example.test");
	expect(observed[0]).toMatchObject({ method: "POST", body: "payload", headers: { "X-Request": "one" } });
	expect(observed.every((request) => request.signal instanceof AbortSignal && !request.signal.aborted)).toBe(true);
	controller.abort();
	expect(observed[0]!.signal?.aborted).toBe(true);
	expect(observed[1]!.signal?.aborted).toBe(false);
});
