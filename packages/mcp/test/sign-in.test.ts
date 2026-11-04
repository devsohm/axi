import { afterEach, expect, test, vi } from "vitest";
import {
	completeMcpSignIn,
	createMcpAuthProvider,
	listenForLoopbackSignIn,
	MemoryOAuthStateStore,
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
