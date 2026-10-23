import { expect, expectTypeOf, it } from "vitest";
import { buildModelsDevCatalog, parseModelsDev } from "../scripts/models-dev-catalog.ts";
import { assembleCatalog } from "../scripts/catalog-generation.ts";
import { streamSimple } from "../src/api/anthropic-messages.ts";
import { getSupportedThinkingLevels, hasApi } from "../src/models.ts";
import { flattenChatModelCatalog, flattenImageModelCatalog } from "../src/model-catalog.ts";
import { CLASSIFIER_MODELS, IMAGE_MODELS, MODELS } from "../src/models.generated.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

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

it("accepts an unspecified SDK in OpenCode catalog entries", () => {
	const catalog = parseModelsDev({
		opencode: { models: { fixture: { tool_call: true, provider: { npm: null } } } },
	});
	expect(buildModelsDevCatalog(catalog).models).toEqual([
		{
			id: "fixture",
			name: "fixture",
			provider: "opencode",
			api: "openai-completions",
			baseUrl: "https://opencode.ai/inference/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
			compat: { maxTokensField: "max_tokens" },
		},
	]);
});

it("uses the last live NVIDIA model ID for a normalized catalog identity", () => {
	const catalog = buildModelsDevCatalog(
		{
			nvidia: {
				models: {
					"vendor/model.a": { tool_call: true, modalities: { input: ["text"], output: ["text"] } },
				},
			},
		},
		["vendor/model.a", "Vendor/Model_A"],
	);
	expect(catalog.models.map((model) => model.id)).toEqual(["Vendor/Model_A"]);
});

it("keeps separate typed model identities across all included providers", () => {
	expect(Object.keys(MODELS)).toHaveLength(41);
	let count = 0;
	for (const table of [MODELS, IMAGE_MODELS, CLASSIFIER_MODELS]) {
		for (const models of Object.values(table)) count += Object.keys(models).length;
	}
	expect(count).toBe(1678);
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
