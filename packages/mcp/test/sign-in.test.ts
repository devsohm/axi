import { afterEach, expect, test, vi } from "vitest";
import {
	completeMcpSignIn,
	createMcpAuthProvider,
	listenForLoopbackSignIn,
	MemoryOAuthStateStore,
	McpRefreshLockBusyError,
	McpSignInCancelledError,
	responseFromRedirectUrl,
	startMcpSignIn,
	waitForLoopbackSignIn,
	type McpOAuthServerStore,
	type McpOAuthState,
} from "../src/oauth/index.ts";

afterEach(() => vi.unstubAllGlobals());
const metadata = {
	issuer: "https://issuer.invalid",
	authorization_endpoint: "https://issuer.invalid/authorize",
	token_endpoint: "https://issuer.invalid/token",
	response_types_supported: ["code"],
};
function store(): McpOAuthServerStore {
	const memory = new MemoryOAuthStateStore();
	return { load: () => memory.load(), save: (state) => memory.save(state), withRefreshLock: async (fn) => fn() };
}
function initial(): McpOAuthState {
	return {
		serverUrl: "https://server.invalid/mcp",
		discovery: { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata },
	};
}

test.each([undefined, "", "extra"])(
	"step-up scope %j uses advertised defaults or merges an explicit challenge",
	async (scope) => {
		const state = store();
		await state.save({
			...initial(),
			discovery: {
				...initial().discovery!,
				resourceMetadata: { resource: initial().serverUrl, scopes_supported: ["advertised"] },
			},
			tokens: { access_token: "old", token_type: "Bearer", scope: "previous" },
		});
		vi.stubGlobal("fetch", () => {
			throw new Error("Unexpected network request");
		});
		const result = await startMcpSignIn({
			serverUrl: initial().serverUrl,
			store: state,
			clientName: "test",
			settings: { clientId: "configured" },
			redirectUrl: "http://localhost/login",
			challenge: { error: "insufficient_scope", scope },
		});
		if (result.kind !== "redirect") throw new Error("Missing browser step");
		expect(new URL(result.authorizationUrl).searchParams.get("scope")).toBe(scope ? "previous extra" : "advertised");
	},
);

test("concurrent callers share an expiring credential refresh and persist its replacement", async () => {
	const state = store();
	await state.save({
		...initial(),
		clientInformation: { client_id: "configured" },
		tokensExpireAt: Date.now(),
		tokens: { access_token: "old", refresh_token: "refresh", token_type: "Bearer" },
	});
	let requests = 0;
	vi.stubGlobal("fetch", async () => {
		requests++;
		return Response.json({ access_token: "new", refresh_token: "rotated", token_type: "Bearer", expires_in: 3600 });
	});
	const auth = createMcpAuthProvider({
		serverUrl: initial().serverUrl,
		store: state,
		clientName: "test",
		settings: () => ({}),
		onChallenge() {},
	});
	expect(await Promise.all([auth.token(), auth.token(), auth.token()])).toEqual(["new", "new", "new"]);
	await auth.settled();
	expect(requests).toBe(1);
	expect((await state.load())?.tokens?.refresh_token).toBe("rotated");
});

test("a two-stage sign-in validates its callback and exchanges with the same redirect URI", async () => {
	const state = store();
	await state.save(initial());
	const options = {
		serverUrl: initial().serverUrl,
		store: state,
		clientName: "test",
		settings: { clientId: "configured" },
		redirectUrl: "http://localhost:7456/login",
	};
	let exchanged: URLSearchParams | undefined;
	vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
		exchanged = new URLSearchParams(String(init.body));
		return Response.json({ access_token: "signed-in", token_type: "Bearer" });
	});
	const authorization = await startMcpSignIn(options);
	if (authorization.kind !== "redirect") throw new Error("Missing browser step");
	const url = new URL(authorization.redirectUrl);
	url.searchParams.set("state", authorization.state);
	url.searchParams.set("code", "local-code");
	const response = responseFromRedirectUrl(url.href, authorization);
	expect(() => responseFromRedirectUrl(url.href.replace("/login", "/other"), authorization)).toThrow("redirect URI");
	await completeMcpSignIn({ ...options, authorization, response });
	expect(exchanged?.get("redirect_uri")).toBe(options.redirectUrl);
	expect(exchanged?.get("code")).toBe("local-code");
	expect((await state.load())?.tokens?.access_token).toBe("signed-in");
});

