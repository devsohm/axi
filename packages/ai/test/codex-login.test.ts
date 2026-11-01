import { afterEach, expect, test, vi } from "vitest";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
const access =
	"test." +
	Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString(
		"base64",
	) +
	".test";
const current: OAuthCredential = {
	type: "oauth",
	access: "old-access",
	refresh: "old-refresh",
	expires: 0,
	accountId: "test-account",
};
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test("legacy Codex browser login binds manual state and exchanges only the advertised code", async () => {
	vi.spyOn(Date, "now").mockReturnValue(1000);
	const requests: { url: string; form: Record<string, string> }[] = [];
	vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
		requests.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(String(init?.body))) });
		return Response.json({ access_token: access, refresh_token: "fresh-refresh", expires_in: 60 });
	});
	let loginUrl: URL | undefined;
	const interaction: ProviderAuthInteraction = {
		signal: new AbortController().signal,
		notify(event) {
			if (event.type === "auth_url") loginUrl = new URL(event.url);
		},
		async prompt(prompt) {
			return prompt.type === "select" ? "browser" : `manual-code#${loginUrl?.searchParams.get("state")}`;
		},
	};
	const result = await openaiCodexOAuth.login(interaction, { agentName: "axi-test" });
	expect(result).toEqual({
		type: "oauth",
		access,
		refresh: "fresh-refresh",
		expires: 61000,
		accountId: "test-account",
	});
	expect(loginUrl?.searchParams.get("originator")).toBe("axi-test");
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		url: "https://auth.openai.com/oauth/token",
		form: {
			grant_type: "authorization_code",
			code: "manual-code",
			redirect_uri: "http://localhost:1455/auth/callback",
		},
	});
	expect(await openaiCodexOAuth.toAuth(result)).toEqual({ apiKey: access });
});

test("legacy Codex refresh validates responses and preserves useful failure messages", async () => {
	vi.spyOn(Date, "now").mockReturnValue(1000);
	vi.stubGlobal("fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
		expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({
			grant_type: "refresh_token",
			refresh_token: "old-refresh",
		});
		return Response.json({ access_token: access, refresh_token: "renewed", expires_in: 30 });
	});
	expect(await openaiCodexOAuth.refresh(current, new AbortController().signal)).toEqual({
		type: "oauth",
		access,
		refresh: "renewed",
		expires: 31000,
		accountId: "test-account",
	});
	vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
	await expect(openaiCodexOAuth.refresh(current, new AbortController().signal)).rejects.toThrow(
		"token refresh failed (403): denied",
	);
	vi.stubGlobal("fetch", async () => Response.json({ access_token: "missing-fields" }));
	await expect(openaiCodexOAuth.refresh(current, new AbortController().signal)).rejects.toThrow(
		"response missing fields",
	);
	vi.stubGlobal("fetch", async () =>
		Response.json({ access_token: "not-a-token", refresh_token: "r", expires_in: 30 }),
	);
	await expect(openaiCodexOAuth.refresh(current, new AbortController().signal)).rejects.toThrow(
		"Failed to extract accountId",
	);
	vi.stubGlobal("fetch", async () => {
		throw new Error("offline");
	});
	await expect(openaiCodexOAuth.refresh(current, new AbortController().signal)).rejects.toThrow(
		"token refresh error: offline",
	);
});

test("legacy token parsing retains truthy refresh values and numeric expiry values", async () => {
	vi.spyOn(Date, "now").mockReturnValue(1000);
	for (const refresh of [42, true, { token: "r" }, []]) {
		vi.stubGlobal("fetch", async () => Response.json({ access_token: access, refresh_token: refresh, expires_in: 30 }));
		expect(await openaiCodexOAuth.refresh(current, new AbortController().signal)).toMatchObject({
			refresh,
			expires: 31000,
		});
	}
	vi.stubGlobal(
		"fetch",
		async () => new Response(`{"access_token":${JSON.stringify(access)},"refresh_token":"r","expires_in":1e400}`),
	);
	expect((await openaiCodexOAuth.refresh(current, new AbortController().signal)).expires).toBe(Infinity);
});

test("legacy Codex device login exchanges its authorization code and rejects unavailable device service", async () => {
	const requests: string[] = [],
		notifications: string[] = [];
	vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
		requests.push(String(url));
		if (String(url).endsWith("/usercode"))
			return Response.json({ device_auth_id: "device", user_code: "LOCAL-CODE", interval: "0" });
		if (String(url).endsWith("deviceauth/token"))
			return Response.json({ authorization_code: "approved", code_verifier: "verifier" });
		return Response.json({ access_token: access, refresh_token: "device-refresh", expires_in: 30 });
	});
	const interaction: ProviderAuthInteraction = {
		signal: new AbortController().signal,
		prompt: async () => "device_code",
		notify(event) {
			if (event.type === "device_code") notifications.push(event.userCode);
		},
	};
	expect(await openaiCodexOAuth.login(interaction)).toMatchObject({
		type: "oauth",
		refresh: "device-refresh",
		accountId: "test-account",
	});
	expect(notifications).toEqual(["LOCAL-CODE"]);
	expect(requests).toEqual([
		"https://auth.openai.com/api/accounts/deviceauth/usercode",
		"https://auth.openai.com/api/accounts/deviceauth/token",
		"https://auth.openai.com/oauth/token",
	]);
	vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
	await expect(openaiCodexOAuth.login(interaction)).rejects.toThrow("device code login is not enabled");
});
