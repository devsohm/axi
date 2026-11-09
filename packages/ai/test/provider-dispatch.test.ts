import { expect, test } from "vitest";
import {
	clampThinkingLevel,
	createModels,
	createProvider,
	modelsAreEqual,
	type RefreshModelsContext,
} from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { fauxProvider } from "../src/providers/faux.ts";
import type { ClassifierModel, ImageModel, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const chat: Model<"faux" | "missing"> = {
	id: "shared",
	name: "Baseline",
	provider: "fixture",
	api: "faux",
	baseUrl: "https://fixture.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost,
};
const image: ImageModel<"paint"> = {
	type: "image",
	id: "shared",
	name: "Painter",
	provider: "fixture",
	api: "paint",
	baseUrl: "https://fixture.invalid",
	input: ["text"],
	output: ["image"],
	cost,
};
const classifier: ClassifierModel<"judge"> = {
	type: "classifier",
	id: "shared",
	name: "Judge",
	provider: "fixture",
	api: "judge",
	baseUrl: "https://fixture.invalid",
	input: ["text"],
	contextWindow: 1000,
	cost,
};
const auth = { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture-key" } }) } };
const deferred = { provider: "fixture", modelId: "shared", api: "faux", id: "request" };

test("catalog refresh restores only its own cached models and replaces entries by type and ID", async () => {
	const store = new InMemoryModelsStore();
	await store.write("fixture", {
		models: [{ ...chat, name: "Cached" }, image, { ...chat, id: "foreign", provider: "another" }],
	});
	const phases: boolean[] = [];
	const scripted = fauxProvider();
	const provider = createProvider({
		id: "fixture",
		models: [chat, classifier],
		auth,
		api: scripted.provider,
		async fetchModels(context) {
			phases.push(context.allowNetwork);
			return [
				{ ...chat, name: "Fresh" },
				{ ...image, id: "new-image" },
			];
		},
	});
	const models = createModels({ modelsStore: store });
	models.setProvider(provider);
	expect((await models.refresh({ allowNetwork: false })).errors.size).toBe(0);
	expect(models.getAllModels("fixture").map((model) => [model.type ?? "chat", model.id, model.name])).toEqual([
		["chat", "shared", "Cached"],
		["classifier", "shared", "Judge"],
		["image", "shared", "Painter"],
	]);
	expect(phases).toEqual([]);
	expect((await models.refresh({ allowNetwork: true })).errors.size).toBe(0);
	expect(models.getAllModels("fixture").map((model) => [model.type ?? "chat", model.id, model.name])).toEqual([
		["chat", "shared", "Fresh"],
		["classifier", "shared", "Judge"],
		["image", "new-image", "Painter"],
	]);
	expect(phases).toEqual([true]);
	expect((await store.read("fixture"))?.models.map((model) => model.id)).toEqual(["shared", "new-image"]);
});

test("a refused cache publication prevents both adoption and network fetching", async () => {
	const scripted = fauxProvider();
	let fetched = 0;
	const provider = createProvider({
		id: "fixture",
		models: [chat],
		auth,
		api: scripted.provider,
		async fetchModels() {
			fetched++;
			return [{ ...chat, name: "Fresh" }];
		},
	});
	const publications: unknown[] = [];
	const context: RefreshModelsContext = {
		stored: { models: [{ ...chat, name: "Cached" }] },
		allowNetwork: true,
		signal: new AbortController().signal,
		async publish(value) {
			publications.push(value);
			return false;
		},
	};
	await provider.refreshModels?.(context);
	expect(fetched).toBe(0);
	expect(publications).toHaveLength(1);
	expect(provider.getModels()[0]?.name).toBe("Baseline");
});

test("cancellation during a catalog fetch leaves the previous catalog and cache unchanged", async () => {
	const controller = new AbortController(),
		scripted = fauxProvider();
	let published = 0;
	const provider = createProvider({
		id: "fixture",
		models: [chat],
		auth,
		api: scripted.provider,
		async fetchModels() {
			controller.abort();
			return [{ ...chat, name: "Fresh" }];
		},
	});
	await provider.refreshModels?.({
		allowNetwork: true,
		signal: controller.signal,
		async publish(value) {
			published++;
			value.update?.();
			return true;
		},
	});
	expect(published).toBe(0);
	expect(provider.getModels()[0]?.name).toBe("Baseline");
});

test("an unimplemented API fails through both stream entry points and optional deferred capabilities", async () => {
	const scripted = fauxProvider();
	const provider = createProvider<"faux" | "missing">({
		id: "fixture",
		models: [chat],
		auth,
		api: {
			faux: {
				stream: scripted.provider.stream,
				streamSimple: scripted.provider.streamSimple,
				fetchDeferred(model) {
					return scripted.provider.stream(model, normalizeContext({ messages: [] }));
				},
				async cancelDeferred() {},
			},
		},
	});
	const missing: Model<"missing"> = { ...chat, api: "missing" };
	for (const stream of [
		provider.stream(missing, normalizeContext({ messages: [] })),
		provider.streamSimple(missing, normalizeContext({ messages: [] })),
		provider.fetchDeferred!(missing, { ...deferred, api: "missing" }),
	]) {
		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining('"missing"'),
		});
	}
	await expect(provider.cancelDeferred!(missing, { ...deferred, api: "missing" })).rejects.toMatchObject({
		code: "provider",
	});
});

test("unsupported model capabilities fail without making a provider request", async () => {
	const scripted = fauxProvider(),
		models = createModels();
	models.setProvider(
		createProvider({
			id: "fixture",
			models: [chat, image, classifier],
			auth,
			api: { stream: scripted.provider.stream, streamSimple: scripted.provider.streamSimple },
		}),
	);
	expect(await models.fetchDeferred(chat, deferred)).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("does not support deferred"),
	});
	await expect(models.cancelDeferred(chat, deferred)).rejects.toMatchObject({ code: "provider" });
	expect(await models.generateImages(image, { input: [{ type: "text", text: "draw" }] })).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("does not support image generation"),
	});
	expect(await models.classify(classifier, { state: {}, questions: {} })).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("does not support classification"),
	});
});

test("model identity includes its operation type and provider rather than mutable labels", () => {
	expect(modelsAreEqual(chat, { ...chat, name: "Renamed" })).toBe(true);
	for (const candidate of [
		undefined,
		null,
		image,
		classifier,
		{ ...chat, id: "other" },
		{ ...chat, provider: "another" },
	]) {
		expect(modelsAreEqual(chat, candidate)).toBe(false);
		expect(modelsAreEqual(candidate, chat)).toBe(false);
	}
});

test("thinking selection moves to a supported level or off when the model supports none", () => {
	const sparse = {
		...chat,
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: "max" },
	};
	expect(clampThinkingLevel(sparse, "low")).toBe("medium");
	expect(clampThinkingLevel(sparse, "high")).toBe("max");
	expect(clampThinkingLevel({ ...sparse, thinkingLevelMap: { ...sparse.thinkingLevelMap, max: null } }, "max")).toBe(
		"medium",
	);
	expect(
		clampThinkingLevel(
			{
				...chat,
				thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
			},
			"high",
		),
	).toBe("off");
});
