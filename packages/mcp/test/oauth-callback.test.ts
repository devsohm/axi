import { expect, test } from "vitest";
import { OAuthCallbackServer } from "../src/oauth/index.ts";

test("loopback callbacks separate states and handle success, denial, wrong paths, timeout and closure", async () => {
	const server = await OAuthCallbackServer.listen({
		path: "/return",
		extraPaths: ["/other"],
		timeoutMs: 2000,
		renderPage: (page) => (page.ok ? "OK" : page.message),
	});
	let closed = false;
	const callback = (query: string, path = "/return") => fetch(new URL(path + "?" + query, server.redirectUrl));
	try {
		const ready = server.waitForCallback("ready");
		expect(() => server.waitForCallback("ready")).toThrow("already pending");
		expect((await callback("state=unknown&code=wrong")).status).toBe(400);
		const success = await callback("state=ready&code=accepted&iss=local");
		expect(await success.text()).toBe("OK");
		expect(success.headers.get("cache-control")).toBe("no-store");
		expect(await ready).toEqual({ state: "ready", code: "accepted", iss: "local" });
		expect((await callback("state=ready&code=replayed")).status).toBe(400);
		const denied = expect(server.waitForCallback("denied")).rejects.toThrow("No permission");
		expect((await callback("state=denied&error=access_denied&error_description=No+permission")).status).toBe(200);
		await denied;
		const missing = expect(server.waitForCallback("missing")).rejects.toThrow("did not include an authorization code");
		expect((await callback("state=missing")).status).toBe(400);
		await missing;
		const wrongPath = expect(server.waitForCallback("path", "/return")).rejects.toThrow("another redirect URI");
		expect((await callback("state=path&code=wrong", "/other")).status).toBe(400);
		await wrongPath;
		expect((await callback("state=not-used", "/absent")).status).toBe(404);
		const pending = expect(server.waitForCallback("pending")).rejects.toThrow("server closed");
		await server.close();
		closed = true;
		await pending;
	} finally {
		if (!closed) await server.close();
	}
	const timeout = await OAuthCallbackServer.listen({ timeoutMs: 10 });
	try {
		await expect(timeout.waitForCallback("late")).rejects.toThrow("timed out");
	} finally {
		await timeout.close();
	}
});
