import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	createHost,
	constant,
	defineFacet,
	defineState,
	hostKind,
	int,
	local,
	memoryLinkPair,
	method,
	obj,
	remote,
	sleep,
	type HostError,
} from "../src/index.ts";
const count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

it("reports a removed provider once and recovers the same member watch when it returns", async () => {
	const type = local("sample.removed-value", { version: 1, params: {}, members: { n: int() } });
	const host = createHost({ onError(error) { throw error } }), frames: string[] = [];
	const provider = (n: number) => [{ name: "value", facet: defineFacet(h => h.serve(type, () => ({ n: constant(n) }))) }];
	try {
		await host.load(provider(1), context);
		const ref = await host.get(type, {}, context), watch = await ref.n.watch(context);
		watch.start(async call => { frames.push(call.kind) });
		await host.reload([], context);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect([ref.n.value, frames]).toEqual([1, ["failed"]]);
		await host.reload(provider(2), context);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect([ref.n.value, frames]).toEqual([2, ["failed", "value"]]);
		ref.release();
	} finally { await host.close(context) }
});

it("moves references to a reloaded provider together before publishing derived values", async () => {
	const value = local("sample.reload-value", { version: 1, params: {}, members: { n: int() } });
	const sum = local("sample.reload-sum", { version: 1, params: {}, members: { n: int() } });
	const errors: HostError[] = [], host = createHost({ onError: error => errors.push(error) });
	const provider = (n: number) => defineFacet(h => h.serve(value, () => ({ n: constant(n) })));
	const consumer = defineFacet(h => h.serve(sum, (_, self) => {
		const a = self.get(value, {}), b = self.get(value, {});
		return { n: self.derive([a.n, b.n], ([a, b]) => {
			if (a !== b) throw new Error("inconsistent references");
			return a + b;
		}) };
	}));
	try {
		await host.load([{ name: "value", facet: provider(1) }, { name: "sum", facet: consumer }], context);
		const ref = await host.get(sum, {}, context), watch = await ref.n.watch(context);
		watch.start(async () => {});
		await host.reload([{ name: "value", facet: provider(2) }, { name: "sum", facet: consumer }], context);
		await vi.waitFor(() => expect(ref.n.value).toBe(4));
		expect(errors).toEqual([]);
		ref.release();
	} finally { await host.close(context) }
});

it("rejects a method absent from the active variant before checking its arguments", async () => {
	const address = hostKind("sample.method-order.host")();
	const type = remote("sample.method-order", { version: 1, params: {}, hostAddress: () => address,
		variants: { reader: {}, writer: { methods: { put: method(int(), int()) } } } });
	const host = createHost({ address, principal: { kind: "server" }, onError(error) { throw error } });
	try {
		await host.load([{ name: "sample", facet: defineFacet(h => h.serve(type, () => ({ variant: "reader", members: {} }))) }], context);
		const ref = await host.get(type, {}, context);
		for (const value of [2, "invalid"]) {
			await expect(Reflect.get(ref, "put")(value, context)).rejects.toMatchObject({ code: "invalid", reason: "member" });
		}
		ref.release();
	} finally { await host.close(context) }
});

it("keeps a member watch pending through its provider's initial failure", async () => {
	const address = hostKind("sample.waiting")(), principal = { kind: "server" };
	const type = remote("sample.waiting.counter", { version: 1, params: {}, hostAddress: () => address,
		variants: { main: { state: { count: obj({ n: int() }) } } } });
	const server = createHost({ address, principal, onError: () => {} }),
		client = createHost({ onError: () => {} }), failed = Promise.withResolvers<void>();
	let available = false;
	try {
		await server.load([{ name: "sample", facet: defineFacet((h) => h.serve(type, (_params, _principal, self) => {
			if (!available) throw new Error("not ready");
			return { variant: "main", members: { count: self.state(count) } };
		})) }], context);
		await client.load([], context);
		const ref = client.hold(type, {}, context), states = await ref.state.watch(context);
		states.start(async (call) => { if (call.kind === "value" && call.value.kind === "failed") failed.resolve(); });
		let settled = false;
		const pending = ref.count.watch(context).then((watch) => { settled = true; return watch; },
			() => { settled = true; return undefined; });
		const [up, down] = memoryLinkPair();
		server.accept(up, { principal: { kind: "client" } }, context);
		client.connect(down, { principal }, context);
		await failed.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		available = true;
		ref.retry();
		expect((await pending)?.value).toEqual({ n: 0 });
	} finally { await client.close(context); await server.close(context); }
});

