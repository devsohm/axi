import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { adaptOAuthProvider, authorizeMcp, McpOAuthProvider, type OAuthClientMetadata } from "../src/oauth/index.ts";
import type { McpFetch } from "../src/index.ts";

test("authorization exchanges a PKCE code, preserves scopes and shares rotating-token recovery", async () => {
	const origin = "https://login.example.test";
	let redirected: URL | undefined;
	let registration: unknown;
	const requests: URLSearchParams[] = [];
	const fetch: McpFetch = async (input, init) => {
		const url = new URL(input);
		if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
			return Response.json({
				resource: origin + "/mcp",
				authorization_servers: [origin],
				scopes_supported: ["read", "offline_access"],
			});
		if (url.pathname === "/.well-known/oauth-authorization-server")
			return Response.json({
				issuer: origin,
				authorization_endpoint: origin + "/authorize",
				token_endpoint: origin + "/token",
				registration_endpoint: origin + "/register",
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
				authorization_response_iss_parameter_supported: true,
			});
		if (url.pathname === "/register") {
			registration = JSON.parse(String(init?.body));
			return Response.json({ client_id: "local-client", redirect_uris: ["http://localhost/callback"] });
		}
		if (url.pathname !== "/token") throw new Error(`Unexpected request ${url}`);
		const body = new URLSearchParams(String(init?.body));
		requests.push(body);
		if (body.get("grant_type") === "authorization_code") {
			expect(body.get("code")).toBe("accepted-code");
			expect(
				createHash("sha256")
					.update(body.get("code_verifier") ?? "")
					.digest("base64url"),
			).toBe(redirected?.searchParams.get("code_challenge"));
			return Response.json({ access_token: "access-one", refresh_token: "refresh-one", token_type: "Bearer" });
		}
		expect(body.get("refresh_token")).toBe("refresh-one");
		return Response.json({ access_token: "access-two", refresh_token: "refresh-two", token_type: "Bearer" });
	};
	const provider = new McpOAuthProvider({
		serverUrl: origin + "/mcp",
		redirectUrl: "http://localhost/callback",
		clientMetadata: { client_name: "local-test" },
		onRedirect(url) {
			redirected = url;
		},
	});
	expect(await authorizeMcp(provider, { serverUrl: origin + "/mcp", fetch })).toBe("REDIRECT");
	expect(registration).toEqual({
		client_name: "local-test",
		redirect_uris: ["http://localhost/callback"],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		application_type: "native",
		scope: "read offline_access",
	} satisfies OAuthClientMetadata);
	if (!redirected) throw new Error("Authorization URL was not supplied");
	expect(redirected.origin + redirected.pathname).toBe(origin + "/authorize");
	expect(redirected.searchParams.get("scope")).toBe("read offline_access");
	expect(redirected.searchParams.get("prompt")).toBe("consent");
	expect(redirected.searchParams.get("resource")).toBe(origin + "/mcp");
	expect(redirected.searchParams.get("code_challenge_method")).toBe("S256");
	expect(redirected.searchParams.get("state")).toBe(await provider.state());
	await expect(
		authorizeMcp(provider, {
			serverUrl: origin + "/mcp",
			fetch,
			authorizationCode: "rejected-code",
			iss: "https://other.example.test",
		}),
	).rejects.toMatchObject({ name: "OAuthIssuerMismatchError" });
	expect(requests).toHaveLength(0);
	expect(
		await authorizeMcp(provider, {
			serverUrl: origin + "/mcp",
			fetch,
			authorizationCode: "accepted-code",
			iss: origin,
		}),
	).toBe("AUTHORIZED");
	expect(await provider.tokens()).toEqual({
		access_token: "access-one",
		refresh_token: "refresh-one",
		token_type: "Bearer",
		scope: "read offline_access",
	});
	const auth = adaptOAuthProvider(provider);
	const context = () => ({
		response: new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
		serverUrl: new URL(origin + "/mcp"),
		fetch,
		token: "access-one",
	});
	await Promise.all([auth.onUnauthorized?.(context()), auth.onUnauthorized?.(context())]);
	await auth.onUnauthorized?.(context());
	expect(requests.map((body) => [body.get("grant_type"), body.get("client_id"), body.get("resource")])).toEqual([
		["authorization_code", "local-client", origin + "/mcp"],
		["refresh_token", "local-client", origin + "/mcp"],
	]);
	expect(await provider.tokens()).toEqual({
		access_token: "access-two",
		refresh_token: "refresh-two",
		token_type: "Bearer",
		scope: "read offline_access",
	});
	expect(await auth.token()).toBe("access-two");
});
