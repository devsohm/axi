import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

beforeEach(() => {
	for (const name of [
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_OAUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"COPILOT_GITHUB_TOKEN",
		"GOOGLE_CLOUD_API_KEY",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"AWS_PROFILE",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
	])
		vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());

test("environment discovery reports bearer credentials without treating them as an API key", () => {
	const env = { ANTHROPIC_AUTH_TOKEN: "bearer", ANTHROPIC_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "key" };
	expect(findEnvKeys("anthropic", env)).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
	expect(getEnvApiKey("anthropic", env)).toBe("oauth");
	expect(getEnvApiKey("anthropic", { ANTHROPIC_AUTH_TOKEN: "bearer", ANTHROPIC_API_KEY: "key" })).toBe("key");
	expect(getEnvApiKey("anthropic", { ANTHROPIC_AUTH_TOKEN: "bearer" })).toBeUndefined();
});

test("Copilot ignores general GitHub tokens and falls back from a blank override to its process variable", () => {
	vi.stubEnv("GH_TOKEN", "general");
	vi.stubEnv("GITHUB_TOKEN", "general");
	expect(findEnvKeys("github-copilot")).toBeUndefined();
	expect(getEnvApiKey("github-copilot")).toBeUndefined();
	vi.stubEnv("COPILOT_GITHUB_TOKEN", "ambient-copilot");
	expect(getEnvApiKey("github-copilot", { COPILOT_GITHUB_TOKEN: "" })).toBe("ambient-copilot");
	expect(getEnvApiKey("github-copilot", { COPILOT_GITHUB_TOKEN: "override" })).toBe("override");
	expect(findEnvKeys("unregistered")).toBeUndefined();
});

test("provider aliases share only their documented credential variables", () => {
	for (const [providers, key] of [
		[["qwen-token-plan", "qwen-token-plan-individual"], "QWEN_TOKEN_PLAN_API_KEY"],
		[["qwen-token-plan-cn", "qwen-token-plan-individual-cn"], "QWEN_TOKEN_PLAN_CN_API_KEY"],
		[["moonshotai", "moonshotai-cn"], "MOONSHOT_API_KEY"],
		[["opencode", "opencode-go"], "OPENCODE_API_KEY"],
		[["cloudflare-workers-ai", "cloudflare-ai-gateway"], "CLOUDFLARE_API_KEY"],
	] as const) {
		for (const provider of providers) {
			expect(findEnvKeys(provider, { [key]: "fixture" })).toEqual([key]);
			expect(getEnvApiKey(provider, { [key]: "fixture" })).toBe("fixture");
		}
	}
});

const bedrockSources: Record<string, string>[] = [
	{ AWS_PROFILE: "profile" },
	{ AWS_ACCESS_KEY_ID: "access", AWS_SECRET_ACCESS_KEY: "secret" },
	{ AWS_BEARER_TOKEN_BEDROCK: "bearer" },
	{ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/role" },
	{ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1/role" },
	{ AWS_WEB_IDENTITY_TOKEN_FILE: "/token" },
];
test.each(bedrockSources)("Bedrock ambient source %j signals authentication without exposing a key", (env) => {
	expect(getEnvApiKey("amazon-bedrock", env)).toBe("<authenticated>");
	expect(findEnvKeys("amazon-bedrock", env)).toBeUndefined();
});

test("an incomplete Bedrock key pair does not report authentication", () => {
	const incomplete: Record<string, string>[] = [{}, { AWS_ACCESS_KEY_ID: "access" }, { AWS_SECRET_ACCESS_KEY: "secret" }];
	for (const env of incomplete)
		expect(getEnvApiKey("amazon-bedrock", env)).toBeUndefined();
});

test("Vertex needs an existing credential path, project and location unless an API key is supplied", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-env-credentials-")),
		path = join(directory, "credential.json");
	try {
		await writeFile(path, "{}");
		const env = {
			GOOGLE_APPLICATION_CREDENTIALS: path,
			GOOGLE_CLOUD_PROJECT: "project",
			GOOGLE_CLOUD_LOCATION: "location",
		};
		await vi.waitFor(() => expect(getEnvApiKey("google-vertex", env)).toBe("<authenticated>"));
		expect(findEnvKeys("google-vertex", env)).toBeUndefined();
		expect(getEnvApiKey("google-vertex", { ...env, GOOGLE_CLOUD_PROJECT: "" })).toBeUndefined();
		expect(getEnvApiKey("google-vertex", { ...env, GOOGLE_CLOUD_LOCATION: "" })).toBeUndefined();
		expect(getEnvApiKey("google-vertex", { ...env, GOOGLE_CLOUD_PROJECT: "", GCLOUD_PROJECT: "legacy-project" })).toBe(
			"<authenticated>",
		);
		expect(getEnvApiKey("google-vertex", { GOOGLE_CLOUD_API_KEY: "key" })).toBe("key");
		await rm(path);
		expect(getEnvApiKey("google-vertex", env)).toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("ambient ADC lookup is cached while an explicit credential path is checked on each call", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-adc-cache-")),
		path = join(directory, "credential.json");
	try {
		await writeFile(path, "{}");
		vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", path);
		vi.resetModules();
		const { getEnvApiKey: readKey } = await import("../src/env-api-keys.ts");
		const env = { GOOGLE_CLOUD_PROJECT: "project", GOOGLE_CLOUD_LOCATION: "location" };
		await vi.waitFor(() => expect(readKey("google-vertex", env)).toBe("<authenticated>"));
		await rm(path);
		expect(readKey("google-vertex", env)).toBe("<authenticated>");
		expect(readKey("google-vertex", { ...env, GOOGLE_APPLICATION_CREDENTIALS: path })).toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
