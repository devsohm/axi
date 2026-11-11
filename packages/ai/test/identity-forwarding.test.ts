import { expect, test } from "vitest";
import { createModels, type Provider } from "../src/models.ts";
import type { AssistantMessage, ClassifierModel, ImageModel, Model } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { withClientIdentity, type ClientIdentity } from "../src/utils/identity.ts";

const chat: Model<"fixture"> = {
	api: "fixture",
	id: "chat",
	name: "Chat",
	provider: "fixture",
	baseUrl: "https://fixture.invalid",
	input: ["text"],
	reasoning: false,
	maxTokens: 100,
	contextWindow: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const image: ImageModel<"fixture"> = {
	type: "image",
	api: "fixture",
	id: "image",
	name: "Image",
	provider: "fixture",
	baseUrl: chat.baseUrl,
	input: ["text"],
	output: ["image"],
	cost: chat.cost,
};
const classifier: ClassifierModel<"fixture"> = {
	type: "classifier",
	api: "fixture",
	id: "classifier",
	name: "Classifier",
	provider: "fixture",
	baseUrl: chat.baseUrl,
	input: ["text"],
	contextWindow: 1000,
	cost: chat.cost,
};
const identity: ClientIdentity = {
	userAgent: "short",
	version: "client-1",
	attribution: { name: "client", url: "https://client.invalid" },
};
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixture() {
	const observed: Array<{ operation: string; identity?: ClientIdentity }> = [];
	const record = (operation: string, options?: { identity?: ClientIdentity }) => {
		observed.push({ operation, identity: options?.identity });
	};
	const answer: AssistantMessage = {
		role: "assistant",
		api: chat.api,
		provider: chat.provider,
		model: chat.id,
		content: [{ type: "text", text: "answer" }],
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
	const emit = (operation: string, options?: { identity?: ClientIdentity }) => {
		record(operation, options);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: answer });
		stream.end();
		return stream;
	};
	let refreshes = 0;
	const provider: Provider = {
		id: "fixture",
		name: "Fixture",
		auth: {
			apiKey: {
				name: "Fixture key",
				resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "secret", message: "Key" }),
				}),
			},
		},
		getModels: () => [chat],
		getAllModels: () => [chat, image, classifier],
		refreshModels: async () => {
			refreshes++;
		},
		stream: (_model, _context, options) => emit("stream", options),
		streamSimple: (_model, _context, options) => emit("simple", options),
		fetchDeferred: (_model, _handle, options) => emit("deferred", options),
		cancelDeferred: async (_model, _handle, options) => {
			record("cancel", options);
		},
		generateImages: async (_model, _context, options) => {
			record("image", options);
			return {
				api: image.api,
				provider: image.provider,
				model: image.id,
				output: [{ type: "image", data: "AA==", mimeType: "image/png" }],
				stopReason: "stop",
				timestamp: 0,
			};
		},
		classify: async (_model, _context, options) => {
			record("classifier", options);
			return {
				api: classifier.api,
				provider: classifier.provider,
				model: classifier.id,
				answers: { accepted: { type: "bool", probability: 1 } },
				stopReason: "stop",
				timestamp: 0,
			};
		},
	};
	const models = createModels();
	models.setProvider(provider);
	return {
		models,
		provider,
		observed,
		answer,
		wrapped: withClientIdentity(models, identity),
		refreshes: () => refreshes,
	};
}

test("identity wrapping preserves catalogs, typed selection and live provider mutations", () => {
	const { models, wrapped, provider } = fixture();
	expect(wrapped.getProviders()).toEqual([provider]);
	expect(wrapped.getProvider("fixture")).toBe(provider);
	expect(wrapped.getModels("fixture")).toEqual([chat]);
	expect(wrapped.getModel("fixture", "chat")).toBe(chat);
	expect(wrapped.getModelsOfType("image", "fixture")).toEqual([image]);
	expect(wrapped.getModelOfType("classifier", "fixture", "classifier")).toBe(classifier);
	expect(wrapped.getAllModels("fixture")).toEqual([chat, image, classifier]);
	wrapped.deleteProvider("fixture");
	expect(models.getProviders()).toEqual([]);
	wrapped.setProvider(provider);
	expect(models.getProvider("fixture")).toBe(provider);
	wrapped.clearProviders();
	expect(models.getAllModels()).toEqual([]);
});

