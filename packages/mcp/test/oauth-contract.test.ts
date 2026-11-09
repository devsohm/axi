import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
	exchangeAuthorizationCode,
	refreshAuthorization,
	registerClient,
	startAuthorization,
	type AuthorizationServerMetadata,
	type OAuthClientInformationMixed,
} from "../src/oauth/index.ts";

const issuer = "https://issuer.example.test";
const metadata: AuthorizationServerMetadata = {
	issuer,
	authorization_endpoint: `${issuer}/authorize`,
	token_endpoint: `${issuer}/token`,
	registration_endpoint: `${issuer}/register`,
	response_types_supported: ["code"],
};

test("token exchange selects the supported client authentication method and preserves request fields", async () => {
	for (const [client, supported, expected] of [
		[{ client_id: "client", client_secret: "secret" }, [], "basic"],
		[{ client_id: "client" }, [], "none"],
		[{ client_id: "client", client_secret: "secret" }, ["client_secret_post"], "post"],
		[{ client_id: "client", client_secret: "secret" }, ["client_secret_basic", "none"], "basic"],
		[{ client_id: "client", client_secret: "secret" }, ["none"], "none"],
		[{ client_id: "client", client_secret: "secret" }, ["unrecognized"], "post"],
		[{ client_id: "client" }, ["unrecognized"], "none"],
		[
			{ client_id: "client", client_secret: "secret", token_endpoint_auth_method: "client_secret_post" },
			["client_secret_basic", "client_secret_post"],
			"post",
		],
	] satisfies [OAuthClientInformationMixed, string[], string][]) {
		let received = false;
		const result = await exchangeAuthorizationCode(issuer, {
			metadata: { ...metadata, token_endpoint_auth_methods_supported: supported },
			clientInformation: client,
			code: "authorization",
			codeVerifier: "verifier",
			redirectUrl: "http://127.0.0.1/callback",
			resource: `${issuer}/mcp`,
			fetch: async (url, init) => {
				received = true;
				expect(String(url)).toBe(`${issuer}/token`);
				expect(init?.method).toBe("POST");
				const headers = new Headers(init?.headers),
					fields = new URLSearchParams(String(init?.body));
				expect(Object.fromEntries(fields)).toMatchObject({
					grant_type: "authorization_code",
					code: "authorization",
					code_verifier: "verifier",
					redirect_uri: "http://127.0.0.1/callback",
					resource: `${issuer}/mcp`,
				});
				if (expected === "basic") {
					expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("client:secret").toString("base64")}`);
					expect(fields.has("client_id")).toBe(false);
				} else {
					expect(headers.has("authorization")).toBe(false);
					expect(fields.get("client_id")).toBe("client");
					expect(fields.get("client_secret")).toBe(expected === "post" ? "secret" : null);
				}
				return Response.json({ access_token: "access", token_type: "Bearer" });
			},
		});
		expect(received).toBe(true);
		expect(result.access_token).toBe("access");
	}
});

test("custom client authentication controls headers and form data while token errors remain typed", async () => {
	const options = { clientInformation: { client_id: "client" }, refreshToken: "refresh" };
	expect(
		await refreshAuthorization(issuer, {
			...options,
			addClientAuthentication(headers, fields, url, selected) {
				headers.set("x-client", "signed");
				fields.set("assertion", "signature");
				expect(String(url)).toBe(`${issuer}/token`);
				expect(selected).toBeUndefined();
			},
			fetch: async (_url, init) => {
				expect(new Headers(init?.headers).get("x-client")).toBe("signed");
				expect(new URLSearchParams(String(init?.body)).get("assertion")).toBe("signature");
				return Response.json({ access_token: "new", token_type: "Bearer" });
			},
		}),
	).toMatchObject({ access_token: "new", refresh_token: "refresh" });
	for (const [response, error] of [
		[
			Response.json(
				{ error: "invalid_grant", error_description: "expired", error_uri: "https://issuer.example/error" },
				{ status: 400 },
			),
			{ name: "OAuthError", code: "invalid_grant", message: "expired" },
		],
		[
			Response.json({ error: "invalid_client" }, { status: 401 }),
			{ name: "OAuthError", code: "invalid_client", message: "invalid_client" },
		],
		[
			new Response("upstream down", { status: 503 }),
			{ name: "OAuthError", code: "server_error", message: expect.stringContaining("503") },
		],
	] satisfies [Response, object][])
		await expect(refreshAuthorization(issuer, { ...options, fetch: async () => response })).rejects.toMatchObject(
			error,
		);
	await expect(
		refreshAuthorization("http://public.example", {
			...options,
			fetch: async () => {
				throw new Error("Must not send credentials");
			},
		}),
	).rejects.toMatchObject({ name: "OAuthInsecureEndpointError" });
	await expect(
		refreshAuthorization(issuer, {
			...options,
			clientInformation: { client_id: "client", token_endpoint_auth_method: "client_secret_basic" },
			fetch: async () => {
				throw new Error("Must not send credentials");
			},
		}),
	).rejects.toThrow(/requires a client secret/);
});

test("authorization enforces code and S256 support and derives a valid PKCE challenge", async () => {
	const options = {
		clientInformation: { client_id: "client" },
		redirectUrl: "https://app.example/callback",
		scope: "read",
		state: "state",
	};
	const result = await startAuthorization(issuer, options);
	expect(result.authorizationUrl.origin + result.authorizationUrl.pathname).toBe(`${issuer}/authorize`);
	expect(result.authorizationUrl.searchParams.get("code_challenge")).toBe(
		createHash("sha256").update(result.codeVerifier).digest("base64url"),
	);
	expect(result.authorizationUrl.searchParams.get("state")).toBe("state");
	expect(result.authorizationUrl.searchParams.has("prompt")).toBe(false);
	for (const [selected, error] of [
		[{ ...metadata, response_types_supported: ["token"] }, /authorization codes/],
		[{ ...metadata, code_challenge_methods_supported: ["plain"] }, /S256/],
		[{ ...metadata, authorization_endpoint: "javascript:bad" }, /Invalid authorization endpoint/],
	] satisfies [AuthorizationServerMetadata, RegExp][])
		await expect(startAuthorization(issuer, { ...options, metadata: selected })).rejects.toThrow(error);
});

test("registration distinguishes native and web redirects and reports unsupported or failed registration", async () => {
	for (const [redirect, application_type] of [
		["https://app.example/callback", "web"],
		["http://127.0.0.1/callback", "native"],
		["http://[::1]/callback", "native"],
		["my-app://callback", "native"],
	]) {
		expect(
			await registerClient(issuer, {
				metadata,
				clientMetadata: { redirect_uris: [redirect!] },
				scope: "read",
				fetch: async (_url, init) => {
					const body = JSON.parse(String(init?.body));
					expect(body).toEqual({ redirect_uris: [redirect], application_type, scope: "read" });
					return Response.json({ ...body, client_id: "registered" });
				},
			}),
		).toMatchObject({ client_id: "registered", application_type });
	}
	await expect(
		registerClient(issuer, {
			metadata: {
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				response_types_supported: ["code"],
			},
			clientMetadata: { redirect_uris: [] },
		}),
	).rejects.toThrow(/does not support dynamic/);
	await expect(
		registerClient(issuer, {
			clientMetadata: { redirect_uris: [] },
			fetch: async () => new Response("registration denied", { status: 403 }),
		}),
	).rejects.toMatchObject({ name: "OAuthRegistrationError", status: 403 });
});
