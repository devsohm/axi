import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, awaitWithContext, withAbortSignal } from "../src/context/index.ts";
import {
	binaryCodec,
	createHost,
	defineFacet,
	defineState,
	hostKind,
	int,
	memoryLinkPair,
	method,
	obj,
	ObjectsError,
	PluginError,
	remote,
	str,
	textCodec,
	type Link,
} from "../src/index.ts";

test.each([binaryCodec, textCodec])(
	"%s captures plugin error details once before sending a failed call",
	async (codec) => {
		const Service = hostKind("errors.snapshot-service");
		const Failure = remote("errors.snapshot-call", {
			version: 1,
			params: {},
			hostAddress: () => Service(),
			variants: { ready: { methods: { fail: method(undefined, int()) } } },
		});
		const reports: unknown[] = [];
		const server = createHost({
			address: Service(),
			principal: { kind: "server" },
			onError: (error) => reports.push(error),
		});
		const client = createHost({ principal: { kind: "client" }, onError: (error) => reports.push(error) });
		let reads = 0;
		try {
			await server.load(
				[
					{
						name: "failure",
						facet: defineFacet((facet) =>
							facet.serve(Failure, () => ({
								variant: "ready",
								members: {
									async fail() {
										const error = new PluginError("retry", "Try this call again");
										Object.defineProperty(error, "details", { get: () => ({ sample: ++reads }) });
										throw error;
									},
								},
							})),
						),
					},
				],
				context,
			);
			await client.load([], context);
			const [incoming, outgoing] = memoryLinkPair();
			server.accept(incoming, { principal: { kind: "client" }, codec }, context);
			client.connect(outgoing, { principal: { kind: "server" }, codec }, context);
			const reference = await client.get(Failure, {}, context);
			try {
				await expect(reference.fail(context)).rejects.toMatchObject({
					code: "retry",
					message: "Try this call again",
					details: { sample: 1 },
				});
				expect(reads).toBe(1);
				expect(reports).toEqual([]);
			} finally {
				reference.release();
			}
		} finally {
			await client.close(context);
			await server.close(context);
		}
	},
);

async function network(relayed: boolean) {
	const Service = hostKind("lifecycle.remote-service"),
		address = Service();
	const Counter = remote("lifecycle.remote-counter", {
		version: 1,
		params: {},
		hostAddress: () => address,
		variants: {
			ready: {
				state: { total: int() },
				methods: {
					add: method(int(), int()),
					pause: method(int(), int()),
					denied: method(undefined, int()),
					length: method(str(), int()),
				},
			},
		},
	});
	const State = defineState("lifecycle.remote-state", {
		version: 1,
		schema: obj({ total: int() }),
		initial: () => ({ total: 0 }),
	});
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>(),
		cancelled = Promise.withResolvers<void>();
	const errors: unknown[] = [],
		principals: unknown[] = [];
	const server = createHost({
		address,
		principal: { kind: "server" },
		revokedBy: (principal) => [principal.kind],
		onError: (error) => errors.push(error),
	});
	const client = createHost({ principal: { kind: "client" }, onError: (error) => errors.push(error) });
	const relay = createHost({ principal: { kind: "relay" }, onError: (error) => errors.push(error) });
	await server.load(
		[
			{
				name: "counter",
				facet: defineFacet((facet) =>
					facet.serve(Counter, (_params, principal, self) => {
						principals.push(principal);
						const state = self.state(State);
						return {
							variant: "ready",
							members: {
								total: self.derive([state], ([current]) => current.total),
								add: async (amount, ctx) => {
									await state.change((draft) => {
										draft.total += amount;
									}, ctx);
									return state.value.total;
								},
								pause: async (value, ctx) => {
									entered.resolve();
									ctx.abortSignal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
									await awaitWithContext(release.promise, ctx);
									return value;
								},
								denied: async () => {
									throw new ObjectsError({ code: "forbidden", message: "Policy denied this call" });
								},
								length: async (value) => value.length,
							},
						};
					}),
				),
			},
		],
		context,
	);
	let link: Link | undefined;
	const route = relay.route(
		Service,
		{
			authorize: () => true,
			async resolve() {
				const [incoming, outgoing] = memoryLinkPair();
				link = incoming;
				server.connect(incoming, { principal: { kind: "relay" }, trusted: true }, context);
				return { link: outgoing, principal: { kind: "server" }, trusted: true };
			},
		},
		context,
	);
	await relay.load([], context);
	await client.load([], context);
	const connect = () => {
		if (relayed) {
			route.retry(address);
			return;
		}
		const [incoming, outgoing] = memoryLinkPair();
		server.accept(incoming, { principal: { kind: "client" } }, context);
		client.connect(outgoing, { principal: { kind: "server" }, trusted: true }, context);
		link = outgoing;
	};
	if (!relayed) connect();
	if (relayed) {
		const [incoming, outgoing] = memoryLinkPair();
		relay.accept(incoming, { principal: { kind: "client" } }, context);
		client.connect(outgoing, { principal: { kind: "relay" }, trusted: true }, context);
	}
	return {
		server,
		client,
		Counter,
		connect,
		principals,
		errors,
		entered,
		cancelled,
		disconnect() {
			if (!link) throw new Error("No established transport");
			if (relayed) route.suspend(address);
			link.close();
		},
		async close() {
			release.resolve();
			await client.close(context);
			await relay.close(context);
			await server.close(context);
		},
	};
}

