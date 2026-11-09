import { describe, expect, it } from "vitest";
import { openrouterImagesApi } from "../src/api/openrouter-images.lazy.ts";
import { generateImages as direct } from "../src/api/openrouter-images.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { getImageModel, getImageModels, getImageProviders } from "../src/image-models.ts";
import { generateImages } from "../src/images.ts";
import { getImagesApiProvider, registerImagesApiProvider } from "../src/images-api-registry.ts";
import { IMAGE_MODELS } from "../src/models.generated.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { ImageModel, ImagesContext } from "../src/types.ts";

const model: ImageModel<"openrouter-images"> = {
	type: "image",
	id: "test-image",
	name: "Test",
	api: "openrouter-images",
	provider: "images",
	baseUrl: "https://provider.invalid/v1",
	input: ["text", "image"],
	output: ["text", "image"],
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 },
};
const context: ImagesContext = {
	input: [
		{ type: "text", text: "draw" },
		{ type: "image", mimeType: "image/png", data: "AA==" },
	],
};
function answer(): Response {
	return Response.json(
		{
			id: "image-1",
			choices: [
				{
					message: {
						content: "caption",
						images: [
							{ image_url: "data:image/png;base64,AA==" },
							{ image_url: { url: "data:image/webp;base64,BB==" } },
							{ image_url: "https://ignored.invalid/image.png" },
							{ image_url: "data:invalid" },
						],
					},
				},
			],
			usage: {
				prompt_tokens: 100,
				completion_tokens: 20,
				prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
			},
		},
		{ headers: { "x-request-id": "request-1" } },
	);
}

