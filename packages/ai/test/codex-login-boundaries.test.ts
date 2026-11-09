import { afterEach, expect, test, vi } from "vitest";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import * as callbacks from "../src/auth/oauth/callback-server.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";

const startCallback = callbacks.startOAuthCallbackServer;
const nativeFetch = globalThis.fetch;
const access = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-account" } })).toString("base64")}.signature`;
const token = { access_token: access, refresh_token: "local-refresh", expires_in: 60 };
const device = { device_auth_id: "device", user_code: "LOCAL", interval: "0" };
const current: OAuthCredential = { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 };

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function browser(input: (url: URL) => string, agentName?: string) {
	let url: URL | undefined;
	vi.spyOn(callbacks, "startOAuthCallbackServer").mockImplementation((options) =>
		startCallback({ ...options, port: 0 }),
	);
	const interaction: ProviderAuthInteraction = {
		signal: new AbortController().signal,
		notify(event) {
			if (event.type === "auth_url") url = new URL(event.url);
		},
		async prompt(prompt) {
			if (prompt.type === "select") return "browser";
			if (!url) throw new Error("Authorization URL was not published");
			return input(url);
		},
	};
	return openaiCodexOAuth.login(interaction, agentName ? { agentName } : undefined);
}

test.each(["raw", "fragment", "query", "url"])(
	"manual %s login validates PKCE and exchanges the selected code",
	async (format) => {
		let form: URLSearchParams | undefined, authorization: URL | undefined;
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			form = new URLSearchParams(String(init?.body));
			return Response.json(token);
		});
		const result = await browser((url) => {
			authorization = url;
			const state = url.searchParams.get("state");
			return format === "raw"
				? " accepted "
				: format === "fragment"
					? `accepted#${state}`
					: format === "query"
						? `code=accepted&state=${state}`
						: `http://localhost:1455/auth/callback?code=accepted&state=${state}`;
		});
		expect(result).toMatchObject({ type: "oauth", access, accountId: "local-account" });
		expect(form?.get("code")).toBe("accepted");
		expect(form?.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
		const verifier = form?.get("code_verifier");
		if (!verifier) throw new Error("Missing PKCE verifier");
		const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString(
			"base64url",
		);
		expect(authorization?.searchParams.get("code_challenge")).toBe(challenge);
		expect(authorization?.searchParams.get("originator")).toBe("axi");
	},
);

test.each(["", "   ", "https://callback.invalid/?state=other&code=wrong", "code=accepted&state=other"])(
	"invalid browser input cannot exchange a token: %j",
	async (input) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(browser(() => input)).rejects.toThrow(input.trim() ? "State mismatch" : "Missing authorization code");
		expect(fetch).not.toHaveBeenCalled();
	},
);

test("a callback completes browser login and aborts the pending manual prompt", async () => {
	let callbackUrl: string | undefined, manualSignal: AbortSignal | undefined;
	vi.spyOn(callbacks, "startOAuthCallbackServer").mockImplementation(async (options) => {
		const callback = await startCallback({ ...options, port: 0 });
		callbackUrl = callback.redirectUri;
		return callback;
	});
	vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
		expect(new URLSearchParams(String(init?.body)).get("code")).toBe("from-browser");
		return Response.json(token);
	});
	let response: Promise<Response> | undefined;
	const result = await openaiCodexOAuth.login({
		signal: new AbortController().signal,
		notify(event) {
			if (event.type !== "auth_url" || !callbackUrl) return;
			response = nativeFetch(`${callbackUrl}?code=from-browser&state=${new URL(event.url).searchParams.get("state")}`);
		},
		prompt: async (prompt) => {
			if (prompt.type === "select") return "browser";
			manualSignal = prompt.signal;
			return new Promise((_resolve, reject) =>
				prompt.signal?.addEventListener("abort", () => reject(prompt.signal?.reason), { once: true }),
			);
		},
	});
	expect((await response)?.status).toBe(200);
	expect(result.accountId).toBe("local-account");
	expect(manualSignal?.aborted).toBe(true);
});

test("a failed loopback listener still permits manual login", async () => {
	vi.spyOn(callbacks, "startOAuthCallbackServer").mockRejectedValue(new Error("Address occupied"));
	vi.stubGlobal("fetch", async () => Response.json(token));
	expect(
		(
			await openaiCodexOAuth.login({
				signal: new AbortController().signal,
				notify() {},
				prompt: async (prompt) => (prompt.type === "select" ? "browser" : "accepted"),
			})
		).accountId,
	).toBe("local-account");
});

