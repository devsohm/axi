import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { openRouterOAuth } from "../src/auth/oauth/openrouter.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { metaOAuth } from "../src/auth/oauth/meta.ts";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels, createProvider } from "../src/models.ts";
import { openAICompletionsApi } from "../src/api/openai-completions.lazy.ts";
import { anthropicMessagesApi } from "../src/api/anthropic-messages.lazy.ts";
const nativeFetch = globalThis.fetch;
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});
describe("Provider login flows", () => {
	it("identifies Axi during xAI device login and honors server polling backoff", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1800000000000);
		const polls: number[] = [];
		vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
			const fields = new URLSearchParams(String(init?.body));
			if (String(input).endsWith("/device/code")) {
				expect(fields.get("referrer")).toBe("axi");
				expect(fields.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				return Response.json({
					device_code: "device",
					user_code: "user",
					verification_uri: "https://accounts.x.ai/device",
					interval: 1,
					expires_in: 600,
				});
			}
			polls.push(Date.now());
			return polls.length === 1
				? Response.json({ error: "authorization_pending" }, { status: 400 })
				: polls.length === 2
					? Response.json({ error: "slow_down", interval: 2 }, { status: 400 })
					: Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
		});
		const login = xaiOAuth.login({ signal: new AbortController().signal, prompt: async () => "", notify() {} });
		await vi.advanceTimersByTimeAsync(4000);
		expect(polls).toEqual([1800000001000, 1800000002000, 1800000004000]);
		expect(await login).toEqual({ type: "oauth", access: "access", refresh: "refresh", expires: 1800003304000 });
	});
	it("exchanges an OpenRouter callback once and verifies PKCE", async () => {
		let auth: URL | undefined,
			page: Promise<Response> | undefined,
			posted: Record<string, string> | undefined,
			manualSignal: AbortSignal | undefined;
		const exchange = vi.fn(async (_url: unknown, init?: RequestInit) => {
			posted = JSON.parse(String(init?.body));
			return Response.json({ key: "offline-permanent-key" });
		});
		vi.stubGlobal("fetch", exchange);
		const value = await openRouterOAuth.login({
			signal: new AbortController().signal,
			prompt: (prompt) => {
				manualSignal = prompt.signal;
				return new Promise(() => {});
			},
			notify: (event) => {
				if (event.type === "auth_url") {
					auth = new URL(event.url);
					const callback = new URL(auth.searchParams.get("callback_url") ?? "");
					callback.searchParams.set("code", "offline-code");
					page = nativeFetch(callback);
				}
			},
		});
		expect(value).toEqual({
			type: "oauth",
			access: "offline-permanent-key",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		});
		expect((await page)?.status).toBe(200);
		expect(manualSignal?.aborted).toBe(true);
		expect(exchange).toHaveBeenCalledTimes(1);
		expect(posted).toMatchObject({ code: "offline-code", code_challenge_method: "S256" });
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(posted?.code_verifier));
		expect(auth?.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
	});
	it("logs in through Models and reuses the permanent key without refresh", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ key: "offline-key" })),
		);
		const credentials = new InMemoryCredentialStore(),
			models = createModels({ credentials });
		models.setProvider(
			createProvider({ id: "router-test", auth: { oauth: openRouterOAuth }, api: openAICompletionsApi(), models: [] }),
		);
		expect(await models.login("router-test", "oauth", { prompt: async () => "code=manual-code", notify() {} })).toEqual(
			{ type: "oauth", access: "offline-key", refresh: "", expires: Number.MAX_SAFE_INTEGER },
		);
		expect(await models.getAuth("router-test")).toEqual({ auth: { apiKey: "offline-key" }, source: "OAuth" });
		expect(await credentials.read("router-test")).toMatchObject({ access: "offline-key" });
	});
	it("closes OpenRouter callback listeners after cancellation", async () => {
		const abort = new AbortController();
		let callback: string | undefined;
		const task = openRouterOAuth.login({
			signal: abort.signal,
			prompt: () => new Promise(() => {}),
			notify: (event) => {
				if (event.type === "auth_url") {
					callback = new URL(event.url).searchParams.get("callback_url") ?? undefined;
					abort.abort();
				}
			},
		});
		await expect(task).rejects.toThrow("Login cancelled");
		if (!callback) throw new Error("No callback URL");
		await expect(nativeFetch(callback)).rejects.toThrow();
	});
	it("rejects mismatched Anthropic state before exchanging a code", async () => {
		const send = vi.fn(async () => Response.json({ access_token: "unexpected" }));
		vi.stubGlobal("fetch", send);
		await expect(
			anthropicOAuth.login({
				signal: new AbortController().signal,
				notify() {},
				prompt: async (value) => (value.type === "select" ? "copy_code" : "code#wrong-state"),
			}),
		).rejects.toThrow("OAuth state mismatch");
		expect(send).not.toHaveBeenCalled();
	});
	it("refreshes expired Anthropic credentials once for concurrent callers", async () => {
		const send = vi.fn(async () =>
			Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		);
		vi.stubGlobal("fetch", send);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic-test", async () => ({
			type: "oauth",
			access: "old",
			refresh: "refresh",
			expires: 0,
		}));
		const models = createModels({ credentials });
		models.setProvider(
			createProvider({
				id: "anthropic-test",
				auth: { oauth: anthropicOAuth },
				api: anthropicMessagesApi(),
				models: [],
			}),
		);
		expect(await Promise.all([models.getAuth("anthropic-test"), models.getAuth("anthropic-test")])).toEqual([
			{ auth: { apiKey: "new-access" }, source: "OAuth" },
			{ auth: { apiKey: "new-access" }, source: "OAuth" },
		]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(await credentials.read("anthropic-test")).toMatchObject({ access: "new-access", refresh: "new-refresh" });
	});
	it("rejects unsafe Kimi verification URLs before exposing them to the UI", async () => {
		vi.stubGlobal("fetch", async () =>
			Response.json({
				device_code: "code",
				user_code: "user",
				verification_uri: "https://example.invalid",
				verification_uri_complete: "javascript:alert(1)",
			}),
		);
		const notify = vi.fn();
		await expect(
			kimiCodingOAuth.login({ signal: new AbortController().signal, prompt: async () => "", notify }),
		).rejects.toThrow("Invalid Kimi Code device authorization response");
		expect(notify).not.toHaveBeenCalled();
	});
	it("does not retry expired Meta identities or expose unsafe setup URLs", async () => {
		const send = vi.fn(async () => Response.json({ message: "expired" }, { status: 403 }));
		vi.stubGlobal("fetch", send);
		await expect(
			metaOAuth.refresh(
				{ type: "oauth", access: "key", refresh: "identity", expires: 0 },
				new AbortController().signal,
			),
		).rejects.toThrow("Meta session expired (status 403)");
		expect(send).toHaveBeenCalledTimes(1);
		send.mockImplementation(async () => Response.json({ action_url: "javascript:alert(1)" }));
		await expect(
			metaOAuth.refresh(
				{ type: "oauth", access: "key", refresh: "identity", expires: 0 },
				new AbortController().signal,
			),
		).rejects.toThrow(/^Meta did not issue an API key\.$/);
	});
});
