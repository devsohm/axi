import { expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { AuthInteraction, Credential, OAuthAuth } from "../src/auth/types.ts";
import { createModels, type RefreshModelsContext } from "../src/models.ts";
import { fauxProvider } from "../src/providers/faux.ts";
import type { ImageModel } from "../src/types.ts";

const interaction: AuthInteraction = {
	async prompt() {
		return "fixture-key";
	},
	notify() {},
};
const live = { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000 } as const;
const oauth: OAuthAuth = {
	name: "Test OAuth",
	async login() {
		return live;
	},
	async refresh() {
		return live;
	},
	async toAuth(value) {
		return { apiKey: value.access };
	},
};

test("auth availability distinguishes unknown, unsupported, ambient, stored and OAuth identities", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const faux = fauxProvider();
	expect(await models.checkAuth("missing")).toBeUndefined();
	expect(await models.getAuth("missing")).toBeUndefined();
	expect(await models.getAvailable("missing")).toEqual([]);
	models.setProvider({ ...faux.provider, auth: {} });
	expect(await models.checkAuth("faux")).toBeUndefined();
	await credentials.modify("faux", async () => live);
	expect(await models.checkAuth("faux")).toBeUndefined();
	models.setProvider({ ...faux.provider, auth: { oauth } });
	expect(await models.checkAuth("faux")).toEqual({ type: "oauth", source: "OAuth" });
	expect(await models.getAvailable("faux")).toEqual(faux.models);
	await models.logout("faux");
	expect(await credentials.read("faux")).toBeUndefined();
	models.setProvider({
		...faux.provider,
		auth: {
			apiKey: {
				name: "Key",
				async resolve({ credential }) {
					return { auth: { apiKey: credential?.key ?? "ambient" }, source: credential ? "stored" : "environment" };
				},
			},
		},
	});
	expect(await models.checkAuth("faux")).toEqual({ type: "api_key", source: "environment" });
	await credentials.modify("faux", async () => ({ type: "api_key", key: "key" }));
	expect(await models.checkAuth("faux")).toEqual({ type: "api_key", source: "stored" });
	const failure = new Error("credential checker unavailable");
	models.setProvider({
		...faux.provider,
		auth: {
			apiKey: {
				name: "Key",
				async resolve() {
					throw new Error("resolve should not run");
				},
				async check() {
					throw failure;
				},
			},
		},
	});
	await expect(models.checkAuth("faux")).rejects.toMatchObject({ code: "auth", cause: failure });
});

test("chat-only filters retain image models, while a complete-catalog filter controls every model type", async () => {
	const models = createModels();
	const faux = fauxProvider();
	const first = faux.getModel();
	const second = { ...first, id: "second" };
	const image: ImageModel<"test-image"> = {
		...first,
		type: "image",
		api: "test-image",
		id: "image",
		output: ["image"],
	};
	const base = {
		...faux.provider,
		getModels: () => [first, second],
		getAllModels: () => [first, second, image],
		filterModels: () => [second],
	};
	models.setProvider(base);
	expect(await models.getAvailable()).toEqual([second]);
	expect(await models.getAllAvailable()).toEqual([second, image]);
	expect(await models.getAvailableOfType("image")).toEqual([image]);
	models.setProvider({ ...base, filterAllModels: () => [image] });
	expect(await models.getAllAvailable("faux")).toEqual([image]);
	models.setProvider({ ...base, getAllModels: undefined, filterModels: undefined });
	expect(await models.getAllAvailable("faux")).toEqual([first, second]);
});

