import { expect, it } from "vitest";
import { resolveCloudflareModel } from "../src/providers/cloudflare-stream.ts";
import { cloudflareWorkersAIProvider } from "../src/providers/cloudflare-workers-ai.ts";
import { createModels } from "../src/models.ts";

it("leaves the model untouched when no environment is supplied", () => {
	const model = {
		get baseUrl(): string {
			throw new Error("Endpoint must not be evaluated");
		},
	};
	expect(resolveCloudflareModel(model, undefined)).toBe(model);
});

it("reads each endpoint substitution once", () => {
	let reads = 0;
	const resolved = resolveCloudflareModel(
		{ baseUrl: "https://example.test/accounts/{CLOUDFLARE_ACCOUNT_ID}/models" },
		{
			get CLOUDFLARE_ACCOUNT_ID() {
				return ++reads === 1 ? "selected-account" : "other-account";
			},
		},
	);
	expect(resolved.baseUrl).toBe("https://example.test/accounts/selected-account/models");
	expect(reads).toBe(1);
});

it.each(["stream", "streamSimple"] as const)(
	"routes registered Workers AI %s calls to the selected account",
	async (mode) => {
		const models = createModels();
		models.setProvider(cloudflareWorkersAIProvider());
		const model = models.getModels()[0];
		if (!model) throw new Error("No chat model");
		const urls: string[] = [];
		const result = await models[mode](
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{
				apiKey: "offline",
				env: { CLOUDFLARE_ACCOUNT_ID: "selected-account" },
				fetch: async (input) => {
					urls.push(String(input));
					return new Response(
						'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
						{
							headers: { "content-type": "text/event-stream" },
						},
					);
				},
			},
		).result();
		expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "ready" }] });
		expect(urls).toEqual(["https://api.cloudflare.com/client/v4/accounts/selected-account/ai/v1/chat/completions"]);
		expect(model.baseUrl).toContain("{CLOUDFLARE_ACCOUNT_ID}");
	},
);

it("routes the registered Workers AI classifier through the selected account without mutating its catalog", async () => {
	const models = createModels();
	models.setProvider(cloudflareWorkersAIProvider());
	const model = models.getModelsOfType("classifier")[0];
	if (!model) throw new Error("No classifier model");
	const urls: string[] = [];
	const result = await models.classify(
		model,
		{
			state: { value: "approved" },
			questions: { ok: { type: "bool", instructions: "Approved?", criteria: { true: "approved", false: "rejected" } } },
		},
		{
			apiKey: "offline",
			env: { CLOUDFLARE_ACCOUNT_ID: "classifier-account" },
			fetch: async (input) => {
				urls.push(String(input));
				return Response.json({ result: { answers: { ok: { type: "noul", noul: 0.9 } } } });
			},
		},
	);
	expect(result).toMatchObject({ stopReason: "stop", answers: { ok: { type: "bool", probability: 0.9 } } });
	expect(urls).toEqual(["https://api.cloudflare.com/client/v4/accounts/classifier-account/ai/run"]);
	expect(model.baseUrl).toContain("{CLOUDFLARE_ACCOUNT_ID}");
});
