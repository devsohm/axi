import { afterEach, expect, test, vi } from "vitest";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import type { OAuthCredential } from "../src/auth/types.ts";

afterEach(() => vi.unstubAllGlobals());

test.each([
	{
		name: "individual",
		access: "offline",
		host: undefined,
		base: "https://api.individual.githubcopilot.com",
		expected: ["enabled"],
	},
	{
		name: "enterprise",
		access: "offline",
		host: "enterprise.invalid",
		base: "https://copilot-api.enterprise.invalid",
		expected: [],
	},
	{
		name: "proxy",
		access: "offline;proxy-ep=proxy.endpoint.invalid",
		host: undefined,
		base: "https://api.endpoint.invalid",
		expected: [],
	},
])(
	"Copilot %s catalog fallback only exposes enabled individual-account models",
	async ({ access, host, base, expected }) => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: unknown) => {
			urls.push(String(url));
			if (String(url).endsWith("/copilot_internal/v2/token"))
				return Response.json({ token: access, expires_at: 1_900_000_000 });
			return Response.json({
				data: [
					{ id: "enabled", policy: { state: "enabled" } },
					{ id: "disabled", policy: { state: "disabled" } },
					{ id: "unconfigured", policy: { state: "unconfigured" } },
					{ id: "unsupported", policy: { state: "enabled" }, capabilities: { supports: { tool_calls: false } } },
					null,
					{ id: 3 },
				],
			});
		});
		const credential: OAuthCredential = {
			type: "oauth",
			access: "old",
			refresh: "refresh",
			expires: 0,
			...(host ? { enterpriseUrl: host } : {}),
		};
		const next = await githubCopilotOAuth.refresh(credential, new AbortController().signal);
		expect(next.availableModelIds).toEqual(expected);
		expect(urls).toEqual([`https://api.${host ?? "github.com"}/copilot_internal/v2/token`, `${base}/models`]);
		expect(await githubCopilotOAuth.toAuth(next)).toEqual({ apiKey: access, baseUrl: base });
	},
);