describe("Image generation", () => {
	it.each([{}, 3])("reports a non-iterable image collection as a provider error: %j", async (images) => {
		const result = await direct(model, context, {
			apiKey: "test",
			fetch: async () => Response.json({ id: "malformed", choices: [{ message: { content: "caption", images } }] }),
		});
		expect(result).toMatchObject({
			stopReason: "error",
			responseId: "malformed",
			output: [{ type: "text", text: "caption" }],
			errorMessage: expect.stringContaining("not iterable"),
		});
	});
	it("keeps one selected request timeout across image retries", async () => {
		let reads = 0,
			calls = 0;
		const result = await direct(model, context, {
			apiKey: "test",
			maxRetries: 1,
			get timeoutMs() {
				reads++;
				return 1000;
			},
			fetch: async () => {
				if (++calls === 1)
					return Response.json({ error: { message: "Retry" } }, { status: 429, headers: { "retry-after-ms": "0" } });
				return answer();
			},
		});
		expect({ reads, calls, reason: result.stopReason }).toEqual({ reads: 2, calls: 2, reason: "stop" });
	});
	it("retains the indexed image when its catalog property is replaced", () => {
		const image = getImageModels("openrouter")[0];
		if (!image) throw new Error("Expected a catalog image");
		const catalog = IMAGE_MODELS.openrouter;
		const original = Object.getOwnPropertyDescriptor(catalog, image.id);
		if (!original) throw new Error("Expected the image catalog property");
		try {
			Object.defineProperty(catalog, image.id, { ...original, value: { ...image, name: "replacement" } });
			expect(Reflect.apply(getImageModel, undefined, ["openrouter", image.id])).toBe(image);
		} finally {
			Object.defineProperty(catalog, image.id, original);
		}
	});
	it("returns no static model for an inherited object-property name", () => {
		for (const provider of getImageProviders()) {
			for (const id of ["__proto__", "constructor", "toString", "missing-model"])
				expect(Reflect.apply(getImageModel, undefined, [provider, id])).toBeUndefined();
			for (const model of getImageModels(provider))
				expect(Reflect.apply(getImageModel, undefined, [provider, model.id])).toBe(model);
		}
	});
	it("generates through the lazy provider and Models runtime with mixed inputs and outputs", async () => {
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "images",
				name: "Images",
				models: [model],
				images: { "openrouter-images": openrouterImagesApi() },
				auth: { apiKey: envApiKeyAuth("Image key", []) },
			}),
		);
		let body = "",
			endpoint = "";
		const result = await models.generateImages(model, context, {
			apiKey: "test",
			fetch: async (url, init) => {
				endpoint = String(url);
				body = String(init?.body);
				return answer();
			},
		});
		expect(endpoint).toBe("https://provider.invalid/v1/chat/completions");
		expect(JSON.parse(body)).toEqual({
			model: "test-image",
			stream: false,
			modalities: ["image", "text"],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "draw" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
					],
				},
			],
		});
		expect(result).toMatchObject({
			stopReason: "stop",
			responseId: "image-1",
			output: [
				{ type: "text", text: "caption" },
				{ type: "image", mimeType: "image/png", data: "AA==" },
				{ type: "image", mimeType: "image/webp", data: "BB==" },
			],
			usage: { input: 70, output: 20, cacheRead: 20, cacheWrite: 10, totalTokens: 120 },
		});
		expect(result.usage?.cost.total).toBeCloseTo(0.00034, 12);
	});
	it("dispatches the global image API lazily and requests only supported output modalities", async () => {
		let body = "";
		const result = await generateImages({ ...model, output: ["image"] }, context, {
			apiKey: "test",
			fetch: async (_url, init) => {
				body = String(init?.body);
				return answer();
			},
		});
		expect(result.output[1]).toEqual({ type: "image", mimeType: "image/png", data: "AA==" });
		expect(JSON.parse(body).modalities).toEqual(["image"]);
	});
	it("supports registry replacement and enforces the registered API on invocation", async () => {
		const selected = { ...model, api: "custom-images" };
		registerImagesApiProvider({
			api: "custom-images",
			generateImages: async (model) => ({
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 1,
				stopReason: "stop",
				output: [{ type: "text", text: "first" }],
			}),
		});
		expect((await generateImages(selected, context)).output).toEqual([{ type: "text", text: "first" }]);
		registerImagesApiProvider(
			{
				api: "custom-images",
				generateImages: async (model) => ({
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: 2,
					stopReason: "stop",
					output: [{ type: "text", text: "replacement" }],
				}),
			},
			"test-owner",
		);
		expect((await generateImages(selected, context)).output).toEqual([{ type: "text", text: "replacement" }]);
		expect(() => getImagesApiProvider("custom-images")!.generateImages(model, context)).toThrow(
			"Mismatched api: openrouter-images expected custom-images",
		);
		await expect(generateImages({ ...model, api: "missing-images" }, context)).rejects.toThrow(
			"No API provider registered for api: missing-images",
		);
	});
	it("honors payload and header overrides and awaits response observers", async () => {
		let body = "",
			headers = new Headers(),
			observed = "";
		const result = await direct({ ...model, headers: { "x-one": "model", "x-drop": "model" } }, context, {
			apiKey: "test",
			headers: { "x-one": "request", "x-drop": null },
			onPayload: (payload) => ({ ...(payload as object), quality: "high" }),
			onResponse: async (response) => {
				await Promise.resolve();
				observed = response.headers["x-request-id"];
			},
			fetch: async (_url, init) => {
				body = String(init?.body);
				headers = new Headers(init?.headers);
				return answer();
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(observed).toBe("request-1");
		expect(JSON.parse(body).quality).toBe("high");
		expect(headers.get("x-one")).toBe("request");
		expect(headers.has("x-drop")).toBe(false);
	});
	it("returns useful error bodies and cancellation as image results", async () => {
		const error = await direct(model, context, {
			apiKey: "test",
			maxRetries: 0,
			fetch: async () => Response.json({ error: "blocked by gateway" }, { status: 403 }),
		});
		expect(error).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("blocked by gateway"),
			output: [],
		});
		const controller = new AbortController();
		controller.abort();
		const aborted = await direct(model, context, {
			apiKey: "test",
			signal: controller.signal,
			fetch: async () => answer(),
		});
		expect(aborted).toMatchObject({ stopReason: "aborted", errorMessage: expect.stringMatching(/abort/i), output: [] });
		const missing = await direct(model, context);
		expect(missing).toMatchObject({ stopReason: "error", errorMessage: "No API key for provider: images" });
	});
});
