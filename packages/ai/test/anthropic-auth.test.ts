import { expect, it } from "vitest";
import type { ApiKeyCredential } from "../src/auth/types.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";

it("resolves the ambient key after the initial stored-key check", async () => {
	const credential: ApiKeyCredential = { type: "api_key" };
	const resolved = await anthropicProvider().auth.apiKey?.resolve({
		credential,
		signal: new AbortController().signal,
		ctx: {
			async env(name) {
				if (name === "ANTHROPIC_AUTH_TOKEN") credential.key = "later-stored-key";
				return name === "ANTHROPIC_OAUTH_TOKEN" ? "ambient-key" : undefined;
			},
			fileExists: async () => false,
		},
	});
	expect(resolved).toEqual({ auth: { apiKey: "ambient-key" }, source: "ANTHROPIC_OAUTH_TOKEN" });
});
