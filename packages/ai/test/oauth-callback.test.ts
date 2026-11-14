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

it("an expired callback rejects its waiter and refuses a later authorization code", async () => {
	let exchanges = 0;
	const server = await startOAuthCallbackServer({
		providerName: "Expired",
		host: "127.0.0.1",
		port: 0,
		path: "/callback",
		timeoutMs: 1,
		complete: async () => {
			exchanges++;
			return "unexpected";
		},
	});
	try {
		await expect(server.wait()).rejects.toThrow("sign-in timed out");
		expect((await fetch(`${server.redirectUri}?code=late`)).status).toBe(409);
		expect(exchanges).toBe(0);
	} finally {
		server.close();
	}
});

it.each([new Error("Exchange refused"), "Exchange refused"])(
	"a failed exchange settles its waiter and returns an error page: %s",
	async (failure) => {
		const server = await startOAuthCallbackServer({
			providerName: "Failed",
			host: "127.0.0.1",
			port: 0,
			path: "/callback",
			complete: async () => {
				throw failure;
			},
		});
		try {
			const page = await fetch(`${server.redirectUri}?code=offline`);
			expect(page.status).toBe(502);
			expect(await page.text()).toContain("Exchange refused");
			await expect(server.wait()).rejects.toThrow("Exchange refused");
		} finally {
			server.close();
		}
	},
);