test("wrapped authentication, availability and refresh use the same credential store", async () => {
	const { wrapped, refreshes } = fixture();
	expect(await wrapped.getAvailable("fixture")).toEqual([]);
	expect(await wrapped.login("fixture", "api_key", { prompt: async () => "local-key", notify() {} })).toEqual({
		type: "api_key",
		key: "local-key",
	});
	expect(await wrapped.checkAuth("fixture")).toMatchObject({ type: "api_key" });
	expect(await wrapped.getAuth(chat)).toMatchObject({ auth: { apiKey: "local-key" } });
	expect(await wrapped.getAuth("fixture")).toMatchObject({ auth: { apiKey: "local-key" } });
	expect(await wrapped.getAvailable("fixture")).toEqual([chat]);
	expect(await wrapped.getAvailableOfType("image", "fixture")).toEqual([image]);
	expect(await wrapped.getAllAvailable("fixture")).toEqual([chat, image, classifier]);
	expect(await wrapped.refresh({ allowNetwork: false })).toMatchObject({ aborted: false, errors: new Map() });
	expect(refreshes()).toBe(1);
	await wrapped.logout("fixture");
	expect(await wrapped.getAllAvailable()).toEqual([]);
});

test.each(["stream", "complete", "streamSimple", "completeSimple"] as const)(
	"%s merges request identity without mutating either input",
	async (method) => {
		const { wrapped, observed } = fixture();
		for (const override of [undefined, { attribution: null, version: "request-2" }]) {
			const options = { apiKey: "local-key", ...(override ? { identity: override } : {}) };
			const result = await (method === "stream"
				? wrapped.stream(chat, { messages: [] }, options).result()
				: method === "streamSimple"
					? wrapped.streamSimple(chat, { messages: [] }, options).result()
					: wrapped[method](chat, { messages: [] }, options));
			expect(result.content).toEqual([{ type: "text", text: "answer" }]);
			expect(observed.at(-1)?.identity).toEqual(override ? { ...identity, ...override } : identity);
			expect(options).toEqual({ apiKey: "local-key", ...(override ? { identity: override } : {}) });
		}
		expect(identity.attribution?.name).toBe("client");
	},
);

test("deferred reads and cancellation carry client identity to their provider", async () => {
	const { wrapped, observed } = fixture();
	const handle = { api: chat.api, provider: chat.provider, modelId: chat.id, id: "pending" };
	const options = { apiKey: "local-key", identity: { version: "deferred-2" } };
	expect((await wrapped.streamDeferred(chat, handle, options).result()).content).toEqual([
		{ type: "text", text: "answer" },
	]);
	expect((await wrapped.fetchDeferred(chat, handle, options)).stopReason).toBe("stop");
	await wrapped.cancelDeferred(chat, handle, options);
	expect(observed).toEqual(
		["deferred", "deferred", "cancel"].map((operation) => ({
			operation,
			identity: { ...identity, version: "deferred-2" },
		})),
	);
});

test("image and classifier requests honor per-request identity opt-outs", async () => {
	const { wrapped, observed } = fixture();
	const options = { apiKey: "local-key", identity: { attribution: null } };
	expect((await wrapped.generateImages(image, { input: [{ type: "text", text: "draw" }] }, options)).output).toEqual([
		{ type: "image", data: "AA==", mimeType: "image/png" },
	]);
	expect(
		(
			await wrapped.classify(
				classifier,
				{
					state: {},
					questions: { accepted: { type: "bool", instructions: "Accept?", criteria: { true: "Yes", false: "No" } } },
				},
				options,
			)
		).answers,
	).toEqual({ accepted: { type: "bool", probability: 1 } });
	expect(observed).toEqual(
		["image", "classifier"].map((operation) => ({ operation, identity: { ...identity, attribution: null } })),
	);
});

test("a read-only model facade stays read-only when wrapped", () => {
	const { models } = fixture();
	const {
		setProvider: _set,
		deleteProvider: _delete,
		clearProviders: _clear,
		...readonly
	} = withClientIdentity(models, identity);
	const wrapped = withClientIdentity(readonly, identity);
	expect("setProvider" in wrapped).toBe(false);
	expect(wrapped.getModel("fixture", "chat")).toBe(chat);
});

test("identity wrapping defers mutable method getters until their methods are called", () => {
	const { models, provider } = fixture();
	const reads: string[] = [];
	const methods = {
		setProvider: models.setProvider.bind(models),
		deleteProvider: models.deleteProvider.bind(models),
		clearProviders: models.clearProviders.bind(models),
	};
	for (const name of Object.keys(methods) as (keyof typeof methods)[])
		Object.defineProperty(models, name, {
			get() {
				reads.push(name);
				return methods[name];
			},
		});
	const wrapped = withClientIdentity(models, identity);
	expect(reads).toEqual([]);
	wrapped.deleteProvider("fixture");
	expect(models.getProviders()).toEqual([]);
	wrapped.setProvider(provider);
	expect(models.getModel("fixture", "chat")).toBe(chat);
	wrapped.clearProviders();
	expect(models.getProviders()).toEqual([]);
	expect(reads).toEqual(["deleteProvider", "setProvider", "clearProviders"]);
});
