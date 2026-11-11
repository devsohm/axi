import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { constant, createHost, defineFacet, hostKind, int, method, remote, webSocketLink } from "../src/index.ts";
import {
	Authenticators,
	createHttp,
	Http,
	type HttpContribution,
	type HttpError,
	type LinksOptions,
} from "../src/node/http/index.ts";
import { limitedSocket } from "../src/node/http/upgrades.ts";

afterEach(() => vi.useRealTimers());
const Server = hostKind("http-link.server");
const Counter = remote("http-link.counter", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { ready: { state: { value: int() }, methods: { echo: method(int(), int()) } } },
});
async function fixture(links?: Omit<LinksOptions, "path">, initial: HttpContribution = {}) {
	const errors: HttpError[] = [],
		callers: unknown[] = [],
		sockets: WebSocket[] = [];
	const host = createHost({ address: Server(), principal: { kind: "server" }, onError() {} });
	const http = createHttp(
		host,
		{
			listen: { host: "127.0.0.1", port: 0 },
			closeTimeout: 50,
			links: { path: "/objects", ...links },
			onError: (error) => errors.push(error),
		},
		context,
	);
	const app = (contribution: HttpContribution) =>
		defineFacet((h, self) => {
			self.contribute(Http, contribution);
			self.contribute(Authenticators, (request) =>
				request.headers.get("authorization") === "user" ? { kind: "user" } : undefined,
			);
			h.serve(Counter, (_params, principal) => {
				callers.push(principal);
				return { variant: "ready", members: { value: constant(7), echo: async (n) => n } };
			});
		});
	const result = await host.load(
		[
			{ name: "transport", facet: http.facet },
			{ name: "app", facet: app(initial) },
		],
		context,
	);
	expect(result.failed).toEqual([]);
	const address = await http.listening(context);
	return {
		host,
		http,
		errors,
		callers,
		connect(path = "/objects", headers: Record<string, string | undefined> = {}, autoPong = true) {
			const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
				autoPong,
				headers: { authorization: "user", ...headers },
			});
			sockets.push(socket);
			return socket;
		},
		async reload(contribution: HttpContribution) {
			expect(
				(
					await host.reload(
						[
							{ name: "transport", facet: http.facet },
							{ name: "app", facet: app(contribution) },
						],
						context,
					)
				).failed,
			).toEqual([]);
		},
		async [Symbol.asyncDispose]() {
			for (const socket of sockets) socket.terminate();
			await http.close(context);
			await host.close(context);
		},
	};
}

test.each([undefined, false, true])(
	"authenticated object links exchange real RPCs with dynamic options=%s",
	async (dynamic) => {
		let opened = 0,
			closed = 0;
		const selected: unknown[] = [];
		await using app = await fixture({
			options:
				dynamic === undefined
					? undefined
					: dynamic
						? (request, principal) => {
								selected.push([request.path, principal]);
								return { maxPayload: 16384 };
							}
						: { maxPayload: 16384 },
			opened(request, principal) {
				opened++;
				expect([request.path, principal]).toEqual(["/objects", { kind: "user" }]);
				return () => {
					closed++;
				};
			},
		});
		const client = createHost({ principal: { kind: "client" }, onError() {} });
		try {
			await client.load([], context);
			const socket = app.connect();
			client.connect(webSocketLink(socket), { principal: { kind: "server" }, trusted: true }, context);
			await once(socket, "open");
			const counter = await client.get(Counter, {}, context);
			expect(counter.variant).toBe("ready");
			expect(counter.value.value).toBe(7);
			expect(await counter.echo(19, context)).toBe(19);
			expect(app.callers).toEqual([{ kind: "user" }]);
			expect(selected).toEqual(dynamic ? [["/objects", { kind: "user" }]] : []);
			expect(opened).toBe(1);
			const ended = once(socket, "close");
			counter.release();
			await client.close(context);
			socket.close();
			await ended;
			await vi.waitFor(() => expect(closed).toBe(1));
			expect(app.errors).toEqual([]);
		} finally {
			await client.close(context);
		}
	},
);

test.each([
	{ headers: { authorization: "" }, status: 401 },
	{ headers: { origin: "https://foreign.example" }, status: 403 },
	{ headers: { "sec-fetch-site": "cross-site" }, status: 403 },
])("object-link admission rejects $status before opening the link", async ({ headers, status }) => {
	const opened = vi.fn();
	await using app = await fixture({ opened });
	const socket = app.connect("/objects", headers);
	const response = await new Promise<number>((resolve, reject) => {
		socket.once("error", reject);
		socket.once("unexpected-response", (_request, reply) => {
			reply.resume();
			socket.terminate();
			resolve(reply.statusCode ?? 0);
		});
	});
	expect(response).toBe(status);
	expect(opened).not.toHaveBeenCalled();
	expect(app.callers).toEqual([]);
});

test("failed link options reject the handshake and report its hook failure", async () => {
	const failure = new Error("link policy unavailable");
	await using app = await fixture({
		options() {
			throw failure;
		},
	});
	const socket = app.connect();
	const status = await new Promise<number>((resolve, reject) => {
		socket.once("error", reject);
		socket.once("unexpected-response", (_request, reply) => {
			reply.resume();
			socket.terminate();
			resolve(reply.statusCode ?? 0);
		});
	});
	expect(status).toBe(403);
	expect(app.errors).toEqual([{ kind: "hook_failed", hook: "links.options", plugin: undefined, error: failure }]);
});

test("link payload overflow closes the peer and invokes its lifetime cleanup once", async () => {
	let closed = 0;
	await using app = await fixture({
		options: { maxPayload: 1024 },
		opened: () => () => {
			closed++;
		},
	});
	const socket = app.connect();
	await once(socket, "open");
	const ended = once(socket, "close");
	socket.send(new Uint8Array(2048));
	expect((await ended)[0]).toBe(1009);
	await vi.waitFor(() => expect(closed).toBe(1));
});

