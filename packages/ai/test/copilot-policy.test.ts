import { afterEach, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("retains a successful login when a throttled policy response body fails", async () => {
	vi.useFakeTimers();
	const policy = new Response("rate limited", { status: 429, headers: { "retry-after": "10" } });
	vi.spyOn(policy, "text").mockRejectedValue(new Error("Policy response interrupted"));
	let policyRequests = 0;
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("/login/device/code"))
			return Response.json({
				device_code: "device",
				user_code: "user",
				verification_uri: "https://github.com/login/device",
				interval: 1,
				expires_in: 900,
			});
		if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "github-token" });
		if (url.endsWith("/copilot_internal/v2/token"))
			return Response.json({ token: "copilot-token", expires_at: 9999999999 });
		if (url.endsWith("/models"))
			return Response.json({
				data: [{ id: "claude-fable-5", model_picker_enabled: true, policy: { state: "unconfigured" } }],
			});
		if (url.endsWith("/policy")) {
			policyRequests++;
			return policy;
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	models.setProvider(githubCopilotProvider());
	const ready = Promise.withResolvers<void>();
	const login = models.login("github-copilot", "oauth", {
		prompt: async () => "",
		notify(event) {
			if (event.type === "device_code") ready.resolve();
		},
	});
	const result = expect(login).resolves.toMatchObject({ type: "oauth", access: "copilot-token" });
	await ready.promise;
	await vi.advanceTimersByTimeAsync(1000);
	await result;
	expect(policyRequests).toBe(1);
	expect(await credentials.read("github-copilot")).toMatchObject({ type: "oauth", access: "copilot-token" });
});
