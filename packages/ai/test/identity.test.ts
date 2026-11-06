import { expect, it } from "vitest";
import { createModels } from "../src/models.ts";
import {
	AXI_ATTRIBUTION,
	formatUserAgent,
	getAttributionHeaders,
	getIdentityHeaders,
	getOpenCodeSessionHeaders,
	mergeClientIdentity,
	withClientIdentity,
} from "../src/utils/identity.ts";

it("merges explicit fields and lets callers disable attribution", () => {
	expect(mergeClientIdentity({ attribution: AXI_ATTRIBUTION, userAgent: "short" }, { attribution: null })).toEqual({
		attribution: null,
		userAgent: "short",
	});
	expect(mergeClientIdentity(undefined)).toBeUndefined();
	expect(formatUserAgent({ userAgent: { custom: "my-app/2" } })).toBe("my-app/2");
	expect(formatUserAgent({ userAgent: "short" })).toBe("axi");
});

it("scopes attribution and session headers to matching providers", () => {
	const identity = { userAgent: "short", attribution: { name: "test", url: "https://test.invalid" } } as const;
	expect(getIdentityHeaders({ provider: "custom", baseUrl: "https://openrouter.ai/api/v1" }, identity)).toEqual({
		"User-Agent": "axi",
		"HTTP-Referer": "https://test.invalid",
		"X-OpenRouter-Title": "test",
	});
	expect(getIdentityHeaders({ provider: "custom", baseUrl: "https://other.invalid" }, identity)).toEqual({
		"User-Agent": "axi",
	});
	expect(getOpenCodeSessionHeaders({ provider: "opencode", baseUrl: "https://opencode.ai" }, "run-1")).toEqual({
		"x-opencode-session": "run-1",
	});
	expect(getOpenCodeSessionHeaders({ provider: "other", baseUrl: "https://other.invalid" }, "run-1")).toBeUndefined();
});

it("keeps a mutable model collection mutable through identity wrapping", () => {
	const models = createModels();
	const wrapped = withClientIdentity(models, { userAgent: "short" });
	expect(wrapped.getProviders()).toEqual(models.getProviders());
	wrapped.clearProviders();
	expect(models.getProviders()).toEqual([]);
});

it("uses one attribution snapshot when headers come from accessors", () => {
	for (const provider of ["nvidia", "openrouter"]) {
		let names = 0,
			categories = 0;
		const attribution = {
			get name() {
				return names++ === 0 ? "alpha" : "beta";
			},
			url: "https://example.test/client",
			get categories() {
				return categories++ === 0 ? ["cli"] : [];
			},
		};
		const headers = getAttributionHeaders({ provider, baseUrl: "https://example.test/v1" }, { attribution });
		expect(headers).toEqual(
			provider === "nvidia"
				? { "X-BILLING-INVOKE-ORIGIN": "Alpha" }
				: {
						"HTTP-Referer": attribution.url,
						"X-OpenRouter-Title": "alpha",
						"X-OpenRouter-Categories": "cli",
					},
		);
		expect([names, categories]).toEqual([1, 1]);
	}
});
