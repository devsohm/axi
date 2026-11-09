import { expect, it } from "vitest";
import { type AuthProvider, StreamableHttpTransport, isJsonRpcResponse } from "../src/index.ts";
import { InMemoryTransport } from "../src/testing/index.ts";

it("captures cancellation before request serialization can change the options", async () => {
	const options = { signal: AbortSignal.abort() };
	let dispatched = 0;
	const transport = new StreamableHttpTransport({
		url: "https://example.test/mcp",
		fetch: async () => {
			dispatched++;
			return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
		},
	});
	try {
		await transport.start();
		await expect(
			transport.send(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "read",
					params: {
						toJSON() {
							options.signal = new AbortController().signal;
							return {};
						},
					},
				},
				options,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(dispatched).toBe(0);
	} finally {
		await transport.close();
	}
});

it("stops dispatch when cancellation arrives during header preparation", async () => {
	const controller = new AbortController();
	let dispatched = 0;
	const transport = new StreamableHttpTransport({
		url: "https://issuer.example.test/mcp",
		authProvider: {
			async token() {
				queueMicrotask(() => queueMicrotask(() => controller.abort()));
				return "local";
			},
		},
		async fetch() {
			dispatched++;
			return new Response(null, { status: 202 });
		},
	});
	try {
		await transport.start();
		await expect(
			transport.send({ jsonrpc: "2.0", method: "notice" }, { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(dispatched).toBe(0);
	} finally {
		await transport.close();
	}
});

it("does not inspect an authorization challenge without a recovery handler", async () => {
	let reads = 0;
	class Forbidden extends Response {
		override get headers(): Headers {
			reads++;
			return super.headers;
		}
	}
	const transport = new StreamableHttpTransport({
		url: "https://issuer.example.test/mcp",
		fetch: async () => new Forbidden("denied", { status: 403 }),
	});
	try {
		await transport.start();
		await expect(transport.send({ jsonrpc: "2.0", method: "notice" })).rejects.toMatchObject({ status: 403 });
		expect(reads).toBe(0);
	} finally {
		await transport.close();
	}
});

it("reports listener removal and ignores absent response error fields", () => {
	const transport = new InMemoryTransport();
	for (const dispose of [transport.onMessage(() => {}), transport.onError(() => {}), transport.onClose(() => {})]) {
		expect(dispose()).toBe(true);
		expect(dispose()).toBe(false);
	}
	const message = new Proxy(
		{ jsonrpc: "2.0", id: 1 },
		{
			get(target, key) {
				return key === "error" ? { code: 1, message: "phantom" } : Reflect.get(target, key);
			},
		},
	);
	expect(isJsonRpcResponse(message)).toBe(false);
});

it.each(["initial-token", ""])("retains request authorization context for token %j", async (token) => {
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const callbacks: { handler: string; token: string | undefined; receiver: boolean }[] = [];
	const provider: AuthProvider = {
		async token() {
			await waiting;
			return token;
		},
		async onUnauthorized(context) {
			callbacks.push({ handler: "initial", token: context.token, receiver: this === provider });
		},
	};
	let requests = 0;
	const transport = new StreamableHttpTransport({
		url: "https://example.test/mcp",
		openGetStream: false,
		authProvider: provider,
		async fetch() {
			return new Response(null, { status: ++requests === 1 ? 401 : 202 });
		},
	});
	try {
		await transport.start();
		const sending = transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		provider.onUnauthorized = async function (context) {
			callbacks.push({ handler: "changed", token: context.token, receiver: this === provider });
		};
		release();
		await sending;
		expect(requests).toBe(2);
		expect(callbacks).toStrictEqual([{ handler: "initial", token: token || undefined, receiver: true }]);
	} finally {
		await transport.close();
	}
});
