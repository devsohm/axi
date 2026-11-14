import { expect, test } from "vitest";
import { once } from "node:events";
import { createConnection } from "node:net";
import { OAuthCallbackServer } from "../src/oauth/index.ts";

test("an IPv6 redirect host is bracketed independently of the loopback bind address", async () => {
	const server = await OAuthCallbackServer.listen({ redirectHost: "::1" });
	try {
		const advertised = new URL(server.redirectUrl);
		expect(advertised.hostname).toBe("[::1]");
		const received = server.waitForCallback("ipv6");
		advertised.hostname = "127.0.0.1";
		advertised.search = "state=ipv6&code=accepted";
		const response = await fetch(advertised);
		expect(response.status).toBe(200);
		expect(await received).toEqual({ state: "ipv6", code: "accepted" });
	} finally {
		await server.close();
	}
});

test("a browser denial without a description retains its error code and closing twice reports the closed server", async () => {
	const server = await OAuthCallbackServer.listen();
	try {
		const denied = expect(server.waitForCallback("denied")).rejects.toThrow("access_denied");
		const response = await fetch(server.redirectUrl + "?state=denied&error=access_denied");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("access_denied");
		await denied;
	} finally {
		await server.close();
	}
	await expect(server.close()).rejects.toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
});

test("closing a completed login also closes an unused browser connection", async () => {
	const server = await OAuthCallbackServer.listen();
	const url = new URL(server.redirectUrl);
	const spare = createConnection({ host: url.hostname, port: Number(url.port) });
	let closing: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await once(spare, "connect");
		spare.write("GET /callback HTTP/1.1\r\n");
		const result = server.waitForCallback("browser");
		await (await fetch(server.redirectUrl + "?state=browser&code=accepted")).text();
		expect((await result).code).toBe("accepted");
		closing = server.close();
		const deadline = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), 300);
		});
		expect(await Promise.race([closing.then(() => true), deadline])).toBe(true);
	} finally {
		clearTimeout(timer);
		spare.destroy();
		await (closing ?? server.close());
	}
});

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