test("catalog refresh rotates expired OAuth once and supplies network phases only with usable authentication", async () => {
	for (const credential of [
		undefined,
		live,
		{ ...live, expires: 0 },
		{ type: "api_key", key: "key", env: { REGION: "local" } },
	] satisfies (Credential | undefined)[]) {
		const credentials = new InMemoryCredentialStore();
		if (credential) await credentials.modify("faux", async () => credential);
		const models = createModels({ credentials });
		const phases: RefreshModelsContext[] = [];
		let rotations = 0;
		models.setProvider({
			...fauxProvider().provider,
			auth: {
				oauth: {
					...oauth,
					async refresh() {
						rotations++;
						return live;
					},
				},
				apiKey: {
					name: "Key",
					async resolve({ credential }) {
						return credential ? { auth: { apiKey: credential.key }, env: credential.env } : undefined;
					},
				},
			},
			async refreshModels(ctx) {
				phases.push(ctx);
			},
		});
		const result = await models.refresh({ providers: ["faux"], force: true });
		expect(result).toEqual({ aborted: false, errors: new Map() });
		expect(phases.map(({ allowNetwork, force }) => ({ allowNetwork, force }))).toEqual([
			{ allowNetwork: false, force: undefined },
			...(credential ? [{ allowNetwork: true, force: true }] : []),
		]);
		expect(rotations).toBe(credential?.type === "oauth" && credential.expires === 0 ? 1 : 0);
		if (credential) expect(phases[1]?.credential).toEqual(credential.type === "oauth" ? live : credential);
	}
});

test("cached refresh still runs when credential storage fails and reports the auth error separately", async () => {
	const failure = new Error("credential storage unavailable");
	class Credentials extends InMemoryCredentialStore {
		override async read(): Promise<never> {
			throw failure;
		}
	}
	const models = createModels({ credentials: new Credentials() });
	const phases: boolean[] = [];
	models.setProvider({
		...fauxProvider().provider,
		async refreshModels(ctx) {
			phases.push(ctx.allowNetwork);
		},
	});
	const result = await models.refresh();
	expect(phases).toEqual([false]);
	expect(result.errors.get("faux")).toMatchObject({ code: "auth", cause: failure });
	expect(await models.refresh({ signal: AbortSignal.abort() })).toEqual({ aborted: true, errors: new Map() });
	expect(phases).toEqual([false]);
});

test("login persists its selected method and cancelled queued login cannot overwrite an existing credential", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const faux = fauxProvider();
	models.setProvider({ ...faux.provider, auth: { oauth } });
	await expect(models.login("missing", "oauth", interaction)).rejects.toMatchObject({ code: "provider" });
	await expect(models.login("faux", "api_key", interaction)).rejects.toMatchObject({ code: "auth" });
	expect(await models.login("faux", "oauth", interaction)).toEqual(live);
	expect(await credentials.read("faux")).toEqual(live);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const holding = credentials.modify("faux", async (current) => {
		entered.resolve();
		await release.promise;
		return current;
	});
	await entered.promise;
	const ready = Promise.withResolvers<void>();
	models.setProvider({
		...faux.provider,
		auth: {
			apiKey: {
				name: "Key",
				async resolve() {
					return undefined;
				},
				async login() {
					ready.resolve();
					return { type: "api_key", key: "new" };
				},
			},
		},
	});
	const controller = new AbortController(),
		reason = new Error("cancel queued login");
	const loggingIn = models.login("faux", "api_key", { ...interaction, signal: controller.signal });
	const rejected = expect(loggingIn).rejects.toBe(reason);
	await ready.promise;
	controller.abort(reason);
	await rejected;
	release.resolve();
	await holding;
	expect(await credentials.read("faux")).toEqual(live);
});

test("login and logout retain credential-store failure causes", async () => {
	const failure = new Error("credential store read-only");
	class Credentials extends InMemoryCredentialStore {
		override async modify(): Promise<never> {
			throw failure;
		}
		override async delete(): Promise<never> {
			throw failure;
		}
	}
	const models = createModels({ credentials: new Credentials() });
	models.setProvider({ ...fauxProvider().provider, auth: { oauth } });
	await expect(models.login("faux", "oauth", interaction)).rejects.toMatchObject({ code: "auth", cause: failure });
	await expect(models.logout("faux")).rejects.toMatchObject({ code: "auth", cause: failure });
});
