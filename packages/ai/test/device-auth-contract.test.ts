import { afterEach, expect, test, vi } from "vitest";
import type { OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import { kimiCodingProvider } from "../src/providers/kimi-coding.ts";
import { metaProvider } from "../src/providers/meta.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});
const original: OAuthCredential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 };
const device = {
	device_code: "device",
	user_code: "user",
	verification_uri: "https://login.example/device",
	verification_uri_complete: "https://login.example/device?code=user",
	interval: 1,
	expires_in: 60,
};
async function auth(provider: "kimi" | "meta"): Promise<OAuthAuth> {
	const method = (provider === "kimi" ? kimiCodingProvider() : metaProvider()).auth.oauth;
	if (!method) throw new Error("Missing OAuth support");
	await method.toAuth(original);
	return method;
}
function responses(sequence: (Response | Error | string)[]) {
	const send = vi.fn(async () => {
		const response = sequence.shift();
		if (response instanceof Response) return response;
		throw response ?? new Error("Unexpected OAuth request");
	});
	vi.stubGlobal("fetch", send);
	return send;
}

test("Kimi lazy OAuth polls with backoff, exchanges form fields and returns a usable bearer credential", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1800000000000);
	vi.stubEnv("KIMI_CODE_OAUTH_HOST", "https://login.example///");
	const requests: { url: string; fields: URLSearchParams; time: number }[] = [];
	let count = 0;
	vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
		requests.push({ url: String(url), fields: new URLSearchParams(String(init?.body)), time: Date.now() });
		return [
			Response.json(device),
			Response.json({ error: "authorization_pending" }, { status: 400 }),
			Response.json({ error: "slow_down", interval: 2 }, { status: 400 }),
			Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
		][count++];
	});
	const method = await auth("kimi"),
		notify = vi.fn();
	const pending = method.login({ signal: new AbortController().signal, prompt: async () => "", notify });
	await vi.advanceTimersByTimeAsync(4000);
	const credential = await pending;
	expect(requests.map((request) => request.time - 1800000000000)).toEqual([0, 1000, 2000, 4000]);
	expect(requests[0]!.url).toBe("https://login.example/api/oauth/device_authorization");
	expect(requests[1]!.fields.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
	expect(requests[1]!.fields.get("device_code")).toBe("device");
	expect(credential).toEqual({ type: "oauth", access: "access", refresh: "refresh", expires: 1800003604000 });
	expect(await method.toAuth(credential)).toEqual({ headers: { Authorization: "Bearer access" } });
	expect(notify).toHaveBeenCalledWith(
		expect.objectContaining({
			type: "device_code",
			userCode: "user",
			verificationUri: device.verification_uri_complete,
		}),
	);
});

for (const provider of ["kimi", "meta"] as const)
	test(`${provider} reports device authorization and token failures without accepting malformed credentials`, async () => {
		vi.useFakeTimers();
		const method = await auth(provider);
		for (const [response, message] of [
			[Response.json({ error: "access_denied" }, { status: 400 }), "denied"],
			[Response.json({ error: "expired_token" }, { status: 400 }), "expired"],
			[
				Response.json({ error: "unsupported", error_description: "bad grant" }, { status: 400 }),
				provider === "kimi" ? "unsupported" : "bad grant",
			],
			[new Response("service unavailable", { status: 503 }), "503"],
			[
				Response.json({ access_token: "access", expires_in: 3600 }),
				provider === "kimi" ? "missing fields" : "Unexpected OAuth request",
			],
		] satisfies [Response, string][]) {
			responses([Response.json(device), response]);
			const failure = expect(
				method.login({ signal: new AbortController().signal, prompt: async () => "", notify() {} }),
			).rejects.toThrow(message);
			await Promise.all([failure, vi.advanceTimersByTimeAsync(1000)]);
		}
		for (const response of [
			Response.json({}, { status: 403 }),
			Response.json({ ...device, device_code: null }),
			Response.json({ ...device, verification_uri: "javascript:bad", verification_uri_complete: "javascript:bad" }),
		]) {
			responses([response]);
			await expect(
				method.login({ signal: new AbortController().signal, prompt: async () => "", notify() {} }),
			).rejects.toThrow(/authorization/);
		}
	});

