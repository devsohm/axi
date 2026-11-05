import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { lazyApi, lazyStream } from "../src/api/lazy.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { bedrockConverseStreamApi, setBedrockProviderLoader } from "../src/api/bedrock-converse-stream.lazy.ts";
import { loadOpenAICodexOAuth, registerBundledOAuthFlowLoaders } from "../src/auth/oauth/load.ts";
import type { OAuthAuth } from "../src/auth/types.ts";

it("defers an overridden Bedrock loader until a request", async () => {
	const loader = vi.fn(async () => { throw new Error("lazy chunk boundary"); });
	setBedrockProviderLoader(loader);
	const api = bedrockConverseStreamApi();
	expect(loader).not.toHaveBeenCalled();
	const model: Model<"bedrock-converse-stream"> = {
		id: "deferred", name: "Deferred", api: "bedrock-converse-stream", provider: "test", baseUrl: "",
		reasoning: false, input: ["text"], contextWindow: 10, maxTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const result = await api.stream(model, normalizeContext({ messages: [] })).result();
	expect(result.errorMessage).toContain("lazy chunk boundary");
	expect(loader).toHaveBeenCalledTimes(1);
});

it("uses the registered Node OAuth loader without opening a login flow", async () => {
	const auth: OAuthAuth = {
		name: "Bundled test",
		async login() { throw new Error("login must not run"); },
		async refresh() { throw new Error("refresh must not run"); },
		async toAuth() { throw new Error("auth must not run"); },
	};
	const loader = vi.fn(() => auth);
	registerBundledOAuthFlowLoaders({ anthropic: loader, openaiCodex: loader, githubCopilot: loader, openrouter: loader, kimiCoding: loader, meta: loader, xai: loader });
	expect(loader).not.toHaveBeenCalled();
	expect(await loadOpenAICodexOAuth()).toBe(auth);
	expect(loader).toHaveBeenCalledTimes(1);
});

it("resolves a lazy OAuth module from its source location after bundling", async () => {
	const location = new URL("../src/auth/oauth/load.ts", import.meta.url);
	const bundle = await build({
		stdin: { contents: await readFile(location, "utf8"), loader: "ts" },
		format: "esm",
		platform: "node",
		write: false,
		define: { "import.meta.url": JSON.stringify(location.href) },
	});
	const code = bundle.outputFiles[0].text;
	const loaded = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
	const auth = await loaded.loadOpenAICodexOAuth();
	expect(auth.name).toBe("OpenAI (ChatGPT Plus/Pro)");
	expect(typeof auth.login).toBe("function");
});

it("classifies lazy setup failures after cancellation on all stream entry points", async () => {
	const model: Model<"test"> = {
		id: "test",
		name: "Test",
		api: "test",
		provider: "test",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		contextWindow: 100,
		maxTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const api = lazyApi(
		async () => {
			throw new Error("setup failed");
		},
		{ fetchDeferred: true },
	);
	const signal = AbortSignal.abort();
	const context = normalizeContext({ messages: [] });
	const streams = [
		api.stream(model, context, { signal }),
		api.streamSimple(model, context, { signal }),
		api.fetchDeferred!(model, { api: "test", provider: "test", modelId: "test", id: "job" }, { signal }),
	];
	for (const stream of streams) expect((await stream.result()).stopReason).toBe("aborted");
});

it("forwards the final result of a proxy-backed source without relying on its has trap", async () => {
	const model: Model<"faux"> = {
		id: "fixture",
		name: "Fixture",
		provider: "faux",
		api: "faux",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		contextWindow: 100,
		maxTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const response = fauxAssistantMessage([]);
	const source = new Proxy(
		{
			async *[Symbol.asyncIterator]() {},
			async result() {
				return response;
			},
		},
		{ has: () => false },
	);
	expect(await lazyStream(model, async () => source).result()).toBe(response);
});
