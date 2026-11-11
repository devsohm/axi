import { expect, expectTypeOf, it } from "vitest";
import type { ProviderCompat } from "@axi/ai/providers/compat-schema";
import { buildModelsDevCatalog, parseModelsDev } from "../catalog/sources/models-dev.ts";
import { assembleCatalog } from "../catalog/assemble.ts";
import { streamSimple } from "../src/api/anthropic-messages.ts";
import { getSupportedThinkingLevels, hasApi } from "../src/models.ts";
import { flattenChatModelCatalog, flattenImageModelCatalog } from "../src/model-catalog.ts";
import { CLASSIFIER_MODELS, IMAGE_MODELS, MODELS } from "../src/models.generated.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

it("exports provider compatibility fields with their declared value types", () => {
	expectTypeOf<ProviderCompat["supportsStore"]>().toEqualTypeOf<boolean | undefined>();
	expectTypeOf<ProviderCompat["promptCacheKeyMode"]>().toEqualTypeOf<"auto" | "enabled" | "disabled" | undefined>();
});

it("can generate again after replacing the catalog with a smaller upstream listing", () => {
	const root = mkdtempSync(join(tmpdir(), "axi-regenerate-"));
	const copy = join(root, "ai");
	const source = fileURLToPath(new URL("..", import.meta.url));
	cpSync(source, copy, {
		recursive: true,
		filter: (path) => !path.split(/[\\/]/).some((part) => part === "dist" || part === "node_modules"),
	});
	symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(copy, "node_modules"), "junction");
	const preload = join(root, "fetch.mjs");
	writeFileSync(preload, "globalThis.fetch=async()=>Response.json({});");
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = spawnSync(process.execPath, ["--import", preload, "catalog/generate.ts"], {
				cwd: copy,
				env: { ...process.env, NODE_OPTIONS: "--conditions=source" },
				encoding: "utf8",
				timeout: 15000,
			});
			expect(result.status, result.stderr).toBe(0);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("retains only documented fixed models when the upstream catalog has none", () => {
	const catalog = assembleCatalog(
		buildModelsDevCatalog({}),
		{ chat: [], images: [], classifiers: [] },
		{ chat: [], classifiers: [] },
		[],
	);
	const chats = (provider: string) =>
		catalog[provider].filter((model) => model.type === "chat").map((model) => model.id);
	expect(chats("openai")).toEqual(["gpt-5-chat-latest"]);
	expect(chats("github-copilot")).toEqual(["gpt-6-luna"]);
	expect(chats("azure")).toEqual(["deepseek-v4-pro", "gpt-5-chat-latest"]);
});

it("preserves Azure long-context pricing when deriving a catalog from OpenAI", () => {
	const source = buildModelsDevCatalog({
		openai: {
			models: {
				"gpt-5.4": {
					tool_call: true,
					reasoning: true,
					apis: { responses: { base_url: "https://api.openai.com/v1" } },
					cost: { input: 3, output: 18, cache_read: 0.3 },
					limit: { context: 1000000, output: 128000 },
				},
			},
		},
	});
	const catalog = assembleCatalog(source, { chat: [], images: [], classifiers: [] }, { chat: [], classifiers: [] }, []);
	const azure = catalog.azure.find((model) => model.id === "gpt-5.4");
	expect(azure?.cost.tiers).toEqual([
		{ inputTokensAbove: 272000, input: 6, output: 27, cacheRead: 0.6, cacheWrite: 0 },
	]);
});

it("includes Fable 5.2 and applies its mid-conversation controls and compatible fallback", () => {
	const source = buildModelsDevCatalog({
		anthropic: {
			models: {
				"claude-opus-4-8": { tool_call: true, reasoning: true },
				"claude-opus-5": { tool_call: true, reasoning: true },
			},
		},
	});
	const catalog = assembleCatalog(source, { chat: [], images: [], classifiers: [] }, { chat: [], classifiers: [] }, []);
	const fable = catalog.anthropic.find((model) => model.id === "claude-fable-5-2");
	expect(fable).toMatchObject({
		name: "Claude Fable 5.2",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
		thinkingLevelMap: { off: null },
		compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
	});
	if (!fable || !hasApi(fable, "anthropic-messages")) throw new Error("Fable model missing");
	expect(fable.compat?.allowedFallbackModels?.map((model) => model.model)).toEqual(["claude-opus-5"]);
	expect(MODELS.anthropic["claude-fable-5-2"]).toMatchObject({
		cost: { input: 8 },
		compat: { supportsMidConvoEffort: true },
	});
	expect(MODELS.azure["gpt-6.1-sol"].cost.tiers).toEqual(MODELS.openai["gpt-6.1-sol"].cost.tiers);
});

it("omits Baseten entries without tools and retired entries even when they support tools", () => {
	const result = buildModelsDevCatalog({
		baseten: {
			models: {
				plain: { tool_call: false },
				retired: { tool_call: true, status: "deprecated" },
				active: { tool_call: true },
			},
		},
	});
	expect(result.models.map((model) => model.id)).toEqual(["active"]);
});

it("keeps family thinking choices before applying an xAI fallback", () => {
	const source = buildModelsDevCatalog({
		xai: {
			models: {
				"claude-sonnet-4-6": { tool_call: true, reasoning: true },
				future: { tool_call: true, reasoning: true },
			},
		},
	});
	const catalog = assembleCatalog(source, { chat: [], images: [], classifiers: [] }, { chat: [], classifiers: [] }, []);
	expect(catalog.xai.find((model) => model.id === "claude-sonnet-4-6")).toHaveProperty("thinkingLevelMap", {
		max: "max",
	});
	expect(catalog.xai.find((model) => model.id === "future")).toHaveProperty("thinkingLevelMap", {
		off: null,
		minimal: null,
	});
});

it("recognizes hosted Claude latest aliases on every Messages endpoint", () => {
	const id = "~anthropic/claude-opus-latest";
	const models = { [id]: { tool_call: true, reasoning: true, reasoning_options: [{ type: "toggle" as const }] } };
	const catalog = assembleCatalog(
		buildModelsDevCatalog({ anthropic: { models }, minimax: { models }, "fireworks-ai": { models } }),
		{ chat: [], images: [], classifiers: [] },
		{ chat: [], classifiers: [] },
		[],
	);
	for (const provider of ["anthropic", "minimax", "fireworks"])
		expect(catalog[provider].find((model) => model.id === id)).toHaveProperty("compat.forceAdaptiveThinking", true);
	expect(catalog.fireworks.find((model) => model.id === id)).toHaveProperty("thinkingLevelMap", { off: "none" });
});

it("limits direct Anthropic context overrides to the listed dashed model identities", () => {
	const entry = { tool_call: true, limit: { context: 320000 } };
	const catalog = assembleCatalog(
		buildModelsDevCatalog({ anthropic: { models: { "claude-sonnet-4-6": entry, "claude-sonnet-4.6": entry } } }),
		{ chat: [], images: [], classifiers: [] },
		{ chat: [], classifiers: [] },
		[],
	);
	expect(catalog.anthropic.find((model) => model.id === "claude-sonnet-4-6")).toHaveProperty("contextWindow", 1000000);
	expect(catalog.anthropic.find((model) => model.id === "claude-sonnet-4.6")).toHaveProperty("contextWindow", 320000);
});

it("applies Copilot's minimal effort after common Pro-family restrictions", () => {
	const catalog = assembleCatalog(
		buildModelsDevCatalog({ "github-copilot": { models: { "gpt-5.5-pro": { tool_call: true, reasoning: true } } } }),
		{ chat: [], images: [], classifiers: [] },
		{ chat: [], classifiers: [] },
		[],
	);
	expect(catalog["github-copilot"].find((model) => model.id === "gpt-5.5-pro")).toHaveProperty(
		"thinkingLevelMap.minimal",
		"low",
	);
});

it("keeps the Kimi latest alias output override specific to OpenRouter", () => {
	const entry = {
		id: "~moonshotai/kimi-latest",
		name: "Kimi latest",
		provider: "vercel-ai-gateway",
		api: "anthropic-messages" as const,
		baseUrl: "https://gateway.invalid",
		input: ["text" as const],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 50000,
		maxTokens: 8000,
	};
	const catalog = assembleCatalog(
		buildModelsDevCatalog({}),
		{ chat: [{ ...entry, provider: "openrouter", api: "openai-completions" }], images: [], classifiers: [] },
		{ chat: [entry], classifiers: [] },
		[],
	);
	expect(catalog.openrouter.find((model) => model.id === entry.id)).toHaveProperty("maxTokens", 131072);
	expect(catalog["vercel-ai-gateway"].find((model) => model.id === entry.id)).toHaveProperty("maxTokens", 8000);
});

it.each(["minimax", "minimax-cn"])("builds current and future %s effort models", async (provider) => {
	const entry = { tool_call: true, reasoning: true };
	const source = buildModelsDevCatalog({
		[provider]: {
			models: {
				"MiniMax-M2": entry,
				"MiniMax-M2.1": entry,
				"MiniMax-M2.5": entry,
				"MiniMax-M2.5-highspeed": entry,
				"MiniMax-M2.7": entry,
				"MiniMax-M3.1-Flash": {
					...entry,
					reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
				},
				"future-model": entry,
				"no-tools": { tool_call: false },
			},
		},
	});
	expect(source.models.map((model) => model.id)).toEqual(["MiniMax-M2.7", "MiniMax-M3.1-Flash", "future-model"]);
	const catalog = assembleCatalog(source, { chat: [], images: [], classifiers: [] }, { chat: [], classifiers: [] }, []);
	expect(catalog[provider]?.map((model) => model.id)).toEqual(["future-model", "MiniMax-M2.7", "MiniMax-M3.1-Flash"]);
	const model = catalog[provider]?.find((model) => model.id === "MiniMax-M3.1-Flash");
	if (!model || !hasApi(model, "anthropic-messages")) throw new Error("Missing effort model");
	expect(model.thinkingLevelMap).toEqual({
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});
	expect(model.compat?.forceAdaptiveThinking).toBe(true);
	const payloads: unknown[] = [];
	for (const reasoning of ["low", "max"] as const)
		await streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] }), {
			apiKey: "offline",
			reasoning,
			onPayload(payload) {
				payloads.push(payload);
				throw new Error("Captured before sending");
			},
		}).result();
	expect(payloads).toEqual([
		expect.objectContaining({
			thinking: expect.objectContaining({ type: "adaptive" }),
			output_config: { effort: "low" },
		}),
		expect.objectContaining({
			thinking: expect.objectContaining({ type: "adaptive" }),
			output_config: { effort: "max" },
		}),
	]);
});

