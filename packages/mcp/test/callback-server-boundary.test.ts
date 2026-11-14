import { afterEach, expect, test, vi } from "vitest";
import { OAuthCallbackServer } from "../src/oauth/callback.ts";

const faults = vi.hoisted(() => ({ closeAtListen: false, omitTarget: false }));
vi.mock("node:http", async (original) => {
	const http = await original<typeof import("node:http")>();
	return {
		...http,
		createServer() {
			const server = http.createServer();
			if (faults.closeAtListen) server.once("listening", () => server.close());
			server.prependListener("request", (request) => {
				if (faults.omitTarget) request.url = undefined;
			});
			return server;
		},
	};
});
afterEach(() => {
	faults.closeAtListen = false;
	faults.omitTarget = false;
});

test("a callback listener closed during binding reports startup failure", async () => {
	faults.closeAtListen = true;
	await expect(OAuthCallbackServer.listen()).rejects.toThrow("did not bind to TCP");
	faults.closeAtListen = false;
	const server = await OAuthCallbackServer.listen();
	await server.close();
});

test("a request without a target cannot consume a pending callback", async () => {
	const server = await OAuthCallbackServer.listen();
	const received = server.waitForCallback("pending");
	try {
		faults.omitTarget = true;
		const invalid = await fetch(server.redirectUrl + "?state=pending&code=wrong");
		expect(invalid.status).toBe(404);
		faults.omitTarget = false;
		const valid = await fetch(server.redirectUrl + "?state=pending&code=accepted");
		expect(valid.status).toBe(200);
		expect(await received).toEqual({ state: "pending", code: "accepted" });
	} finally {
		await server.close();
	}
});
