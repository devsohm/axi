import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { defaultProviderAuthContext } from "../src/auth/context.ts";
import type { ApiKeyAuth, ApiKeyCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
import { amazonBedrockProvider } from "../src/providers/amazon-bedrock.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";
import { cloudflareAIGatewayAuth, cloudflareWorkersAIAuth } from "../src/providers/cloudflare-auth.ts";
import {
	builtinModels,
	builtinProviders,
	getAllBuiltinModels,
	getBuiltinClassifierModel,
	getBuiltinClassifierModels,
	getBuiltinImageModel,
	getBuiltinImageModels,
	getBuiltinModel,
	getBuiltinModelDataGeneratedAt,
	getBuiltinModels,
	getBuiltinProviders,
} from "../src/providers/all.ts";

afterEach(() => vi.unstubAllEnvs());

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Required authentication method is absent");
	return value;
}
function input(env: Record<string, string> = {}, credential?: ApiKeyCredential, exists = false) {
	return {
		credential,
		signal: new AbortController().signal,
		ctx: { env: async (name: string) => env[name], fileExists: async () => exists },
	};
}
async function login(auth: ApiKeyAuth, responses: string[]) {
	const prompt = vi.fn(async () => {
		const response = responses.shift();
		if (response === undefined) throw new Error("Unexpected prompt");
		return response;
	});
	const interaction = {
		prompt,
		notify: vi.fn(),
		signal: new AbortController().signal,
	} satisfies ProviderAuthInteraction;
	const credential = await required(auth.login)(interaction);
	expect(responses).toEqual([]);
	return { credential, interaction };
}

test("every bundled provider exposes its complete chat, image and classifier catalog without network access", () => {
	const providers = builtinProviders(),
		models = builtinModels();
	expect(providers.map((provider) => provider.id).sort()).toEqual([...getBuiltinProviders()].sort());
	expect(new Set(providers.map((provider) => provider.id)).size).toBe(providers.length);
	expect(getBuiltinModelDataGeneratedAt()).toBeGreaterThan(Date.UTC(2025, 0, 1));
	for (const id of getBuiltinProviders()) {
		const provider = required(providers.find((provider) => provider.id === id));
		expect(models.getProvider(id)?.name).toBe(provider.name);
		expect(provider.getAllModels?.()).toEqual(getAllBuiltinModels(id));
		expect(provider.getModels()).toEqual(getBuiltinModels(id));
		for (const model of getBuiltinModels(id)) {
			expect(Reflect.apply(getBuiltinModel, undefined, [id, model.id])).toEqual(model);
			expect(model.provider).toBe(id);
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
			expect(model.input.length).toBeGreaterThan(0);
		}
		for (const model of getBuiltinImageModels(id))
			expect(Reflect.apply(getBuiltinImageModel, undefined, [id, model.id])).toEqual(model);
		for (const model of getBuiltinClassifierModels(id))
			expect(Reflect.apply(getBuiltinClassifierModel, undefined, [id, model.id])).toEqual(model);
	}
});

test("Cloudflare login and resolution preserve account, gateway and header ownership", async () => {
	for (const gateway of [false, true]) {
		const auth = gateway ? cloudflareAIGatewayAuth() : cloudflareWorkersAIAuth();
		const { credential, interaction } = await login(auth, ["token", "account", ...(gateway ? ["gateway"] : [])]);
		expect(interaction.prompt.mock.calls.length).toBe(gateway ? 3 : 2);
		const env = { CLOUDFLARE_ACCOUNT_ID: "account", ...(gateway ? { CLOUDFLARE_GATEWAY_ID: "gateway" } : {}) };
		expect(credential).toEqual({ type: "api_key", key: "token", env });
		const expected = gateway
			? { headers: { "cf-aig-authorization": "Bearer token", Authorization: null, "x-api-key": null } }
			: { apiKey: "token" };
		expect(await auth.resolve(input({}, credential))).toEqual({ auth: expected, env, source: "stored credential" });
		expect(await auth.resolve(input({ ...env, CLOUDFLARE_API_KEY: "token" }))).toEqual({
			auth: expected,
			env,
			source: "CLOUDFLARE_API_KEY",
		});
		for (const missing of [
			"CLOUDFLARE_API_KEY",
			"CLOUDFLARE_ACCOUNT_ID",
			...(gateway ? ["CLOUDFLARE_GATEWAY_ID"] : []),
		]) {
			const incomplete: Record<string, string> = { ...env, CLOUDFLARE_API_KEY: "token" };
			delete incomplete[missing];
			expect(await auth.resolve(input(incomplete))).toBeUndefined();
		}
	}
});

