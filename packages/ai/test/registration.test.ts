import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import { type ApiProvider, getApiProvider, registerApiProvider, unregisterApiProviders } from "../src/compat.ts";
import { type ImagesApiProvider, getImagesApiProvider, registerImagesApiProvider } from "../src/images-api-registry.ts";
import type { ImageApi, ImageModel, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

it("keeps registered stream functions and API identity when the registration object changes", () => {
	const provider: ApiProvider = {
		api: "registration-test",
		stream() {
			throw new Error("initial");
		},
		streamSimple() {
			throw new Error("initial-simple");
		},
	};
	const model: Model<"registration-test"> = {
		api: "registration-test",
		id: "test",
		provider: "test",
		name: "Test",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		contextWindow: 100,
		maxTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	registerApiProvider(provider, "registration-test");
	try {
		provider.api = "changed";
		provider.stream = provider.streamSimple = () => {
			throw new Error("changed");
		};
		const registered = getApiProvider("registration-test");
		if (!registered) throw new Error("Missing API registration");
		expect(() => registered.stream(model, normalizeContext({ messages: [] }))).toThrow(/^initial$/);
		expect(() => registered.streamSimple(model, normalizeContext({ messages: [] }))).toThrow(/^initial-simple$/);
	} finally {
		unregisterApiProviders("registration-test");
	}
});

it("retains the selected environment object while credential lookup is pending", async () => {
	const pending = Promise.withResolvers<undefined>();
	const store = new InMemoryCredentialStore();
	store.read = () => pending.promise;
	const options = { env: { TEST_TOKEN: "initial" } };
	const auth = resolveProviderAuth(
		{ id: "test", auth: { apiKey: envApiKeyAuth("Test", ["TEST_TOKEN"]) } },
		store,
		{ env: async () => undefined, fileExists: async () => false },
		options,
	);
	options.env = { TEST_TOKEN: "changed" };
	pending.resolve(undefined);
	expect(await auth).toEqual({ auth: { apiKey: "initial" }, source: "TEST_TOKEN" });
});

it("keeps image API identity and callbacks when the registration object changes", () => {
	const provider: ImagesApiProvider = {
		api: "registration-images-test",
		generateImages() {
			throw new Error("initial-image");
		},
	};
	const model: ImageModel<ImageApi> = {
		type: "image",
		api: "registration-images-test",
		id: "test",
		provider: "test",
		name: "Test",
		baseUrl: "",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	registerImagesApiProvider(provider);
	provider.api = "changed";
	provider.generateImages = () => {
		throw new Error("changed-image");
	};
	const registered = getImagesApiProvider("registration-images-test");
	if (!registered) throw new Error("Missing image API registration");
	expect(() => registered.generateImages(model, { input: [] })).toThrow(/^initial-image$/);
});
