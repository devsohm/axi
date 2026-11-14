import { expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";

test("credential enumeration tracks changes, retained values and deletions by provider", async () => {
	const store = new InMemoryCredentialStore();
	await store.modify("key-provider", async () => ({ type: "api_key", key: "fixture" }));
	await store.modify("oauth-provider", async () => ({
		type: "oauth",
		access: "access",
		refresh: "refresh",
		expires: 100,
	}));
	expect(await store.list()).toEqual([
		{ providerId: "key-provider", type: "api_key" },
		{ providerId: "oauth-provider", type: "oauth" },
	]);
	expect(await store.modify("key-provider", async () => undefined)).toEqual({ type: "api_key", key: "fixture" });
	await store.delete("key-provider");
	expect(await store.read("key-provider")).toBeUndefined();
	expect(await store.list()).toEqual([{ providerId: "oauth-provider", type: "oauth" }]);
});

test("a failed credential edit does not block later edits on that provider or another provider", async () => {
	const store = new InMemoryCredentialStore(),
		entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const failure = new Error("Credential edit failed");
	const first = store.modify("one", async () => {
		entered.resolve();
		await release.promise;
		throw failure;
	});
	const rejected = expect(first).rejects.toBe(failure);
	await entered.promise;
	const next = store.modify("one", async (prior) => {
		expect(prior).toBeUndefined();
		return { type: "api_key", key: "next" };
	});
	await store.modify("two", async () => ({ type: "api_key", key: "independent" }));
	expect(await store.read("two")).toEqual({ type: "api_key", key: "independent" });
	release.resolve();
	await rejected;
	await next;
	expect(await store.read("one")).toEqual({ type: "api_key", key: "next" });
});

test("cancelling a queued credential deletion preserves the current value and does not block its successor", async () => {
	const store = new InMemoryCredentialStore(),
		entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const controller = new AbortController(),
		failure = new Error("Caller cancelled deletion");
	const first = store.modify("one", async () => {
		entered.resolve();
		await release.promise;
		return { type: "api_key", key: "retained" };
	});
	await entered.promise;
	const deletion = store.delete("one", { signal: controller.signal });
	const rejected = expect(deletion).rejects.toBe(failure);
	controller.abort(failure);
	release.resolve();
	await first;
	await rejected;
	await store.modify("one", async () => undefined);
	expect(await store.read("one")).toEqual({ type: "api_key", key: "retained" });
	expect(await store.list()).toEqual([{ providerId: "one", type: "api_key" }]);
});
