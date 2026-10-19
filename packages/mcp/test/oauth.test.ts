import { expect, it } from "vitest";
import {
	authorizeMcp,
	discoverAuthorizationServerMetadata,
	exchangeAuthorizationCode,
	McpOAuthProvider,
	refreshAuthorization,
	registerClient,
	startAuthorization,
} from "../src/oauth/index.ts";
import { parseAuthorizationServerMetadata, parseProtectedResourceMetadata } from "../src/oauth/types.ts";

it("reads client information when selecting and then applying authentication", async () => {
	let reads = 0;
	let body = "";
	await exchangeAuthorizationCode("https://issuer.example.test", {
		get clientInformation() {
			return { client_id: `client-${++reads}` };
		},
		code: "local-code",
		codeVerifier: "local-verifier",
		redirectUrl: "http://localhost/callback",
		fetch: async (_url, init) => {
			body = String(init?.body);
			return Response.json({ access_token: "local-token", token_type: "Bearer" });
		},
	});
	expect(reads).toBe(2);
	expect(new URLSearchParams(body).get("client_id")).toBe("client-2");
});

it("uses one captured authorization issuer during code exchange", async () => {
	const metadata = {
		issuer: "https://issuer.example.test",
		authorization_endpoint: "https://issuer.example.test/authorize",
		token_endpoint: "https://issuer.example.test/token",
		response_types_supported: ["code"],
	};
	const provider = {
		redirectUrl: "http://localhost/callback",
		clientMetadata: { redirect_uris: ["http://localhost/callback"] },
		discoveryState: async () => ({ authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata }),
		clientInformation: async () => ({ client_id: "local-client" }),
		codeVerifier: () => "local-verifier",
		tokens: () => undefined,
		saveTokens() {},
		redirectToAuthorization() {},
		saveCodeVerifier() {},
	};
	let reads = 0;
	expect(
		await authorizeMcp(provider, {
			serverUrl: metadata.issuer + "/mcp",
			authorizationCode: "local-code",
			get iss() {
				return ++reads === 1 ? metadata.issuer : "https://changed.example.test";
			},
			fetch: async () => Response.json({ access_token: "local-token", token_type: "Bearer" }),
		}),
	).toBe("AUTHORIZED");
	expect(reads).toBe(1);
});

it("does not stringify the issuer again when its validation is disabled", async () => {
	const issuer = new URL("https://issuer.example.test");
	let reads = 0;
	issuer.toString = () => {
		if (++reads > 1) throw new Error("Unexpected issuer conversion");
		return "https://issuer.example.test";
	};
	const metadata = await discoverAuthorizationServerMetadata(issuer, {
		skipIssuerValidation: true,
		fetch: async () =>
			Response.json({
				issuer: "https://issuer.example.test",
				authorization_endpoint: "https://issuer.example.test/authorize",
				token_endpoint: "https://issuer.example.test/token",
				response_types_supported: ["code"],
			}),
	});
	expect(reads).toBe(1);
	expect(metadata?.issuer).toBe("https://issuer.example.test");
});

it("captures the optional registration endpoint once after copying metadata", () => {
	let reads = 0;
	const metadata = parseAuthorizationServerMetadata({
		issuer: "https://issuer.example.test",
		authorization_endpoint: "https://issuer.example.test/authorize",
		token_endpoint: "https://issuer.example.test/token",
		response_types_supported: ["code"],
		get registration_endpoint() {
			return `https://issuer.example.test/register-${++reads}`;
		},
	});
	expect(reads).toBe(2);
	expect(metadata.registration_endpoint).toBe("https://issuer.example.test/register-2");
});

it("does not inspect redirect URIs to infer an explicit application type", async () => {
	let reads = 0;
	await registerClient("https://issuer.example.test", {
		clientMetadata: {
			application_type: "web",
			get redirect_uris() {
				reads++;
				return ["http://localhost/callback"];
			},
		},
		fetch: async () => Response.json({ client_id: "local", redirect_uris: [] }),
	});
	expect(reads).toBe(1);
});

