import { expect, it } from "vitest";
import { resolveCloudflareModel } from "../src/providers/cloudflare-stream.ts";

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