test.each([
	{},
	{ ...device, device_auth_id: "" },
	{ ...device, user_code: null },
	{ ...device, interval: -1 },
	{ ...device, interval: "NaN" },
	{ ...device, interval: "Infinity" },
])("device login rejects malformed initialization: %j", async (value) => {
	vi.stubGlobal("fetch", async () => Response.json(value));
	await expect(
		openaiCodexOAuth.login({ signal: new AbortController().signal, notify() {}, prompt: async () => "device_code" }),
	).rejects.toThrow("Invalid OpenAI Codex device code response");
});

test("device polling distinguishes pending and slow-down responses before exchanging a code", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1800000000000);
	const sequence = [
		new Response(null, { status: 403 }),
		new Response(null, { status: 404 }),
		Response.json({ error: { code: "deviceauth_authorization_pending" } }, { status: 400 }),
		Response.json({ error: "slow_down" }, { status: 429 }),
		Response.json({ authorization_code: "approved", code_verifier: "verifier" }),
	];
	const pollTimes: number[] = [];
	vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
		if (String(url).endsWith("/usercode")) return Response.json(device);
		if (String(url).endsWith("deviceauth/token")) {
			pollTimes.push(Date.now() - 1800000000000);
			const response = sequence.shift();
			if (!response) throw new Error("Unexpected poll");
			return response;
		}
		expect(new URLSearchParams(String(init?.body)).get("redirect_uri")).toBe(
			"https://auth.openai.com/deviceauth/callback",
		);
		return Response.json(token);
	});
	const pending = openaiCodexOAuth.login({
		signal: new AbortController().signal,
		notify() {},
		prompt: async () => "device_code",
	});
	await vi.advanceTimersByTimeAsync(9000);
	expect((await pending).accountId).toBe("local-account");
	expect(pollTimes).toEqual([0, 1000, 2000, 3000, 9000]);
});

test.each([
	[Response.json({}), "Invalid OpenAI Codex device auth token response"],
	[new Response("not JSON", { status: 503 }), "503: not JSON"],
	[Response.json({ error: { code: "denied" } }, { status: 400 }), "400"],
	[Response.json(null, { status: 400 }), "400: null"],
	[new Response(null, { status: 500 }), "status 500"],
])("device polling reports a terminal failure", async (response, message) => {
	vi.stubGlobal("fetch", async (url: unknown) =>
		String(url).endsWith("/usercode") ? Response.json(device) : response,
	);
	await expect(
		openaiCodexOAuth.login({ signal: new AbortController().signal, notify() {}, prompt: async () => "device_code" }),
	).rejects.toThrow(message);
});

test.each([
	"broken",
	"x.invalid.x",
	`x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "" } })).toString("base64")}.x`,
])("refresh rejects an unusable account token: %s", async (access_token) => {
	vi.stubGlobal("fetch", async () => Response.json({ ...token, access_token }));
	await expect(openaiCodexOAuth.refresh(current, new AbortController().signal)).rejects.toThrow(
		"Failed to extract accountId",
	);
});

test("token and device initialization retain useful errors when the response body cannot be read", async () => {
	const response = () => {
		const body = new ReadableStream({
			start(controller) {
				controller.error(new Error("Body disconnected"));
			},
		});
		return new Response(body, { status: 503, statusText: "Unavailable" });
	};
	vi.stubGlobal("fetch", async () => response());
	await expect(openaiCodexOAuth.refresh(current, new AbortController().signal)).rejects.toThrow("(503): Unavailable");
	await expect(
		openaiCodexOAuth.login({ signal: new AbortController().signal, notify() {}, prompt: async () => "device_code" }),
	).rejects.toThrow("request failed with status 503");
});

test("an aborted login fetch is reported as cancellation while unrelated errors survive", async () => {
	const controller = new AbortController();
	vi.stubGlobal("fetch", async () => {
		controller.abort();
		throw new Error("Network aborted");
	});
	await expect(
		openaiCodexOAuth.login({ signal: controller.signal, notify() {}, prompt: async () => "device_code" }),
	).rejects.toThrow("Login cancelled");
	vi.stubGlobal("fetch", async () => {
		throw new Error("Network offline");
	});
	await expect(
		openaiCodexOAuth.login({ signal: new AbortController().signal, notify() {}, prompt: async () => "device_code" }),
	).rejects.toThrow("Network offline");
	await expect(
		openaiCodexOAuth.login({ signal: new AbortController().signal, notify() {}, prompt: async () => "other" }),
	).rejects.toThrow("Unknown OpenAI Codex login method");
});