test("Kimi refresh retries transient failures with a bounded budget and stops on invalid grants", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1800000000000);
	const method = await auth("kimi");
	const send = responses([
		new Error("offline"),
		Response.json({}, { status: 503 }),
		Response.json({}, { status: 429 }),
		Response.json({ access_token: "renewed", refresh_token: "rotated", expires_in: 60 }),
	]);
	const pending = method.refresh(original, new AbortController().signal);
	await vi.advanceTimersByTimeAsync(7000);
	expect(await pending).toEqual({ type: "oauth", access: "renewed", refresh: "rotated", expires: 1800000067000 });
	expect(send).toHaveBeenCalledTimes(4);
	for (const response of [
		Response.json({}, { status: 401 }),
		Response.json({ error: "invalid_grant", error_description: "expired identity" }, { status: 400 }),
		Response.json({}, { status: 403 }),
	]) {
		const attempt = responses([response]);
		await expect(method.refresh(original, new AbortController().signal)).rejects.toThrow(/unauthorized/);
		expect(attempt).toHaveBeenCalledOnce();
	}
	responses([Response.json({ detail: "bad input" }, { status: 400 })]);
	await expect(method.refresh(original, new AbortController().signal)).rejects.toThrow(/400/);
	responses([Response.json({ access_token: "incomplete" })]);
	await expect(method.refresh(original, new AbortController().signal)).rejects.toThrow(/missing fields/);
	responses(["offline", "offline", "offline", "offline"]);
	const exhausted = expect(method.refresh(original, new AbortController().signal)).rejects.toThrow("offline");
	await Promise.all([exhausted, vi.advanceTimersByTimeAsync(7000)]);
	await expect(method.refresh(original, AbortSignal.abort())).rejects.toThrow(/aborted/);
});

test("Meta exchanges its device identity for an API key and refreshes with the retained identity", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1800000000000);
	const requests: { url: string; init?: RequestInit }[] = [];
	let count = 0;
	vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
		requests.push({ url: String(url), init });
		return [
			Response.json(device),
			Response.json({ error: "authorization_pending" }, { status: 400 }),
			Response.json({ error: "slow_down", interval: 1 }, { status: 400 }),
			Response.json({ access_token: "identity" }),
			Response.json({ api_key: "api-key" }),
			Response.json({ api_key: "renewed-key" }),
		][count++];
	});
	const method = await auth("meta"),
		notify = vi.fn();
	const pending = method.login({ signal: new AbortController().signal, prompt: async () => "", notify });
	await vi.advanceTimersByTimeAsync(3000);
	const credential = await pending;
	expect(credential).toEqual({ type: "oauth", refresh: "identity", access: "api-key", expires: 1800086403000 });
	expect(requests.at(-1)).toMatchObject({
		url: "https://api.meta.ai/muse-code/key",
		init: { method: "POST", body: "{}", headers: { Authorization: "Bearer identity" } },
	});
	expect(await method.toAuth(credential)).toEqual({ apiKey: "api-key" });
	expect(await method.refresh(credential, new AbortController().signal)).toEqual({
		...credential,
		access: "renewed-key",
	});
	expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "progress" }));
});

test("Meta reports setup and mint errors, and cancellation stops device polling", async () => {
	vi.useFakeTimers();
	const method = await auth("meta");
	for (const [response, message] of [
		[Response.json({ detail: "temporarily unavailable" }, { status: 503 }), "temporarily unavailable"],
		[Response.json({ action_url: "https://setup.example/finish" }), "Complete setup at https://setup.example/finish"],
		[Response.json({ message: "expired" }, { status: 401 }), "session expired"],
	] satisfies [Response, string][]) {
		responses([response]);
		await expect(method.refresh(original, new AbortController().signal)).rejects.toThrow(message);
	}
	const send = responses([Response.json(device)]),
		controller = new AbortController();
	const failure = expect(
		method.login({
			signal: controller.signal,
			prompt: async () => "",
			notify() {
				controller.abort();
			},
		}),
	).rejects.toThrow("Login cancelled");
	await Promise.all([failure, vi.advanceTimersByTimeAsync(1000)]);
	expect(send).toHaveBeenCalledOnce();
});