test("Anthropic selects stored credentials before bearer, OAuth and API-key environment values", async () => {
	const auth = required(anthropicProvider().auth.apiKey);
	const env = { ANTHROPIC_AUTH_TOKEN: "bearer", ANTHROPIC_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "key" };
	expect(await auth.resolve(input(env, { type: "api_key", key: "stored", env: { region: "local" } }))).toEqual({
		auth: { apiKey: "stored" },
		env: { region: "local" },
		source: "stored credential",
	});
	expect(await auth.resolve(input(env))).toEqual({
		auth: { headers: { Authorization: "Bearer bearer" } },
		source: "ANTHROPIC_AUTH_TOKEN",
	});
	expect(await auth.resolve(input({ ...env, ANTHROPIC_AUTH_TOKEN: "" }))).toEqual({
		auth: { apiKey: "oauth" },
		source: "ANTHROPIC_OAUTH_TOKEN",
	});
	expect(await auth.resolve(input({ ANTHROPIC_API_KEY: "key" }))).toEqual({
		auth: { apiKey: "key" },
		source: "ANTHROPIC_API_KEY",
	});
});

test("Anthropic federation requires its identity settings and preserves optional scope settings", async () => {
	const auth = required(anthropicProvider().auth.apiKey);
	const env = {
		ANTHROPIC_FEDERATION_RULE_ID: "rule",
		ANTHROPIC_ORGANIZATION_ID: "organization",
		ANTHROPIC_IDENTITY_TOKEN_FILE: "/synthetic-identity",
	};
	for (const field of Object.keys(env)) {
		const incomplete: Record<string, string> = { ...env };
		delete incomplete[field];
		expect(await auth.resolve(input(incomplete))).toBeUndefined();
	}
	for (const configured of [
		env,
		{ ...env, ANTHROPIC_SERVICE_ACCOUNT_ID: "service", ANTHROPIC_WORKSPACE_ID: "workspace" },
	])
		expect(await auth.resolve(input(configured))).toEqual({
			auth: {},
			env: configured,
			source: "workload identity federation",
		});
});

test.each([
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"ANTHROPIC_WORKSPACE_ID",
])("Anthropic cancellation during %s lookup prevents credentials being adopted", async (field) => {
	const auth = required(anthropicProvider().auth.apiKey);
	const controller = new AbortController();
	const reason = new Error("Lookup cancelled");
	const env: Record<string, string> = {
		ANTHROPIC_FEDERATION_RULE_ID: "rule",
		ANTHROPIC_ORGANIZATION_ID: "organization",
		ANTHROPIC_IDENTITY_TOKEN_FILE: "/synthetic-identity",
		[field]: "value",
	};
	await expect(
		auth.resolve({
			signal: controller.signal,
			ctx: {
				env: async (name) => {
					if (name === field) controller.abort(reason);
					return env[name];
				},
				fileExists: async () => false,
			},
		}),
	).rejects.toBe(reason);
});

