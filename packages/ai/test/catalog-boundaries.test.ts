import { expect, test } from "vitest";
import { createModels, type RefreshModelsContext } from "../src/models.ts";
import { InMemoryModelsStore, type ModelsStoreOperationOptions } from "../src/models-store.ts";
import { fauxProvider } from "../src/providers/faux.ts";

test("catalog lookups tolerate unavailable providers and use chat models when no all-model accessor exists", () => {
	const scripted = fauxProvider(),
		models = createModels();
	const plain = { ...scripted.provider, getAllModels: undefined };
	models.setProvider(plain);
	expect(models.getProvider("faux")).toBe(plain);
	expect(models.getAllModels("faux")).toEqual([scripted.getModel()]);
	expect(models.getAllModels()).toEqual([scripted.getModel()]);
	expect(models.getModels("missing")).toEqual([]);
	expect(models.getAllModels("missing")).toEqual([]);
	expect(models.getModelsOfType("image", "faux")).toEqual([]);
	expect(models.getModelOfType("classifier", "faux", "missing")).toBeUndefined();
	const failed = {
		...scripted.provider,
		id: "failed",
		getModels(): never {
			throw new Error("catalog unavailable");
		},
		getAllModels: undefined,
	};
	models.setProvider(failed);
	expect(models.getModels("failed")).toEqual([]);
	expect(models.getAllModels("failed")).toEqual([]);
	expect(models.getModels()).toEqual([scripted.getModel()]);
	expect(models.getAllModels()).toEqual([scripted.getModel()]);
	models.clearProviders();
	expect(models.getProvider("faux")).toBeUndefined();
	expect(models.getProviders()).toEqual([]);
});

test("failed catalog removal retains the previous catalog and a later publication can recover", async () => {
	const failure = new Error("cache unavailable");
	class Store extends InMemoryModelsStore {
		fail = true;
		override async delete(id: string, options?: ModelsStoreOperationOptions): Promise<void> {
			if (this.fail) throw failure;
			return super.delete(id, options);
		}
	}
	const store = new Store(),
		scripted = fauxProvider(),
		initial = scripted.getModel();
	const updated = { ...initial, id: "updated" };
	let catalog = [initial];
	await store.write("faux", { models: catalog });
	const models = createModels({ modelsStore: store });
	models.setProvider({
		...scripted.provider,
		getModels: () => catalog,
		async refreshModels(context: RefreshModelsContext) {
			await context.publish({
				persist: null,
				update() {
					catalog = [updated];
				},
			});
		},
	});
	const failed = await models.refresh({ allowNetwork: false });
	expect(failed.errors.has("faux")).toBe(true);
	expect(models.getModels("faux")).toEqual([initial]);
	expect((await store.read("faux"))?.models).toEqual([initial]);
	store.fail = false;
	expect((await models.refresh({ allowNetwork: false })).errors.size).toBe(0);
	expect(models.getModels("faux")).toEqual([updated]);
	expect(await store.read("faux")).toBeUndefined();
});
