import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { startOAuthCallbackServer } from "../src/auth/oauth/callback-server.ts";

it("keeps callback identity and removes the original signal listener when options change", async () => {
	const original = new AbortController();
	const options = {
		providerName: "Initial",
		host: "127.0.0.1",
		port: 0,
		path: "/callback",
		signal: original.signal,
		complete: async (code: string) => code,
	};
	const server = await startOAuthCallbackServer(options);
	try {
		options.providerName = "Changed";
		options.signal = new AbortController().signal;
		const page = await fetch(`${server.redirectUri}?error=denied`);
		expect(page.status).toBe(400);
		await expect(server.wait()).rejects.toThrow("Initial authorization failed: denied");
		expect(getEventListeners(original.signal, "abort")).toEqual([]);
	} finally {
		server.close();
	}
});
