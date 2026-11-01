import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, defineFacet } from "../src/next/index.ts";
import {
	Authenticators,
	cookie,
	createHttp,
	fileResponse,
	Http,
	readCookie,
	type HttpContribution,
	type HttpError,
} from "../src/next-node/http/index.ts";

async function server(routes: HttpContribution) {
	const errors: HttpError[] = [];
	const host = createHost({ principal: { kind: "server" }, onError() {} });
	const http = createHttp(
		host,
		{ listen: { host: "127.0.0.1", port: 0 }, closeTimeout: 50, onError: (error) => errors.push(error) },
		context,
	);
	const app = (value: HttpContribution) =>
		defineFacet((_host, self) => {
			self.contribute(Http, value);
			self.contribute(Authenticators, (request) =>
				request.headers.get("authorization") === "user" ? { kind: "user" } : undefined,
			);
		});
	expect(
		(
			await host.load(
				[
					{ name: "transport", facet: http.facet },
					{ name: "application", facet: app(routes) },
				],
				context,
			)
		).failed,
	).toEqual([]);
	const address = await http.listening(context);
	return {
		http,
		host,
		errors,
		origin: `http://127.0.0.1:${address.port}`,
		async reload(value: HttpContribution) {
			await host.reload(
				[
					{ name: "transport", facet: http.facet },
					{ name: "application", facet: app(value) },
				],
				context,
			);
		},
		async [Symbol.asyncDispose]() {
			await http.close(context);
			await host.close(context);
		},
	};
}

it("uses unbound authentication and route callbacks and reports errors on the HTTP component", async () => {
	const received: { authentication: unknown[]; route: unknown[]; error: unknown[] } = {
		authentication: [],
		route: [],
		error: [],
	};
	const host = createHost({ principal: { kind: "server" }, onError() {} });
	const http = createHttp(
		host,
		{
			onError: function (this: unknown) {
				received.error.push(this);
			},
		},
		context,
	);
	try {
		await host.load(
			[
				{ name: "http", facet: http.facet },
				{
					name: "routes",
					facet: defineFacet((_host, self) => {
						self.contribute(Authenticators, function (this: unknown) {
							received.authentication.push(this);
							return undefined;
						});
						self.contribute(Http, {
							routes: {
								"GET /ready": async function (this: unknown) {
									received.route.push(this);
									return { kind: "json", value: "ready" };
								},
								"GET /error": async () => {
									throw new Error("test route failure");
								},
							},
						});
					}),
				},
			],
			context,
		);
		for (const [path, status] of [
			["ready", 200],
			["error", 500],
		] as const) {
			const response = await http.fetch(
				new Request(`http://localhost:7313/${path}`, { headers: { host: "localhost:7313" } }),
				{ localAddress: "127.0.0.1", localPort: 7313 },
			);
			expect(response.status).toBe(status);
			await response.text();
		}
		expect(received.authentication).toEqual([undefined, undefined]);
		expect(received.route).toEqual([undefined]);
		expect(received.error).toEqual([http]);
	} finally {
		await http.close(context);
		await host.close(context);
	}
});

it("serves typed routes on a real listener with authentication, cookies and response headers", async () => {
	await using s = await server({
		routes: {
			"GET /hello/:name": async (request, ctx) => ({
				kind: "json",
				value: {
					name: request.params.name,
					query: request.query.get("q"),
					principal: ctx.principal?.kind ?? "anonymous",
				},
				headers: { "Set-Cookie": cookie("session", "a.b", { secret: "local-test", request }) },
			}),
			"GET /cookie": async (request) => ({ kind: "json", value: readCookie(request, "session", "local-test") ?? null }),
		},
	});
	const result = await fetch(`${s.origin}/hello/Ada?q=hello`, { headers: { authorization: "user" } });
	expect(await result.json()).toEqual({ name: "Ada", query: "hello", principal: "user" });
	expect(result.headers.get("cache-control")).toBe("no-store");
	expect(result.headers.get("content-security-policy")).toContain("'nonce-");
	const cookies = result.headers.get("set-cookie")!;
	expect(await (await fetch(`${s.origin}/cookie`, { headers: { cookie: cookies.split(";")[0]! } })).json()).toBe("a.b");
	expect(s.errors).toEqual([]);
});

it("limits bodies and rejects browser requests from a foreign origin while allowing anonymous webhooks", async () => {
	await using s = await server({
		routes: {
			"POST /data": async (request) => ({ kind: "json", value: await request.json(4) }),
			"POST /hook": {
				crossSite: true,
				handler: async (_request, ctx) => ({ kind: "json", value: { principal: ctx.principal?.kind ?? null } }),
			},
		},
	});
	expect((await fetch(`${s.origin}/data`, { method: "POST", body: "12345" })).status).toBe(413);
	expect((await fetch(`${s.origin}/data`, { method: "POST", body: "?" })).status).toBe(400);
	expect(
		(
			await fetch(`${s.origin}/data`, {
				method: "POST",
				body: "null",
				headers: { origin: "https://elsewhere.example" },
			})
		).status,
	).toBe(403);
	const hook = await fetch(`${s.origin}/hook`, {
		method: "POST",
		headers: { origin: "https://elsewhere.example", authorization: "user" },
	});
	expect(await hook.json()).toEqual({ principal: null });
});

it("reads files lazily with ranges and HEAD and reports route failures without leaking their text", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-http-"));
	const path = join(directory, "note.txt");
	await writeFile(path, "abcdefgh");
	try {
		await using s = await server({
			routes: {
				"GET /file": async () => fileResponse(path, { root: directory, ranges: true, download: "note.txt" }),
				"GET /failure": async () => {
					throw new Error("private failure text");
				},
			},
		});
		const range = await fetch(`${s.origin}/file`, { headers: { range: "bytes=2-4" } });
		expect(range.status).toBe(206);
		expect(await range.text()).toBe("cde");
		expect(range.headers.get("content-range")).toBe("bytes 2-4/8");
		const head = await fetch(`${s.origin}/file`, { method: "HEAD" });
		expect(head.headers.get("content-length")).toBe("8");
		expect(await head.text()).toBe("");
		const failed = await fetch(`${s.origin}/failure`);
		expect(failed.status).toBe(500);
		expect(await failed.text()).toBe("Internal Server Error");
		expect(s.errors).toMatchObject([{ kind: "route_failed", pattern: "GET /failure" }]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("serves authenticated WebSockets and closes a socket whose handler is removed", async () => {
	await using s = await server({
		sockets: {
			"/echo": (socket) => {
				socket.on("message", (value) => socket.send(value));
			},
		},
	});
	const socket = new WebSocket(s.origin.replace("http:", "ws:") + "/echo", { headers: { authorization: "user" } });
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	const reply = new Promise<string>((resolve) => socket.once("message", (value) => resolve(String(value))));
	socket.send("hello");
	expect(await reply).toBe("hello");
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	await s.reload({ routes: { "GET /": async () => ({ kind: "html", body: "updated" }) } });
	await closed;
	expect(await (await fetch(s.origin)).text()).toBe("updated");
});