test.each(["authorization", "response"] as const)(
	"sign-in completion retains its %s while stored state is loading",
	async (changed) => {
		const state = store();
		await state.save(initial());
		const client = {
			serverUrl: initial().serverUrl,
			store: state,
			clientName: "test",
			settings: { clientId: "configured" },
			redirectUrl: "http://localhost:7456/login",
		};
		const authorization = await startMcpSignIn(client);
		if (authorization.kind !== "redirect") throw new Error("Missing browser step");
		const options = {
			...client,
			authorization,
			response: { state: authorization.state, code: "accepted-code" },
		};
		const saved = await state.load(),
			entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		vi.spyOn(state, "load").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return saved;
		});
		let exchanged: URLSearchParams | undefined;
		vi.stubGlobal("fetch", async (_url: unknown, request: RequestInit) => {
			exchanged = new URLSearchParams(String(request.body));
			return Response.json({ access_token: "signed-in", token_type: "Bearer" });
		});
		const pending = completeMcpSignIn(options);
		await entered.promise;
		if (changed === "authorization") options.authorization = { ...authorization, state: "replacement-state" };
		else options.response = { state: "replacement-state", code: "replacement-code" };
		release.resolve();
		await pending;
		expect(exchanged?.get("code")).toBe("accepted-code");
		expect(exchanged?.get("redirect_uri")).toBe(client.redirectUrl);
		expect((await state.load())?.tokens?.access_token).toBe("signed-in");
	},
);

test("the browser step uses settings selected after the refresh lock is released", async () => {
	const state = store();
	await state.save(initial());
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	state.withRefreshLock = async (fn) => {
		entered.resolve();
		await release.promise;
		return fn();
	};
	const options = {
		serverUrl: initial().serverUrl,
		store: state,
		clientName: "test",
		settings: { clientId: "first", scope: "first-scope" },
		redirectUrl: "http://localhost/login",
	};
	vi.stubGlobal("fetch", () => {
		throw new Error("Unexpected network request");
	});
	const pending = startMcpSignIn(options);
	await entered.promise;
	options.settings = { clientId: "second", scope: "second-scope" };
	release.resolve();
	const result = await pending;
	if (result.kind !== "redirect") throw new Error("Missing browser step");
	const request = new URL(result.authorizationUrl).searchParams;
	expect(request.get("client_id")).toBe("second");
	expect(request.get("scope")).toBe("second-scope");
});

test("the browser step retains its callback while stored state is loading", async () => {
	const state = store();
	await state.save(initial());
	const saved = await state.load(),
		entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	vi.spyOn(state, "load").mockImplementationOnce(async () => {
		entered.resolve();
		await release.promise;
		return saved;
	});
	const options = {
		serverUrl: initial().serverUrl,
		store: state,
		clientName: "test",
		settings: { clientId: "configured" },
		redirectUrl: "http://localhost/first",
		challenge: { error: "insufficient_scope" },
	};
	vi.stubGlobal("fetch", () => {
		throw new Error("Unexpected network request");
	});
	const pending = startMcpSignIn(options);
	await entered.promise;
	options.redirectUrl = "http://localhost/second";
	release.resolve();
	const result = await pending;
	if (result.kind !== "redirect") throw new Error("Missing browser step");
	expect(result.redirectUrl).toBe("http://localhost/first");
	expect(new URL(result.authorizationUrl).searchParams.get("redirect_uri")).toBe(result.redirectUrl);
});

test("cancelling while waiting for a refresh lock returns before the lock is released", async () => {
	const controller = new AbortController();
	const gate = Promise.withResolvers<void>();
	const state = store();
	state.withRefreshLock = async (fn) => {
		await gate.promise;
		return fn();
	};
	const pending = startMcpSignIn({
		serverUrl: initial().serverUrl,
		store: state,
		clientName: "test",
		settings: {},
		redirectUrl: "http://localhost/login",
		signal: controller.signal,
	});
	controller.abort();
	await expect(pending).rejects.toBeInstanceOf(McpSignInCancelledError);
	gate.resolve();
});

