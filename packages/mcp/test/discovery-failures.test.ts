import { afterEach, expect, test, vi } from "vitest";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	McpOAuthProvider,
	selectResource,
} from "../src/oauth/index.ts";

afterEach(() => vi.unstubAllGlobals());

test("metadata discovery uses the global fetch when no adapter is supplied", async () => {
	const issuer = "https://identity.example";
	const metadata = {
		issuer,
		authorization_endpoint: issuer + "/authorize",
		token_endpoint: issuer + "/token",
		response_types_supported: ["code"],
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
		String(input).includes("oauth-protected-resource")
			? Response.json({ resource: "https://service.example/", authorization_servers: [issuer] })
			: Response.json(metadata),
	);
	vi.stubGlobal("fetch", fetch);
	expect(await discoverProtectedResourceMetadata("https://service.example/")).toMatchObject({
		resource: "https://service.example/",
	});
	expect(await discoverAuthorizationServerMetadata(issuer)).toEqual(metadata);
	expect(
		await discoverOAuthServerInfo("https://service.example/", {
			authorizationServerMetadataUrl: new URL(issuer + "/metadata"),
		}),
	).toMatchObject({ authorizationServerUrl: issuer, authorizationServerMetadata: metadata });
	expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
		"https://service.example/.well-known/oauth-protected-resource",
		issuer + "/.well-known/oauth-authorization-server",
		"https://service.example/.well-known/oauth-protected-resource",
		issuer + "/metadata",
	]);
});

test.each([500, 503])("an issuer HTTP %i failure stops discovery and cancels the response body", async (status) => {
	let cancelled = 0;
	const fetch = vi.fn(
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled++;
					},
				}),
				{ status },
			),
	);
	await expect(discoverAuthorizationServerMetadata("https://identity.example", { fetch })).rejects.toThrow(
		`HTTP ${status}`,
	);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(cancelled).toBe(1);
});

test("a resource discovery network failure does not silently switch authorization servers", async () => {
	const failure = new TypeError("connection refused");
	const fetch = vi.fn(async () => {
		throw failure;
	});
	await expect(discoverOAuthServerInfo("https://service.example/", { fetch })).rejects.toBe(failure);
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("an explicit metadata endpoint failure is reported after unavailable resource metadata", async () => {
	const fetch = vi.fn(
		async (input: Parameters<typeof globalThis.fetch>[0]) =>
			new Response(null, { status: String(input).endsWith("/metadata") ? 503 : 404 }),
	);
	await expect(
		discoverOAuthServerInfo("https://service.example/", {
			fetch,
			authorizationServerMetadataUrl: new URL("https://identity.example/metadata"),
		}),
	).rejects.toThrow("HTTP 503");
	expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
		"https://service.example/.well-known/oauth-protected-resource",
		"https://identity.example/metadata",
	]);
});

test.each([
	["https://service.example/", "https://service.example/"],
	["https://service.example/mcp/child/", "https://service.example/mcp/"],
	["https://service.example/mcp/child", "https://service.example/mcp"],
])("resource %s accepts its configured ancestor %s", (serverUrl, resource) => {
	expect(selectResource(serverUrl, { resource })).toBe(resource);
});

test.each([undefined, "configured-secret"])(
	"configured OAuth clients preserve their registration with secret %s",
	async (clientSecret) => {
		const provider = new McpOAuthProvider({
			serverUrl: "https://service.example/",
			redirectUrl: "http://localhost/callback",
			clientMetadata: {},
			clientId: "configured",
			clientSecret,
			onRedirect() {},
		});
		expect(provider.clientMetadata.token_endpoint_auth_method).toBe(clientSecret ? "client_secret_post" : "none");
		await provider.saveClientInformation({ client_id: "different" });
		expect(await provider.clientInformation()).toEqual({
			client_id: "configured",
			...(clientSecret ? { client_secret: clientSecret } : {}),
		});
		await expect(provider.codeVerifier()).rejects.toThrow(/PKCE/);
		await provider.saveCodeVerifier("fresh-verifier");
		expect(await provider.codeVerifier()).toBe("fresh-verifier");
	},
);