it("uses the listed protocol and endpoint without requiring an SDK name", () => {
	const catalog = parseModelsDev({
		opencode: {
			models: {
				fixture: {
					id: "fixture",
					name: "fixture",
					type: "chat",
					modalities: { input: ["text"], output: ["text"] },
					capabilities: { tools: { supported: true }, reasoning: { supported: false } },
					api: { "chat-completions": { base_url: "https://example.test/openai/v1" } },
				},
			},
		},
	});
	expect(buildModelsDevCatalog(catalog).models).toEqual([
		{
			id: "fixture",
			name: "fixture",
			provider: "opencode",
			api: "openai-completions",
			baseUrl: "https://example.test/openai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
			compat: { maxTokensField: "max_tokens" },
		},
	]);
});

it("uses the model's declared identity when its listing key differs", () => {
	const source = parseModelsDev({
		cerebras: {
			models: {
				listing: {
					id: "served-id",
					name: "Served model",
					type: "chat",
					modalities: { input: ["text"], output: ["text"] },
					capabilities: { tools: { supported: true }, reasoning: { supported: false } },
					api: { "chat-completions": { base_url: "https://example.test/v1" } },
				},
			},
		},
	});
	expect(buildModelsDevCatalog(source).models.map((model) => [model.id, model.name])).toEqual([
		["served-id", "Served model"],
	]);
});