test("cancellation as the refresh lock is acquired cannot read credentials or begin browser authorization", async () => {
	const controller = new AbortController();
	const state = store();
	const read = vi.spyOn(state, "load");
	state.withRefreshLock = async (fn) => {
		controller.abort();
		return fn();
	};
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal("fetch", fetch);
	await expect(
		startMcpSignIn({
			serverUrl: initial().serverUrl,
			store: state,
			clientName: "test",
			settings: {},
			redirectUrl: "http://localhost/login",
			signal: controller.signal,
		}),
	).rejects.toBeInstanceOf(McpSignInCancelledError);
	expect(read).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

test("a first sign-in discovers authorization metadata and persists the browser state", async () => {
	const state = store();
	const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(metadata));
	vi.stubGlobal("fetch", fetch);
	const result = await startMcpSignIn({
		serverUrl: initial().serverUrl,
		store: state,
		clientName: "test",
		settings: {
			clientId: "configured",
			authServerMetadataUrl: new URL("https://issuer.invalid/metadata"),
		},
		redirectUrl: "http://localhost/login",
	});
	if (result.kind !== "redirect") throw new Error("Missing browser step");
	expect(new URL(result.authorizationUrl).origin).toBe(metadata.issuer);
	expect(new URL(result.authorizationUrl).searchParams.get("client_id")).toBe("configured");
	expect((await state.load())?.oauthState).toBe(result.state);
	expect((await state.load())?.codeVerifier).toEqual(expect.any(String));
	expect(fetch.mock.calls.map(([url]) => String(url))).toContain("https://issuer.invalid/metadata");
});

test("the loopback callback wins over a pending manual prompt and cancels that prompt", async () => {
	const listening = await listenForLoopbackSignIn({ serverUrl: initial().serverUrl, store: store(), settings: {} });
	let promptSignal: AbortSignal | undefined;
	try {
		const authorization = {
			kind: "redirect",
			authorizationUrl: "https://issuer.invalid/authorize",
			redirectUrl: listening.redirectUrl,
			state: "local-state",
		} as const;
		const pending = waitForLoopbackSignIn({
			callback: listening.callback,
			authorization,
			promptForRedirectUrl: async (signal) => {
				promptSignal = signal;
				return new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				});
			},
		});
		const reply = await fetch(listening.redirectUrl + "?state=local-state&code=local-code");
		await reply.text();
		expect(await pending).toEqual({ state: "local-state", code: "local-code" });
		expect(promptSignal?.aborted).toBe(true);
	} finally {
		await listening.callback.close();
	}
});

test("a pre-cancelled sign-in does not read credentials or acquire a refresh lock", async () => {
	let reads = 0,
		locks = 0;
	const state = store();
	state.load = () => {
		reads++;
		return undefined;
	};
	state.withRefreshLock = async (fn) => {
		locks++;
		return fn();
	};
	await expect(
		startMcpSignIn({
			serverUrl: initial().serverUrl,
			store: state,
			clientName: "test",
			settings: {},
			redirectUrl: "http://localhost/login",
			signal: AbortSignal.abort(),
		}),
	).rejects.toBeInstanceOf(McpSignInCancelledError);
	expect({ reads, locks }).toEqual({ reads: 0, locks: 0 });
});

test("sign-in uses a stored refresh token without opening a browser authorization", async () => {
	const state = store();
	await state.save({
		...initial(),
		clientInformation: { client_id: "configured" },
		tokens: { access_token: "old", refresh_token: "refresh", token_type: "Bearer" },
	});
	let requests = 0;
	vi.stubGlobal("fetch", async (url: string | URL, request: RequestInit) => {
		requests++;
		expect(String(url)).toBe(metadata.token_endpoint);
		expect(new URLSearchParams(String(request.body)).get("grant_type")).toBe("refresh_token");
		return Response.json({ access_token: "new", token_type: "Bearer" });
	});
	expect(
		await startMcpSignIn({
			serverUrl: initial().serverUrl,
			store: state,
			clientName: "test",
			settings: {},
			redirectUrl: "http://localhost/login",
		}),
	).toEqual({ kind: "authorized" });
	expect(requests).toBe(1);
	expect((await state.load())?.tokens).toMatchObject({ access_token: "new", refresh_token: "refresh" });
	expect((await state.load())?.oauthState).toBeUndefined();
});