it("publishes declared state before resolving a waiting get and commits its derived value with it", async () => {
	const type = local("sample.counter", {
		version: 1,
		params: {},
		members: { count: obj({ n: int() }), doubled: int(), add: method(int(), int()) },
	});
	const errors: HostError[] = [],
		host = createHost({ onError: (error) => errors.push(error) });
	try {
		const loading = host.load(
			[
				{
					name: "sample",
					facet: defineFacet((h) =>
						h.serve(type, (_, self) => {
							const value = self.state(count);
							return {
								count: value,
								doubled: self.derive([value], ([state]) => state.n * 2),
								add: (amount, ctx) =>
									self.tx(async (tx) => {
										const draft = await tx.draft(value);
										draft.n += amount;
										return draft.n;
									}, ctx),
							};
						}),
					),
				},
			],
			context,
		);
		const waiting = host.get(type, {}, context);
		await loading;
		const ref = await waiting;
		expect([ref.count.value, ref.doubled.value]).toEqual([{ n: 0 }, 0]);
		expect(await ref.add(4, context)).toBe(4);
		expect([ref.count.value, ref.doubled.value]).toEqual([{ n: 4 }, 8]);
		await expect(ref.add(1.5, context)).rejects.toMatchObject({ code: "invalid", reason: "args" });
		expect(ref.count.value).toEqual({ n: 4 });
		ref.release();
	} finally {
		await host.close(context);
	}
	expect(errors).toEqual([]);
});

it("stamps a remote caller and rebinds after a disconnect without replaying an interrupted call", async () => {
	const address = hostKind("sample.server")(),
		principal = { kind: "owner" },
		guest = { kind: "guest" };
	const type = remote("sample.remote", {
		version: 1,
		params: {},
		hostAddress: () => address,
		variants: { main: { state: { count: obj({ n: int() }) }, methods: { add: method(int(), int()), wait: method() } } },
	});
	const callers: unknown[] = [],
		started = Promise.withResolvers<void>(),
		errors: HostError[] = [];
	let calls = 0;
	const server = createHost({ address, principal, onError: (error) => errors.push(error) }),
		client = createHost({ onError: (error) => errors.push(error) });
	await server.load(
		[
			{
				name: "sample",
				facet: defineFacet((h) =>
					h.serve(
						type,
						(_params, identity, self) => {
							callers.push(identity);
							const value = self.state(count);
							return {
								variant: "main",
								members: {
									count: value,
									add: (amount, ctx) =>
										self.tx(async (tx) => {
											const draft = await tx.draft(value);
											draft.n += amount;
											return draft.n;
										}, ctx),
									wait: async (ctx) => {
										calls++;
										started.resolve();
										await sleep(60000, ctx);
										return null;
									},
								},
							};
						},
						{ linger: 1000 },
					),
				),
			},
		],
		context,
	);
	await client.load([], context);
	const connect = () => {
		const [inbound, outbound] = memoryLinkPair();
		server.accept(inbound, { principal: guest }, context);
		client.connect(outbound, { principal }, context);
		return outbound;
	};
	let transport = connect();
	try {
		const ref = await client.get(type, {}, context);
		expect(await ref.add(3, context)).toBe(3);
		const frames: unknown[] = [], countWatch = await ref.count.watch(context);
		countWatch.start(async (call) => { frames.push(call); });
		const interrupted = expect(ref.wait(context)).rejects.toMatchObject({ code: "unavailable" });
		await started.promise;
		transport.close();
		await interrupted;
		expect(ref.state.value.kind).toBe("loading");
		const next = ref.add(2, context);
		transport = connect();
		expect(await next).toBe(5);
		expect(ref.count.value).toEqual({ n: 5 });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(frames).toEqual([{ kind: "value", value: { n: 5 }, ops: [["s", ["n"], 5]], retired: false }]);
		expect(callers).toEqual([guest]);
		expect(calls).toBe(1);
		ref.release();
	} finally {
		transport.close();
		await client.close(context);
		await server.close(context);
	}
	expect(errors).toEqual([]);
});

it("releases failed object instances even when an application retains their reports", () => {
	const fixture = fileURLToPath(new URL("./fixtures/collect-failed-object.ts", import.meta.url));
	const result = spawnSync(process.execPath, ["--expose-gc", fixture], { encoding: "utf8", timeout: 10000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
}, 15000);
