import { expect, test } from "vitest";
import { createModels, type Provider, type RefreshModelsContext } from "../src/models.ts";
import type { Credential } from "../src/auth/types.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { fauxProvider } from "../src/providers/faux.ts";
import type { Model } from "../src/types.ts";

test("catalog refresh hydrates offline first and publishes authenticated updates to memory and persistent cache together", async () => {
	const faux = fauxProvider(),
		base = faux.getModel(),
		store = new InMemoryModelsStore();
	let catalog: readonly Model<string>[] = [base];
	const cached = { ...base, id: "cached" },
		fresh = { ...base, id: "fresh" };
	await store.write("faux", { models: [cached], etag: "old" });
	const phases: boolean[] = [];
	const provider = {
		...faux.provider,
		getModels: () => catalog,
		auth: { apiKey: { name: "Fixture key", resolve: async () => ({ auth: { apiKey: "test-only" } }) } },
		async refreshModels(context: RefreshModelsContext) {
			phases.push(context.allowNetwork);
			if (!context.allowNetwork) {
				const retained = context.stored?.models.filter(
					(model): model is Model<string> => model.type === undefined || model.type === "chat",
				);
				if (retained)
					await context.publish({
						update: () => {
							catalog = retained;
						},
					});
			} else
				await context.publish({
					persist: { models: [fresh], etag: "new" },
					update: () => {
						catalog = [fresh];
					},
				});
		},
	};
	const models = createModels({ modelsStore: store });
	models.setProvider(provider);
	expect((await models.refresh({ allowNetwork: false })).errors.size).toBe(0);
	expect(models.getModels("faux").map((model) => model.id)).toEqual(["cached"]);
	expect((await models.refresh()).errors.size).toBe(0);
	expect(phases).toEqual([false, false, true]);
	expect((await models.getAvailable("faux")).map((model) => model.id)).toEqual(["fresh"]);
	expect((await store.read("faux"))?.models.map((model) => model.id)).toEqual(["fresh"]);
	expect((await store.read("faux"))?.etag).toBe("new");
});

test.each(["configured", "credential"] as const)(
	"catalog refresh uses %s authentication without leaking credentials",
	async (policy) => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("faux", async () => ({ type: "oauth", access: "stale", refresh: "renew", expires: 0 }));
		let refreshes = 0;
		const phases: Array<{ network: boolean; credential: Credential | undefined }> = [];
		const provider: Provider = {
			...fauxProvider().provider,
			refreshModelsAuth: policy,
			auth: {
				oauth: {
					name: "Fixture OAuth",
					async login() {
						throw new Error("No interactive login expected");
					},
					async refresh() {
						refreshes++;
						return { type: "oauth", access: "fresh", refresh: "renewed", expires: Date.now() + 600000 };
					},
					async toAuth(credential) {
						return { apiKey: credential.access };
					},
				},
			},
			async refreshModels(context) {
				phases.push({ network: context.allowNetwork, credential: context.credential });
			},
		};
		const models = createModels({ credentials });
		models.setProvider(provider);
		expect((await models.refresh()).errors.size).toBe(0);
		expect(phases).toEqual([
			{ network: false, credential: { type: "oauth", access: "stale", refresh: "renew", expires: 0 } },
			{ network: true, credential: policy === "configured" ? undefined : expect.objectContaining({ access: "fresh" }) },
		]);
		expect(refreshes).toBe(policy === "configured" ? 0 : 1);
	},
);

test.each([true, false])(
	"configured catalog refresh checks auth availability (%s) without resolving a request key",
	async (configured) => {
		let resolutions = 0;
		const phases: boolean[] = [];
		const provider: Provider = {
			...fauxProvider().provider,
			refreshModelsAuth: "configured",
			auth: {
				apiKey: {
					name: "Fixture key",
					async check() {
						return configured ? { type: "api_key", source: "fixture environment" } : undefined;
					},
					async resolve() {
						resolutions++;
						return undefined;
					},
				},
			},
			async refreshModels(context) {
				phases.push(context.allowNetwork);
				expect(context.credential).toBeUndefined();
			},
		};
		const models = createModels();
		models.setProvider(provider);
		expect((await models.refresh()).errors.size).toBe(0);
		expect(phases).toEqual(configured ? [false, true] : [false]);
		expect(resolutions).toBe(0);
	},
);

test("a replaced provider cannot publish an obsolete refresh after its asynchronous work completes", async () => {
	const faux = fauxProvider(),
		models = createModels();
	const entered = Promise.withResolvers<RefreshModelsContext>(),
		release = Promise.withResolvers<void>(),
		finished = Promise.withResolvers<string>();
	let stale = false;
	models.setProvider({
		...faux.provider,
		async refreshModels(context) {
			entered.resolve(context);
			await release.promise;
			try {
				finished.resolve(
					String(
						await context.publish({
							update: () => {
								stale = true;
							},
						}),
					),
				);
			} catch (error) {
				finished.resolve(error instanceof Error ? error.name : String(error));
			}
		},
	});
	const running = models.refresh({ allowNetwork: false });
	const context = await entered.promise;
	const replacement = { ...faux.provider, getModels: () => [{ ...faux.getModel(), id: "replacement" }] };
	models.setProvider(replacement);
	expect(context.signal.aborted).toBe(true);
	release.resolve();
	await running;
	expect(await finished.promise).toBe("AbortError");
	expect(stale).toBe(false);
	expect(models.getModels("faux").map((model) => model.id)).toEqual(["replacement"]);
});

test("concurrent requests rotate an expired OAuth credential once and store the same fresh identity", async () => {
	const credentials = new InMemoryCredentialStore(),
		faux = fauxProvider();
	await credentials.modify("faux", async () => ({
		type: "oauth",
		access: "expired",
		refresh: "old-refresh",
		expires: 0,
	}));
	let refreshes = 0;
	const models = createModels({ credentials });
	models.setProvider({
		...faux.provider,
		auth: {
			oauth: {
				name: "Fixture OAuth",
				async login() {
					throw new Error("No interactive login expected");
				},
				async refresh() {
					refreshes++;
					return { type: "oauth", access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 600000 };
				},
				async toAuth(credential) {
					return { apiKey: credential.access };
				},
			},
		},
	});
	expect(await Promise.all([models.getAuth("faux"), models.getAuth("faux")])).toEqual([
		{ auth: { apiKey: "fresh-access" }, source: "OAuth" },
		{ auth: { apiKey: "fresh-access" }, source: "OAuth" },
	]);
	expect(refreshes).toBe(1);
	expect(await credentials.read("faux")).toMatchObject({
		type: "oauth",
		access: "fresh-access",
		refresh: "fresh-refresh",
	});
});
