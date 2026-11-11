import { expect, test, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { fauxProvider } from "../src/providers/faux.ts";

const expired: OAuthCredential = { type: "oauth", access: "expired", refresh: "old", expires: 0 };
const renewed = (): OAuthCredential => ({
	type: "oauth",
	access: "renewed",
	refresh: "rotated",
	expires: Date.now() + 3_600_000,
});

function fixture() {
	const credentials = new InMemoryCredentialStore();
	const oauth: OAuthAuth = {
		name: "Offline test account",
		async login() {
			throw new Error("Interactive login is not used");
		},
		refresh: async () => renewed(),
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};
	const ambient = vi.fn(async () => ({ auth: { apiKey: "ambient" } }));
	const models = createModels({ credentials });
	models.setProvider({
		...fauxProvider().provider,
		auth: { oauth, apiKey: { name: "Offline key", resolve: ambient } },
	});
	return { credentials, oauth, ambient, models };
}

test("cancelling an active refresh releases its caller while the rotated token remains shared and saved", async () => {
	const { credentials, oauth, models } = fixture();
	await credentials.modify("faux", async () => expired);
	const entered = Promise.withResolvers<AbortSignal>();
	const release = Promise.withResolvers<OAuthCredential>();
	const refresh = vi.spyOn(oauth, "refresh").mockImplementation(async (_credential, signal) => {
		entered.resolve(signal);
		return release.promise;
	});
	const controller = new AbortController();
	const first = models.getAuth("faux", { signal: controller.signal });
	const refreshSignal = await entered.promise;
	const second = models.getAuth("faux");
	const reason = new Error("Request no longer needed");
	const rejected = expect(first).rejects.toBe(reason);
	controller.abort(reason);
	await rejected;
	expect(refreshSignal.aborted).toBe(false);
	const fresh = renewed();
	release.resolve(fresh);
	expect(await second).toEqual({ auth: { apiKey: fresh.access }, source: "OAuth" });
	expect(await credentials.read("faux")).toEqual(fresh);
	expect(refresh).toHaveBeenCalledTimes(1);
});

test("cancelling while waiting for a credential lock does not rotate or replace the saved token", async () => {
	const { credentials, oauth, models } = fixture();
	await credentials.modify("faux", async () => expired);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const holding = credentials.modify("faux", async () => {
		entered.resolve();
		await release.promise;
		return undefined;
	});
	await entered.promise;
	const refresh = vi.spyOn(oauth, "refresh");
	const modify = vi.spyOn(credentials, "modify");
	const controller = new AbortController();
	const pending = models.getAuth("faux", { signal: controller.signal });
	await vi.waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
	const reason = new Error("Stop waiting for credentials");
	const rejected = expect(pending).rejects.toBe(reason);
	controller.abort(reason);
	await rejected;
	release.resolve();
	await holding;
	await credentials.modify("faux", async () => undefined);
	expect(refresh).not.toHaveBeenCalled();
	expect(await credentials.read("faux")).toEqual(expired);
});

test.each(["read", "modify", "refresh", "derive"] as const)(
	"a failed %s keeps its cause and never falls back to ambient credentials",
	async (stage) => {
		const { credentials, oauth, ambient, models } = fixture();
		await credentials.modify("faux", async () => expired);
		const cause = new Error(`Offline ${stage} failure`);
		if (stage === "read") vi.spyOn(credentials, "read").mockRejectedValue(cause);
		else if (stage === "modify") vi.spyOn(credentials, "modify").mockRejectedValue(cause);
		else if (stage === "refresh") vi.spyOn(oauth, "refresh").mockRejectedValue(cause);
		else vi.spyOn(oauth, "toAuth").mockRejectedValue(cause);
		await expect(models.getAuth("faux")).rejects.toMatchObject({
			code: stage === "read" || stage === "modify" ? "auth" : "oauth",
			cause,
		});
		expect(ambient).not.toHaveBeenCalled();
	},
);

test.each([undefined, 300_000])(
	"a refreshed short-lived token observes the requested minimum validity: %s",
	async (minimum) => {
		const { credentials, oauth, models } = fixture();
		await credentials.modify("faux", async () => expired);
		const short = { ...renewed(), expires: Date.now() + 60_000 };
		vi.spyOn(oauth, "refresh").mockResolvedValue(short);
		const result = models.getAuth("faux", { minOAuthValidityMs: minimum });
		if (minimum === undefined) expect(await result).toEqual({ auth: { apiKey: short.access }, source: "OAuth" });
		else await expect(result).rejects.toMatchObject({ code: "oauth" });
		expect(await credentials.read("faux")).toEqual(short);
	},
);
