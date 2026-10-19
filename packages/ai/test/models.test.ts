import { expect, it } from "vitest";
import {
	createModels,
	createProvider,
	type CreateProviderOptions,
	type ModelsApiStreamOptions,
} from "../src/models.ts";
import type { Model } from "../src/types.ts";

const model: Model<"test"> = {
	api: "test",
	id: "initial",
	name: "Test",
	provider: "test",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	contextWindow: 100,
	maxTokens: 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const input = {
	id: "test",
	models: [model],
	auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "ambient" } }) } },
	api: {
		stream(_model, _context, options) {
			throw new Error(options?.apiKey);
		},
		streamSimple() {
			throw new Error("unused");
		},
	},
} satisfies CreateProviderOptions<"test">;

it("observes provider removal and addition while a catalog is being listed", () => {
	for (const method of ["getModels", "getAllModels"] as const) {
		const models = createModels();
		const firstModel = { ...model, id: "first", provider: "first" };
		const first = createProvider({ ...input, id: "first", models: [firstModel] });
		const added = createProvider({ ...input, id: "added", models: [{ ...model, id: "added", provider: "added" }] });
		const list = () => {
			models.deleteProvider("removed");
			models.setProvider(added);
			return [firstModel];
		};
		first.getModels = list;
		first.getAllModels = list;
		models.setProvider(first);
		models.setProvider(createProvider({ ...input, id: "removed", models: [{ ...model, id: "removed" }] }));
		expect(models[method]().map((entry) => entry.id)).toEqual(["first", "added"]);
	}
});

it("keeps an offline refresh offline when the cache callback changes its options", async () => {
	const models = createModels(),
		provider = createProvider(input);
	const options = { allowNetwork: false },
		phases: boolean[] = [];
	provider.refreshModels = async (context) => {
		phases.push(context.allowNetwork);
		options.allowNetwork = true;
	};
	models.setProvider(provider);
	const result = await models.refresh(options);
	expect({ phases, aborted: result.aborted, errors: [...result.errors] }).toEqual({
		phases: [false],
		aborted: false,
		errors: [],
	});
});

it("refreshes registered providers when public enumeration is overridden", async () => {
	const models = createModels(),
		provider = createProvider(input),
		phases: boolean[] = [];
	provider.refreshModels = async (context) => {
		phases.push(context.allowNetwork);
	};
	models.setProvider(provider);
	models.getProviders = () => [];
	await models.refresh({ allowNetwork: false });
	expect(phases).toEqual([false]);
});

it("selects the request key before running the header transformation", async () => {
	const models = createModels();
	models.setProvider(createProvider(input));
	const options: ModelsApiStreamOptions<"test"> = {
		apiKey: "initial",
		transformHeaders: (headers) => {
			options.apiKey = "changed";
			return headers;
		},
	};
	const result = await models.complete(model, { messages: [] }, options);
	expect({ reason: result.stopReason, key: result.errorMessage }).toEqual({ reason: "error", key: "initial" });
});

it("keeps the selected baseline catalog when the construction options change", () => {
	const options = { ...input, models: [model] };
	const provider = createProvider(options);
	options.models = [{ ...model, id: "changed" }];
	expect(provider.getModels().map((model) => model.id)).toEqual(["initial"]);
});

it("dispatches through a proxy adapter whose has trap hides its methods", async () => {
	const models = createModels();
	models.setProvider(createProvider({ ...input, api: new Proxy(input.api, { has: () => false }) }));
	const result = await models.complete(model, { messages: [] });
	expect({ reason: result.stopReason, message: result.errorMessage }).toEqual({
		reason: "error",
		message: "ambient",
	});
});

it("captures image capabilities before reading provider metadata", () => {
	const images: NonNullable<CreateProviderOptions<"test">["images"]> = {};
	const provider = createProvider({
		...input,
		images,
		get auth() {
			images.fixture = {
				generateImages: async () => {
					throw new Error("Unexpected image request");
				},
			};
			return input.auth;
		},
	});
	expect(provider.generateImages).toBeUndefined();
});

it.each(["unknown", null])("does not derive OAuth for a stored credential tagged %s", async (type) => {
	const credentials = {
		read: async () => JSON.parse(JSON.stringify({ type, expires: Date.now() + 3_600_000 })),
		list: async () => [],
		modify: async () => {
			throw new Error("Unexpected credential mutation");
		},
		delete: async () => {},
	};
	let derived = 0;
	const models = createModels({ credentials });
	models.setProvider(
		createProvider({
			...input,
			auth: {
				oauth: {
					name: "Test",
					login: async () => {
						throw new Error("Unexpected login");
					},
					refresh: async () => {
						throw new Error("Unexpected refresh");
					},
					toAuth: async () => {
						derived++;
						return { apiKey: "derived" };
					},
				},
			},
		}),
	);
	expect(await models.getAuth("test")).toBeUndefined();
	expect(derived).toBe(0);
});