test.each([false, true])(
	"remote cancellation releases a running call and leaves other methods usable, relay: %s",
	async (relayed) => {
		const app = await network(relayed);
		try {
			const ref = await app.client.get(app.Counter, {}, context),
				controller = new AbortController();
			const pending = Promise.allSettled([ref.pause(42, withAbortSignal(controller.signal, context))]);
			await app.entered.promise;
			controller.abort();
			expect(await pending).toMatchObject([{ status: "rejected" }]);
			await app.cancelled.promise;
			expect(await ref.add(3, context)).toBe(3);
			await vi.waitFor(() => expect(ref.total.value).toBe(3));
			await expect(ref.denied(context)).rejects.toMatchObject({
				code: "forbidden",
				message: "Policy denied this call",
			});
			expect(app.principals).toEqual([{ kind: "client" }]);
			ref.release();
			await expect(ref.add(1, context)).rejects.toMatchObject({ code: "released" });
		} finally {
			await app.close();
		}
	},
);

test.each([false, true])(
	"remote references rebind to a fresh transient object after a transport reconnect, relay: %s",
	async (relayed) => {
		const app = await network(relayed);
		try {
			const ref = await app.client.get(app.Counter, {}, context);
			expect(await ref.add(7, context)).toBe(7);
			app.disconnect();
			await vi.waitFor(() =>
				expect(ref.state.value).toMatchObject(
					relayed ? { kind: "failed", cause: { kind: "waiting" } } : { kind: "loading" },
				),
			);
			app.connect();
			await vi.waitFor(() => expect(ref.state.value.kind).toBe("live"));
			expect(ref.total.value).toBe(0);
			expect(await ref.add(2, context)).toBe(2);
			await vi.waitFor(() => expect(ref.total.value).toBe(2));
			ref.release();
			expect(app.errors).toEqual([]);
		} finally {
			await app.close();
		}
	},
);

test("revoking a caller ends its relayed object and aborts its active call", async () => {
	const app = await network(true);
	try {
		const ref = await app.client.get(app.Counter, {}, context);
		const pending = Promise.allSettled([ref.pause(4, context)]);
		await app.entered.promise;
		app.server.revoke("client", context);
		await app.cancelled.promise;
		expect(await pending).toMatchObject([{ status: "rejected", reason: { code: "forbidden" } }]);
		await vi.waitFor(() => expect(ref.state.value.kind).toBe("ended"));
		await expect(ref.add(1, context)).rejects.toMatchObject({ code: "forbidden" });
		ref.release();
	} finally {
		await app.close();
	}
});