it("reads provider metadata before selecting its credential store", () => {
	const reads: string[] = [];
	new McpOAuthProvider({
		serverUrl: "https://issuer.example.test/mcp",
		redirectUrl: "http://localhost/callback",
		get clientMetadata() {
			reads.push("metadata");
			return {};
		},
		get store() {
			reads.push("store");
			return undefined;
		},
		onRedirect() {},
	});
	expect(reads).toEqual(["metadata", "metadata", "metadata", "metadata", "metadata", "store"]);
});

it("keeps metadata limited to enumerable string fields", () => {
	const parsed = parseProtectedResourceMetadata({ resource: "https://issuer.example.test/mcp", [Symbol("local")]: 1 });
	expect(Reflect.ownKeys(parsed)).toEqual(["resource"]);
});

it("selects the authorization endpoint before computing the challenge", async () => {
	const metadata = {
		issuer: "https://issuer.example.test",
		authorization_endpoint: "https://issuer.example.test/initial",
		token_endpoint: "https://issuer.example.test/token",
		response_types_supported: ["code"],
	};
	const pending = startAuthorization(metadata.issuer, {
		metadata,
		clientInformation: { client_id: "local-client" },
		redirectUrl: "http://127.0.0.1/callback",
	});
	metadata.authorization_endpoint = "https://issuer.example.test/changed";
	expect((await pending).authorizationUrl.pathname).toBe("/initial");
});

it("reads the fallback refresh token after the token request settles", async () => {
	const response = Promise.withResolvers<Response>();
	const options = {
		refreshToken: "initial",
		clientInformation: { client_id: "local-client" },
		fetch: () => response.promise,
	};
	const pending = refreshAuthorization("https://issuer.example.test", options);
	options.refreshToken = "changed";
	response.resolve(Response.json({ access_token: "local-access-token", token_type: "Bearer" }));
	expect((await pending).refresh_token).toBe("changed");
});

it("keeps the discovery fetch function selected at the start", async () => {
	const calls: string[] = [];
	const options = { fetch: initial };
	async function initial(): Promise<Response> {
		calls.push("initial");
		options.fetch = changed;
		return new Response(null, { status: 404 });
	}
	async function changed(): Promise<Response> {
		calls.push("changed");
		throw new Error("Discovery switched fetch implementations");
	}
	expect(await discoverAuthorizationServerMetadata("https://issuer.example.test", options)).toBeUndefined();
	expect(calls).toEqual(["initial", "initial"]);
});

it("preserves the discovery state's serialized field order when reusing metadata", async () => {
	const metadata = {
		issuer: "https://issuer.example.test",
		authorization_endpoint: "https://issuer.example.test/authorize",
		token_endpoint: "https://issuer.example.test/token",
		response_types_supported: ["code"],
	};
	let saved = "";
	const provider = {
		redirectUrl: "http://localhost/callback",
		clientMetadata: { redirect_uris: ["http://localhost/callback"] },
		discoveryState: () => ({
			authorizationServerUrl: metadata.issuer,
			authorizationServerMetadata: metadata,
			resourceMetadata: { resource: "https://resource.example.test/mcp" },
		}),
		saveDiscoveryState(value: unknown) {
			saved = JSON.stringify(value);
		},
		clientInformation: () => ({ client_id: "local-client" }),
		codeVerifier: () => "local-verifier",
		tokens: () => undefined,
		saveTokens() {},
		redirectToAuthorization() {},
		saveCodeVerifier() {},
	};
	expect(
		await authorizeMcp(provider, {
			serverUrl: "https://resource.example.test/mcp",
			authorizationCode: "local-code",
			fetch: async () => Response.json({ access_token: "local-token", token_type: "Bearer" }),
		}),
	).toBe("AUTHORIZED");
	expect(saved).toBe(
		'{"authorizationServerUrl":"https://issuer.example.test","authorizationServerMetadata":{"issuer":"https://issuer.example.test","authorization_endpoint":"https://issuer.example.test/authorize","token_endpoint":"https://issuer.example.test/token","response_types_supported":["code"]},"resourceMetadata":{"resource":"https://resource.example.test/mcp"}}',
	);
});
