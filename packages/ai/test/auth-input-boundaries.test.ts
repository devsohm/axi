import { afterEach, expect, test, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { openRouterOAuth } from "../src/auth/oauth/openrouter.ts";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import type { AuthPrompt, OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { fauxProvider } from "../src/providers/faux.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("API-key login prompts for a secret and stores it for the registered provider", async () => {
	const credentials = new InMemoryCredentialStore(),
		models = createModels({ credentials });
	models.setProvider({ ...fauxProvider().provider, auth: { apiKey: envApiKeyAuth("Local key", []) } });
	const prompts: AuthPrompt[] = [];
	expect(
		await models.login("faux", "api_key", {
			prompt: async (prompt) => {
				prompts.push(prompt);
				return "local-secret";
			},
			notify() {},
		}),
	).toEqual({ type: "api_key", key: "local-secret" });
	expect(prompts).toEqual([{ type: "secret", message: "Enter Local key" }]);
	expect(await credentials.read("faux")).toEqual({ type: "api_key", key: "local-secret" });
	expect(await models.getAuth("faux")).toEqual({
		auth: { apiKey: "local-secret" },
		env: undefined,
		source: "stored credential",
	});
});

test.each(["before", "during"] as const)(
	"cancelling %s an API-key prompt does not save its response",
	async (stage) => {
		const credentials = new InMemoryCredentialStore(),
			models = createModels({ credentials }),
			controller = new AbortController();
		models.setProvider({ ...fauxProvider().provider, auth: { apiKey: envApiKeyAuth("Local key", []) } });
		const failure = new Error("Prompt cancelled"),
			prompt = vi.fn(async () => {
				controller.abort(failure);
				return "discarded";
			});
		if (stage === "before") controller.abort(failure);
		await expect(models.login("faux", "api_key", { signal: controller.signal, prompt, notify() {} })).rejects.toBe(
			failure,
		);
		expect(prompt).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
		expect(await credentials.list()).toEqual([]);
	},
);

test("auth environment overrides retain access to the caller's ambient credential files", async () => {
	const files: string[] = [],
		models = createModels({
			authContext: {
				env: async (name) => (name === "AMBIENT" ? "ambient-value" : undefined),
				fileExists: async (path) => {
					files.push(path);
					return path === "identity.json";
				},
			},
		});
	models.setProvider({
		...fauxProvider().provider,
		auth: {
			apiKey: {
				name: "File identity",
				async resolve({ ctx }) {
					return {
						auth: {
							apiKey: (await ctx.fileExists("identity.json"))
								? `${await ctx.env("OVERRIDE")}:${await ctx.env("AMBIENT")}`
								: "absent",
						},
					};
				},
			},
		},
	});
	expect(await models.getAuth("faux", { env: { OVERRIDE: "override-value" } })).toEqual({
		auth: { apiKey: "override-value:ambient-value" },
	});
	expect(files).toEqual(["identity.json"]);
});

test.each([
	{ body: { error_description: "Denied by account" }, detail: "Denied by account" },
	{ body: { message: "Denied by gateway" }, detail: "Denied by gateway" },
	{ body: { error: "invalid_code" }, detail: "invalid_code" },
	{ body: { error: { message: "Nested refusal" } }, detail: "Nested refusal" },
	{ body: { error: [] }, detail: "HTTP 403" },
	{ body: null, detail: "HTTP 403" },
])("OpenRouter reports a failed authorization exchange: $detail", async ({ body, detail }) => {
	const exchange = vi.fn(async () => Response.json(body, { status: 403 }));
	vi.stubGlobal("fetch", exchange);
	await expect(
		openRouterOAuth.login({
			signal: new AbortController().signal,
			prompt: async () => "code=offline-code",
			notify() {},
		}),
	).rejects.toThrow(detail);
	expect(exchange).toHaveBeenCalledOnce();
});

test.each([
	{ status: 200, body: "invalid JSON", detail: "invalid JSON" },
	{ status: 401, body: "invalid JSON", detail: "HTTP 401" },
	{ status: 200, body: "[]", detail: 'no "key"' },
	{ status: 200, body: '{"key":""}', detail: 'no "key"' },
])("OpenRouter rejects malformed exchange replies with status $status", async ({ status, body, detail }) => {
	vi.stubGlobal("fetch", async () => new Response(body, { status }));
	await expect(
		openRouterOAuth.login({ signal: new AbortController().signal, prompt: async () => "offline-code", notify() {} }),
	).rejects.toThrow(detail);
});

test.each(["cancelled", "timeout"] as const)("OpenRouter aborts an in-flight key exchange when %s", async (mode) => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const controller = new AbortController(),
		entered = Promise.withResolvers<AbortSignal>();
	vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
		const signal = init?.signal;
		if (!signal) throw new Error("Exchange did not carry cancellation");
		entered.resolve(signal);
		return new Promise<Response>((_resolve, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
		);
	});
	const login = openRouterOAuth.login({ signal: controller.signal, prompt: async () => "offline-code", notify() {} });
	const rejected = expect(login).rejects.toThrow(mode === "cancelled" ? "Login cancelled" : "token exchange timed out");
	const exchangeSignal = await entered.promise;
	if (mode === "cancelled") controller.abort();
	else await vi.advanceTimersByTimeAsync(30_000);
	await rejected;
	expect(exchangeSignal.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

const previous: OAuthCredential = { type: "oauth", access: "old", refresh: "refresh", expires: 0 };
test.each([
	{
		status: 401,
		body: { error: "invalid_grant", error_description: "Expired grant" },
		detail: "invalid_grant: Expired grant",
	},
	{ status: 403, body: { error: 4, error_description: "Denied" }, detail: "Denied" },
	{ status: 500, body: {}, detail: "HTTP 500" },
	{ status: 200, body: [], detail: "access_token" },
	{ status: 200, body: { access_token: "next", expires_in: 0 }, detail: "expires_in" },
])("xAI refresh rejects an invalid token reply: $detail", async ({ status, body, detail }) => {
	vi.stubGlobal("fetch", async () => Response.json(body, { status }));
	await expect(xaiOAuth.refresh(previous, new AbortController().signal)).rejects.toThrow(detail);
	expect(previous).toEqual({ type: "oauth", access: "old", refresh: "refresh", expires: 0 });
});

test("xAI refresh retains the previous refresh token and supplies its default token lifetime", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_800_000_000_000);
	vi.stubGlobal("fetch", async () => Response.json({ access_token: "next" }));
	expect(await xaiOAuth.refresh(previous, new AbortController().signal)).toEqual({
		type: "oauth",
		access: "next",
		refresh: "refresh",
		expires: 1_800_003_300_000,
	});
});
