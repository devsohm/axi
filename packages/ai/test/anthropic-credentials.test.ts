import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stream, streamSimple, type AnthropicOptions } from "../src/api/anthropic-messages.ts";
import type { Model, ProviderEnv, ProviderHeaders } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
	id: "credential-test",
	name: "Credential test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://credentials.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 32000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const federationVariables = [
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_WORKSPACE_ID",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
] as const;
beforeEach(() => {
	for (const name of [...federationVariables, "AXI_CACHE_RETENTION", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])
		vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());

function answer(): Response {
	return new Response(
		[
			{ type: "message_start", message: { id: "credential-response", usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ready" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]
			.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

const unauthenticatedHeaders: (ProviderHeaders | undefined)[] = [
	undefined,
	{},
	{ Authorization: " " },
	{ "x-api-key": null },
	{ "x-note": "present" },
];
test.each(unauthenticatedHeaders)(
	"requests without usable authentication fail before HTTP dispatch: %j",
	async (headers) => {
		const fetch = vi.fn(async () => answer());
		const options = { headers, fetch };
		expect(await stream(model, context, options).result()).toMatchObject({
			stopReason: "error",
			errorMessage: "No API key for provider: anthropic",
		});
		expect(() => streamSimple(model, context, options)).toThrow("No API key for provider: anthropic");
		expect(fetch).not.toHaveBeenCalled();
	},
);

test.each(["Authorization", "X-API-Key", "CF-AIG-Authorization"])(
	"header-owned authentication reaches the SDK without an API key: %s",
	async (name) => {
		const requests: Headers[] = [];
		const result = await streamSimple(model, context, {
			headers: {
				"x-note": "ignored for authentication",
				...(name === "CF-AIG-Authorization" ? { Authorization: null } : {}),
				[name]: "credential",
			},
			fetch: async (_url, init) => {
				requests.push(new Headers(init?.headers));
				return answer();
			},
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0]!.get(name)).toBe("credential");
		if (name !== "X-API-Key") expect(requests[0]!.get("x-api-key")).toBeNull();
	},
);

test("an incomplete federation configuration cannot authenticate a request", async () => {
	for (const missing of federationVariables.slice(0, 3)) {
		const env: ProviderEnv = {
			ANTHROPIC_FEDERATION_RULE_ID: "rule",
			ANTHROPIC_ORGANIZATION_ID: "organization",
			ANTHROPIC_IDENTITY_TOKEN_FILE: "/unused-identity-token",
		};
		delete env[missing];
		const fetch = vi.fn(async () => answer());
		expect(await stream(model, context, { env, fetch }).result()).toMatchObject({ stopReason: "error" });
		expect(fetch).not.toHaveBeenCalled();
	}
});

test("keys and explicit authentication headers take precedence over federation configuration", async () => {
	const env = {
		ANTHROPIC_FEDERATION_RULE_ID: "rule",
		ANTHROPIC_ORGANIZATION_ID: "organization",
		ANTHROPIC_IDENTITY_TOKEN_FILE: "/must-not-read-this-file",
	};
	for (const auth of [{ apiKey: "selected-key" }, { headers: { Authorization: "Bearer selected-header" } }]) {
		const requests: { url: string; headers: Headers }[] = [];
		const result = await stream(model, context, {
			...auth,
			env,
			fetch: async (url, init) => {
				requests.push({ url: String(url), headers: new Headers(init?.headers) });
				return answer();
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(new URL(requests[0]!.url).pathname).toBe("/v1/messages");
		expect(requests[0]!.headers.get("x-api-key")).toBe(auth.apiKey ?? null);
		expect(requests[0]!.headers.get("authorization")).toBe(auth.headers?.Authorization ?? null);
	}
	const fetch = vi.fn(async () => answer());
	expect(await stream({ ...model, provider: "company-proxy" }, context, { env, fetch }).result()).toMatchObject({
		stopReason: "error",
		errorMessage: "No API key for provider: company-proxy",
	});
	expect(fetch).not.toHaveBeenCalled();
});

const headerOverrides: { model: Record<string, string>; request: ProviderHeaders; key: string | null }[] = [
	{ model: { "X-Api-Key": "model" }, request: { "x-api-key": "request" }, key: "request" },
	{ model: { "x-api-key": "model" }, request: { "X-Api-Key": "request" }, key: "request" },
	{ model: { "X-Api-Key": "model" }, request: { "x-api-key": null, Authorization: "Bearer request" }, key: null },
];
test.each(headerOverrides)(
	"API-key overrides remain authoritative across header casing: %j",
	async ({ model: modelHeaders, request, key }) => {
		let received: Headers | undefined;
		const result = await stream({ ...model, headers: modelHeaders }, context, {
			apiKey: "default-key",
			headers: request,
			fetch: async (_url, init) => {
				received = new Headers(init?.headers);
				return answer();
			},
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(received?.get("x-api-key")).toBe(key);
		expect(received?.get("authorization")).toBe(key === null ? "Bearer request" : null);
	},
);

test("federated SDK credentials are reused while request headers stay local to each call", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-federation-")),
		path = join(directory, "identity");
	try {
		await writeFile(path, "synthetic-identity");
		const env: ProviderEnv = {
			ANTHROPIC_FEDERATION_RULE_ID: "rule",
			ANTHROPIC_ORGANIZATION_ID: "organization",
			ANTHROPIC_IDENTITY_TOKEN_FILE: path,
			ANTHROPIC_WORKSPACE_ID: "workspace",
			ANTHROPIC_SERVICE_ACCOUNT_ID: "service-account",
		};
		const exchanges: unknown[] = [],
			requests: Headers[] = [];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			if (new URL(String(url)).pathname === "/v1/oauth/token") {
				exchanges.push(JSON.parse(String(init?.body)));
				return Response.json({ access_token: `federated-${exchanges.length}`, token_type: "Bearer", expires_in: 3600 });
			}
			requests.push(new Headers(init?.headers));
			return answer();
		};
		for (const marker of ["first", "second"]) {
			const result = await streamSimple(model, context, {
				env,
				fetch,
				headers: { "x-request-marker": marker },
			}).result();
			expect(result.stopReason).toBe("stop");
		}
		expect(exchanges).toEqual([
			{
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: "synthetic-identity",
				federation_rule_id: "rule",
				organization_id: "organization",
				workspace_id: "workspace",
				service_account_id: "service-account",
			},
		]);
		expect(requests.map((headers) => headers.get("authorization"))).toEqual([
			"Bearer federated-1",
			"Bearer federated-1",
		]);
		expect(requests.map((headers) => headers.get("x-request-marker"))).toEqual(["first", "second"]);
		const changed = { ...env, ANTHROPIC_WORKSPACE_ID: "other-workspace" };
		expect((await stream(model, context, { env: changed, fetch }).result()).stopReason).toBe("stop");
		expect(exchanges).toHaveLength(2);
		expect(exchanges[1]).toMatchObject({ workspace_id: "other-workspace" });
		const otherFetch: typeof globalThis.fetch = (url, init) => fetch(url, init);
		expect((await stream(model, context, { env: changed, fetch: otherFetch }).result()).stopReason).toBe("stop");
		expect(exchanges).toHaveLength(3);
		expect(requests.at(-1)!.get("authorization")).toBe("Bearer federated-3");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.each([undefined, "short", "none"] as const)(
	"explicit cache retention %s controls affinity and overrides the environment",
	async (cacheRetention) => {
		vi.stubEnv("AXI_CACHE_RETENTION", "long");
		let headers: Headers | undefined, body: unknown;
		const options: AnthropicOptions = {
			apiKey: "key",
			sessionId: "affinity-test",
			cacheRetention,
			fetch: async (_url, init) => {
				headers = new Headers(init?.headers);
				body = JSON.parse(String(init?.body));
				return answer();
			},
		};
		expect((await stream({ ...model, provider: "openrouter" }, context, options).result()).stopReason).toBe("stop");
		expect(headers?.get("x-session-id")).toBe(cacheRetention === "none" ? null : "affinity-test");
		const cache =
			cacheRetention === "none"
				? undefined
				: { type: "ephemeral", ...(cacheRetention === undefined ? { ttl: "1h" } : {}) };
		expect(body).toMatchObject({
			messages: [{ content: cache ? [{ type: "text", text: "hello", cache_control: cache }] : "hello" }],
		});
		if (cacheRetention === "none") expect(JSON.stringify(body)).not.toContain("cache_control");
	},
);