it.each([
	[undefined, "Vendor/Model_A"],
	["vendor/model.a", "Vendor/Model_A"],
	["Descriptive name", "Descriptive name"],
])("resolves the live NVIDIA identity while preserving the display name %s", (name, expectedName) => {
	const catalog = buildModelsDevCatalog(
		{
			nvidia: {
				models: {
					"vendor/model.a": { name, tool_call: true, modalities: { input: ["text"], output: ["text"] } },
				},
			},
		},
		["vendor/model.a", "Vendor/Model_A"],
	);
	expect(catalog.models.map((model) => [model.id, model.name])).toEqual([["Vendor/Model_A", expectedName]]);
});

it("keeps separate typed model identities across all included providers", () => {
	expect(Object.keys(MODELS)).toHaveLength(42);
	for (const table of [MODELS, IMAGE_MODELS, CLASSIFIER_MODELS]) {
		for (const [provider, models] of Object.entries(table))
			for (const [id, model] of Object.entries(models)) expect([model.provider, model.id]).toEqual([provider, id]);
	}
	expectTypeOf(MODELS.xai["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(MODELS.xai["grok-4.5"].provider).toEqualTypeOf<"xai">();
	expectTypeOf(MODELS.xai["grok-4.5"].id).toEqualTypeOf<"grok-4.5">();
});
it.each([
	["grok-4.3", ["off", "low", "medium", "high", "xhigh"]],
	["grok-4.5", ["low", "medium", "high", "xhigh"]],
] as const)("exposes the supported reasoning choices for %s", (id, levels) => {
	expect(getSupportedThinkingLevels(MODELS.xai[id])).toEqual(levels);
});
it("uses the last matching entry without cloning or splitting colon-containing IDs", () => {
	const first = { type: "chat", id: "account:model", value: 1 };
	const last = { type: "chat", id: "account:model", value: 2 };
	const image = { type: "image", id: "account:model" };
	const groups = {
		a: { "chat:account:model": first, "image:account:model": image },
		b: { "chat:account:model": last },
	};
	expect(flattenChatModelCatalog("test", groups)["account:model"]).toBe(last);
	expect(flattenImageModelCatalog("test", groups)["account:model"]).toBe(image);
});
it("stores prototype-shaped IDs as ordinary enumerable model entries", () => {
	const model = { type: "chat", id: "__proto__" };
	const result = flattenChatModelCatalog("test", { custom: { "chat:__proto__": model } });
	expect(Object.keys(result)).toEqual(["__proto__"]);
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	expect(result.__proto__).toBe(model);
});
