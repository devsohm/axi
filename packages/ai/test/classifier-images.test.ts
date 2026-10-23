import { expect, it } from "vitest";
import { classify as typesafe } from "../src/api/typesafe-system-one.ts";
import { classify as cloudflare } from "../src/api/cloudflare-workers-ai-system-one.ts";
import type { ClassifierContext, ClassifierModel } from "../src/types.ts";

const model: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	api: "typesafe-system-one",
	provider: "typesafe",
	id: "image-check",
	name: "Image check",
	baseUrl: "https://classifier.invalid/v1",
	input: ["text", "image"],
	contextWindow: 32000,
	cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: ClassifierContext = {
	state: { task: "inspect" },
	questions: {},
	images: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
};

it("sends referenced assets and only opts into image requests", async () => {
	const requests: { body: unknown; optIn: string | null }[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		requests.push({
			body: JSON.parse(String(init?.body)),
			optIn: new Headers(init?.headers).get("typesafe-danger-zone-images"),
		});
		return Response.json({ answers: {} });
	};
	expect((await typesafe(model, context, { apiKey: "test", fetch })).stopReason).toBe("stop");
	expect((await typesafe(model, { ...context, images: [] }, { apiKey: "test", fetch })).stopReason).toBe("stop");
	expect(requests).toEqual([
		{
			body: {
				model: "image-check",
				state: ["<image-1>", { task: "inspect" }],
				questions: {},
				assets: { "<image-1>": { type: "image", format: "png", data_base64: "cG5n" } },
			},
			optIn: "true",
		},
		{ body: { model: "image-check", state: { task: "inspect" }, questions: {} }, optIn: null },
	]);
});

it.each([
	{ provider: "openrouter", baseUrl: "https://proxy.invalid" },
	{ baseUrl: "https://us.openrouter.ai/api/v1" },
	{ compat: { imageInput: "state-image-urls" as const, sendImageOptInHeader: false } },
])("routes image parts with provider, endpoint or explicit compatibility", async (override) => {
	let body: unknown,
		optIn: string | null = null;
	const result = await typesafe({ ...model, ...override }, context, {
		apiKey: "test",
		fetch: async (_url, init) => {
			body = JSON.parse(String(init?.body));
			optIn = new Headers(init?.headers).get("typesafe-danger-zone-images");
			return Response.json({ answers: {} });
		},
	});
	expect(result.stopReason).toBe("stop");
	expect(body).toEqual({
		model: "image-check",
		state: [{ type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } }, { task: "inspect" }],
		questions: {},
	});
	expect(optIn).toBeNull();
});

it("uses Clef data URLs and rejects the fifth image without sending", async () => {
	const clef: ClassifierModel<"cloudflare-workers-ai-system-one"> = {
		...model,
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		id: "@cf/cloudflare/clef",
	};
	const requests: unknown[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return Response.json({ success: true, result: { answers: {} } });
	};
	expect((await cloudflare(clef, context, { apiKey: "test", fetch })).stopReason).toBe("stop");
	const rejected = await cloudflare(
		clef,
		{ ...context, images: Array.from({ length: 5 }, () => ({ type: "image", mimeType: "image/png", data: "cG5n" })) },
		{ apiKey: "test", fetch },
	);
	expect(rejected.errorMessage).toBe("Cloudflare Workers AI accepts at most 4 images for @cf/cloudflare/clef, got 5");
	expect(requests).toEqual([
		{
			model: "@cf/cloudflare/clef",
			input: { state: { task: "inspect" }, questions: {}, images: ["data:image/png;base64,cG5n"] },
		},
	]);
});

it("rejects unsupported asset formats before calling fetch", async () => {
	let calls = 0;
	const result = await typesafe(
		model,
		{ ...context, images: [{ type: "image", mimeType: "image/webp", data: "d2VicA==" }] },
		{
			apiKey: "test",
			fetch: async () => {
				calls++;
				return Response.json({ answers: {} });
			},
		},
	);
	expect(result.errorMessage).toBe("System One API accepts PNG and JPEG images for image-check, got image/webp");
	expect(calls).toBe(0);
});