test("Vertex supports keys, ADC and service-account setup with cancellation during environment lookup", async () => {
	const auth = required(googleVertexProvider().auth.apiKey);
	expect((await login(auth, ["api-key", "key"])).credential).toEqual({ type: "api_key", key: "key" });
	for (const method of ["adc", "service-account"]) {
		const env = {
			GOOGLE_CLOUD_PROJECT: "project",
			GOOGLE_CLOUD_LOCATION: "location",
			...(method === "service-account" ? { GOOGLE_APPLICATION_CREDENTIALS: "/credentials.json" } : {}),
		};
		const result = await login(auth, [
			method,
			"project",
			"location",
			...(method === "service-account" ? ["/credentials.json"] : []),
		]);
		expect(result.credential).toEqual({ type: "api_key", env });
		expect(result.interaction.notify).toHaveBeenCalledOnce();
		expect(await auth.resolve(input({}, result.credential, true))).toEqual({
			auth: {},
			env,
			source: "stored credential",
		});
	}
	await expect(login(auth, ["unknown"])).rejects.toThrow(/Unknown.*auth method/);
	expect(await auth.resolve(input({ GOOGLE_CLOUD_API_KEY: "environment-key" }))).toEqual({
		auth: { apiKey: "environment-key" },
		source: "GOOGLE_CLOUD_API_KEY",
	});
	expect(await auth.resolve(input({}, { type: "api_key", key: "stored-key" }))).toEqual({
		auth: { apiKey: "stored-key" },
		source: "stored credential",
	});
	expect(
		await auth.resolve(input({ GCLOUD_PROJECT: "project", GOOGLE_CLOUD_LOCATION: "location" }, undefined, true)),
	).toEqual({ auth: {}, source: "gcloud application default credentials" });
	for (const exists of [false, true]) expect(await auth.resolve(input({}, undefined, exists))).toBeUndefined();
	const controller = new AbortController(),
		reason = new Error("cancelled lookup");
	await expect(
		auth.resolve({
			signal: controller.signal,
			ctx: {
				env: async () => {
					controller.abort(reason);
					return "key";
				},
				fileExists: async () => true,
			},
		}),
	).rejects.toBe(reason);
});

test("Bedrock resolves each documented credential source and interactive method without contacting AWS", async () => {
	const auth = required(amazonBedrockProvider().auth.apiKey);
	expect((await login(auth, ["bearer-token", "token"])).credential).toEqual({ type: "api_key", key: "token" });
	expect((await login(auth, ["aws-profile", "local"])).credential).toEqual({
		type: "api_key",
		env: { AWS_PROFILE: "local" },
	});
	expect((await login(auth, ["credential-chain", ""])).credential).toEqual({ type: "api_key" });
	await expect(login(auth, ["unknown"])).rejects.toThrow(/Unknown.*auth method/);
	expect(await auth.resolve(input({}, { type: "api_key", key: "token", env: { AWS_REGION: "region" } }))).toEqual({
		auth: { apiKey: "token" },
		env: { AWS_REGION: "region" },
		source: "stored credential",
	});
	expect(await auth.resolve(input({}, { type: "api_key", env: { AWS_PROFILE: "profile" } }))).toEqual({
		auth: {},
		env: { AWS_PROFILE: "profile" },
		source: "stored credential",
	});
	for (const [env, source] of [
		[{ AWS_BEARER_TOKEN_BEDROCK: "token" }, "AWS_BEARER_TOKEN_BEDROCK"],
		[{ AWS_PROFILE: "profile" }, "AWS_PROFILE"],
		[{ AWS_ACCESS_KEY_ID: "access", AWS_SECRET_ACCESS_KEY: "secret" }, "AWS access keys"],
		[{ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/role" }, "ECS task role"],
		[{ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://local/role" }, "ECS task role"],
		[{ AWS_WEB_IDENTITY_TOKEN_FILE: "/token" }, "web identity token"],
	] satisfies [Record<string, string>, string][])
		expect(await auth.resolve(input(env))).toEqual({ auth: {}, source });
	expect(await auth.resolve(input({ AWS_ACCESS_KEY_ID: "incomplete" }))).toBeUndefined();
	const signal = AbortSignal.abort(new Error("cancelled"));
	await expect(auth.resolve({ ...input(), signal })).rejects.toThrow("cancelled");
});

test("the default auth context ignores blank variables and checks local paths without reading file contents", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-auth-context-"));
	try {
		vi.stubEnv("AXI_TEST_AUTH_CONTEXT", "  ");
		const ctx = defaultProviderAuthContext();
		expect(await ctx.env("AXI_TEST_AUTH_CONTEXT")).toBeUndefined();
		vi.stubEnv("AXI_TEST_AUTH_CONTEXT", " value ");
		expect(await ctx.env("AXI_TEST_AUTH_CONTEXT")).toBe(" value ");
		await writeFile(join(directory, "credential"), "not read");
		expect(await ctx.fileExists(join(directory, "credential"))).toBe(true);
		expect(await ctx.fileExists(join(directory, "missing"))).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