test("a busy refresh lock falls back to authorization while other lock failures remain visible", async () => {
	for (const error of [new McpRefreshLockBusyError(), new Error("Credential file unavailable")]) {
		const state = store();
		await state.save(initial());
		state.withRefreshLock = async () => {
			throw error;
		};
		const pending = startMcpSignIn({
			serverUrl: initial().serverUrl,
			store: state,
			clientName: "test",
			settings: { clientId: "configured" },
			redirectUrl: "http://localhost/login",
		});
		if (error instanceof McpRefreshLockBusyError) expect(await pending).toMatchObject({ kind: "redirect" });
		else await expect(pending).rejects.toBe(error);
	}
});

test.each(["response", "stored"] as const)(
	"the %s state must match before an authorization code can be exchanged",
	async (mismatch) => {
		const state = store();
		await state.save({ ...initial(), oauthState: mismatch === "stored" ? "newer-sign-in" : "expected" });
		let requests = 0;
		vi.stubGlobal("fetch", async () => {
			requests++;
			throw new Error("Unexpected request");
		});
		await expect(
			completeMcpSignIn({
				serverUrl: initial().serverUrl,
				store: state,
				clientName: "test",
				settings: { clientId: "configured" },
				redirectUrl: "http://localhost/login",
				authorization: {
					kind: "redirect",
					state: "expected",
					redirectUrl: "http://localhost/login",
					authorizationUrl: metadata.authorization_endpoint,
				},
				response: { state: mismatch === "response" ? "wrong" : "expected", code: "code" },
			}),
		).rejects.toThrow(mismatch === "response" ? "different sign-in" : "Another sign-in");
		expect(requests).toBe(0);
		expect((await state.load())?.oauthState).toBe(mismatch === "stored" ? "newer-sign-in" : "expected");
	},
);

test("a changed redirect discards unusable registration and tokens before registering again", async () => {
	const state = store();
	await state.save({
		...initial(),
		discovery: {
			authorizationServerUrl: metadata.issuer,
			authorizationServerMetadata: { ...metadata, registration_endpoint: "https://issuer.invalid/register" },
		},
		clientInformation: { client_id: "old-client", redirect_uris: ["http://localhost/old"], response_types: ["code"] },
		tokens: { access_token: "old", token_type: "Bearer" },
		tokensExpireAt: 10,
		oauthState: "old-state",
	});
	let requests = 0;
	vi.stubGlobal("fetch", async (url: string | URL) => {
		requests++;
		expect(String(url)).toBe("https://issuer.invalid/register");
		return Response.json({ client_id: "new-client", redirect_uris: ["http://localhost/new"] });
	});
	const result = await startMcpSignIn({
		serverUrl: initial().serverUrl,
		store: state,
		clientName: "test",
		settings: {},
		redirectUrl: "http://localhost/new",
	});
	if (result.kind !== "redirect") throw new Error("Missing browser step");
	expect(new URL(result.authorizationUrl).searchParams.get("client_id")).toBe("new-client");
	expect(requests).toBe(1);
	expect((await state.load())?.tokens).toBeUndefined();
	expect((await state.load())?.tokensExpireAt).toBeUndefined();
	expect((await state.load())?.oauthState).toBe(result.state);
});

test("explicit client metadata registration discards a previous dynamic registration and skips its refresh", async () => {
	const state = store();
	await state.save({
		...initial(),
		discovery: {
			authorizationServerUrl: metadata.issuer,
			authorizationServerMetadata: {
				...metadata,
				client_id_metadata_document_supported: true,
				token_endpoint_auth_methods_supported: ["none"],
				authorization_response_iss_parameter_supported: true,
			},
		},
		clientInformation: { client_id: "old-client", redirect_uris: ["http://localhost/login"], response_types: ["code"] },
		tokens: { access_token: "old", refresh_token: "refresh", token_type: "Bearer" },
	});
	vi.stubGlobal("fetch", async () => {
		throw new Error("Unexpected refresh or registration");
	});
	const result = await startMcpSignIn({
		serverUrl: initial().serverUrl,
		store: state,
		clientName: "test",
		settings: { clientRegistration: "cimd" },
		redirectUrl: "http://localhost/login",
		clientMetadataDocuments: {
			baseUrl: "https://app.invalid",
			listsRedirectUrl: (url) => url === "http://localhost/login",
		},
	});
	if (result.kind !== "redirect") throw new Error("Missing browser step");
	expect(new URL(result.authorizationUrl).searchParams.get("client_id")).toBe("https://app.invalid/client.json");
	expect((await state.load())?.tokens).toBeUndefined();
});