test("a protocol close is not forcibly terminated before its close frame is delivered", async () => {
	let forced = 0;
	await using app = await fixture(undefined, {
		maxPayload: 32,
		sockets: {
			"/limited": (socket) => {
				const terminate = socket.terminate.bind(socket);
				socket.terminate = () => {
					forced++;
					terminate();
				};
			},
		},
	});
	const socket = app.connect("/limited");
	await once(socket, "open");
	const closed = once(socket, "close");
	socket.send("x".repeat(64));
	expect((await closed)[0]).toBe(1009);
	expect(forced).toBe(0);
});

test("closing HTTP with an active object link closes its transport and releases its callback", async () => {
	let closed = 0;
	await using app = await fixture({
		opened: () => () => {
			closed++;
		},
	});
	const socket = app.connect();
	await once(socket, "open");
	const ended = once(socket, "close");
	await app.http.close(context);
	expect((await ended)[0]).toBe(1001);
	expect(closed).toBe(1);
});

test.each([false, true])(
	"socket heartbeats keep responsive peers and end silent peers, autoPong=%s",
	async (autoPong) => {
		await using app = await fixture(undefined, {
			sockets: {
				"/echo": (socket) => {
					socket.on("message", (data) => socket.send(data));
				},
			},
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const socket = app.connect("/echo", {}, autoPong);
		await once(socket, "open");
		const ping = once(socket, "ping");
		await vi.advanceTimersByTimeAsync(15000);
		await ping;
		if (autoPong) {
			const reply = once(socket, "message");
			socket.send("still alive");
			await reply;
			const next = once(socket, "ping");
			await vi.advanceTimersByTimeAsync(15000);
			await next;
			expect(socket.readyState).toBe(WebSocket.OPEN);
		} else {
			const ended = once(socket, "close");
			await vi.advanceTimersByTimeAsync(15000);
			expect((await ended)[0]).toBe(1006);
		}
		vi.useRealTimers();
	},
);

test("an opened-hook failure is reported while the accepted link still closes normally", async () => {
	const failure = new Error("lifetime callback failed");
	await using app = await fixture({
		opened() {
			throw failure;
		},
	});
	const socket = app.connect();
	await once(socket, "open");
	expect(app.errors).toEqual([{ kind: "hook_failed", hook: "links.opened", plugin: undefined, error: failure }]);
	const ended = once(socket, "close");
	socket.close();
	await ended;
});

test.each(["host", "relay"] as const)("removing an admitted %s revokes its active object link", async (authority) => {
	let closed = 0;
	const contribution: HttpContribution =
		authority === "host"
			? { hosts: ["allowed.example"] }
			: {
					relays: [{ name: "edge", verify: () => ({ origin: "https://relay.example" }) }],
				};
	await using app = await fixture(
		{
			opened: () => () => {
				closed++;
			},
		},
		contribution,
	);
	const headers =
		authority === "host"
			? { host: "allowed.example", origin: "https://allowed.example" }
			: {
					forwarded: "for=127.0.0.1;proto=https;host=relay.example",
					origin: "https://relay.example",
				};
	const socket = app.connect("/objects", headers);
	await once(socket, "open");
	const ended = once(socket, "close");
	await app.reload({});
	expect((await ended)[0]).toBe(1006);
	await vi.waitFor(() => expect(closed).toBe(1));
});

async function socketPair() {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
	const connected = once(server, "connection");
	const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
	const [peer] = await connected;
	if (!(peer instanceof WebSocket)) throw new Error("Expected a WebSocket peer");
	await once(client, "open");
	return {
		client,
		peer,
		async [Symbol.asyncDispose]() {
			client.terminate();
			for (const peer of server.clients) peer.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test("the bounded socket adapter forwards binary events and removes detached listeners", async () => {
	await using pair = await socketPair();
	const socket = limitedSocket(pair.peer),
		received: unknown[] = [];
	socket.binaryType = "arraybuffer";
	expect(socket.binaryType).toBe("arraybuffer");
	expect(socket.readyState).toBe(WebSocket.OPEN);
	const listener = (event: { readonly data: unknown }) => {
		received.push(event.data);
	};
	socket.addEventListener("message", listener);
	const first = once(pair.peer, "message");
	pair.client.send(new Uint8Array([1, 2, 3]));
	await first;
	expect(received).toEqual([new Uint8Array([1, 2, 3]).buffer]);
	socket.removeEventListener("message", listener);
	const second = once(pair.peer, "message");
	pair.client.send(new Uint8Array([4]));
	await second;
	expect(received).toHaveLength(1);
	const reply = once(pair.client, "message");
	socket.send(new Uint8Array([5, 6]));
	const [data, binary] = await reply;
	if (!(data instanceof Uint8Array)) throw new Error("Expected binary data");
	expect(binary).toBe(true);
	expect([...data]).toEqual([5, 6]);
	const ended = once(pair.peer, "close");
	socket.close();
	await ended;
	expect(socket.readyState).toBe(WebSocket.CLOSED);
	expect(() => socket.send(new Uint8Array([7]))).not.toThrow();
});

test("a slow peer cannot grow the adapter's queued output beyond its bounded allowance", async () => {
	await using pair = await socketPair();
	const socket = limitedSocket(pair.peer);
	pair.client.pause();
	const closed = once(pair.peer, "close");
	for (let index = 0; index < 64 && socket.readyState === WebSocket.OPEN; index++)
		socket.send(new Uint8Array(256 * 1024));
	expect(socket.readyState).not.toBe(WebSocket.OPEN);
	pair.client.resume();
	expect((await closed)[0]).toBe(1006);
});
