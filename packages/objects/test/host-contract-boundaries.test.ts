import { InMemoryTelemetryContext } from "@axi/telemetry";
import { expect, test, vi } from "vitest";
import {
	BACKGROUND_CONTEXT as context,
	createContextKey,
	withAbortSignal,
	withContextValue,
} from "../src/context/index.ts";
import {
	constant,
	createHost,
	defineFacet,
	defineRegistry,
	hostKind,
	int,
	local,
	memoryLinkPair,
	remote,
	str,
	type HostError,
} from "../src/index.ts";

test.each(["", "Bad Name", "../escape", "line\nbreak"])(
	"invalid plugin name %j leaves the host available for a valid load",
	async (name) => {
		let activated = false;
		const host = createHost({ onError() {} });
		try {
			await expect(
				host.load(
					[
						{
							name,
							facet: defineFacet(() => {
								activated = true;
							}),
						},
					],
					context,
				),
			).rejects.toThrow("not a valid plugin name");
			expect(activated).toBe(false);
			expect(await host.load([], context)).toEqual({ failed: [] });
		} finally {
			await host.close(context);
		}
	},
);

test("duplicate plugin names retain the first provider and report the second without activating it", async () => {
	const Value = local("boundary.duplicate", { version: 1, params: {}, members: { n: int() } });
	let secondActivated = false;
	const host = createHost({ onError() {} });
	try {
		const result = await host.load(
			[
				{ name: "value", facet: defineFacet((h) => h.serve(Value, () => ({ n: constant(7) }))) },
				{
					name: "value",
					facet: defineFacet(() => {
						secondActivated = true;
					}),
				},
			],
			context,
		);
		expect(result.failed).toMatchObject([{ plugin: "value", error: { message: 'plugin "value" is loaded twice' } }]);
		expect(secondActivated).toBe(false);
		const ref = await host.get(Value, {}, context);
		expect(ref.n.value).toBe(7);
		ref.release();
	} finally {
		await host.close(context);
	}
});

test("routes cannot be declared twice or after publication", async () => {
	const host = createHost({ onError() {} }),
		kind = hostKind("boundary.route");
	const options = {
		authorize: () => true,
		resolve: async () => {
			throw new Error("No resolution expected");
		},
	};
	try {
		host.route(kind, options, context);
		expect(() => host.route(kind, options, context)).toThrow("routed already");
		await host.load([], context);
		expect(() => host.route(hostKind("boundary.late"), options, context)).toThrow("declared before load");
	} finally {
		await host.close(context);
	}
});

test("reference presence includes existing holders, filters contract types and removes released holders", async () => {
	const Value = local("boundary.presence", { version: 1, params: { id: str() }, members: { n: int() } });
	const Other = local("boundary.other", { version: 1, params: {}, members: { n: int() } });
	const errors: HostError[] = [];
	const host = createHost({ onError: (error) => errors.push(error) });
	try {
		await host.load(
			[
				{
					name: "values",
					facet: defineFacet((h) => {
						h.serve(Value, () => ({ n: constant(1) }));
						h.serve(Other, () => ({ n: constant(2) }));
					}),
				},
			],
			context,
		);
		const one = await host.get(Value, { id: "one" }, context),
			two = await host.get(Value, { id: "two" }, context),
			other = await host.get(Other, {}, context);
		try {
			const presence = host.references(Value);
			expect(presence.value.map((entry) => entry.params.id).sort()).toEqual(["one", "two"]);
			expect(host.references(Value)).toBe(presence);
			const watch = await presence.watch(context);
			watch.start(async () => {});
			try {
				one.release();
				await vi.waitFor(() => expect(watch.value.map((entry) => entry.params.id)).toEqual(["two"]));
			} finally {
				await watch.stop();
			}
		} finally {
			one.release();
			two.release();
			other.release();
		}
		expect(errors).toEqual([]);
	} finally {
		await host.close(context);
	}
});

test("releasing an external reference publishes the failure of a derive that follows it", async () => {
	const Value = local("boundary.external", { version: 1, params: {}, members: { n: int() } });
	const Reader = local("boundary.reader", { version: 1, params: {}, members: { doubled: int() } });
	const values = { name: "values", facet: defineFacet((h) => h.serve(Value, () => ({ n: constant(3) }))) };
	const host = createHost({ onError() {} });
	try {
		await host.load([values], context);
		const source = await host.get(Value, {}, context);
		await host.reload(
			[
				values,
				{
					name: "reader",
					facet: defineFacet((h) =>
						h.serve(Reader, (_, self) => ({ doubled: self.derive([source.n], ([n]) => n * 2) })),
					),
				},
			],
			context,
		);
		const reader = await host.get(Reader, {}, context);
		const watch = await reader.doubled.watch(context),
			frames: unknown[] = [];
		watch.start(async (frame) => {
			frames.push(frame);
		});
		expect(watch.value).toBe(6);
		source.release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(frames).toEqual([
			expect.objectContaining({ kind: "failed", error: expect.objectContaining({ code: "released" }) }),
		]);
		expect(reader.state.value.kind).toBe("live");
		expect(() => reader.doubled.value).toThrow(expect.objectContaining({ code: "released" }));
		await watch.stop();
		reader.release();
	} finally {
		await host.close(context);
	}
});

test.each(["success", "failure", "abort"])("root and nested traces preserve caller context on %s", async (outcome) => {
	const telemetry = new InMemoryTelemetryContext(),
		key = createContextKey<string>("request"),
		controller = new AbortController();
	const invocation = withAbortSignal(controller.signal, withContextValue(key, "request-7", context));
	const Value = local("boundary.traced", { version: 1, params: {}, members: { n: int() } });
	const principal = { kind: "client", id: "one" },
		host = createHost({ telemetry, principal, onError() {} });
	const failure = new Error("Trace failed");
	try {
		await host.load(
			[{ name: "value", facet: defineFacet((h) => h.serve(Value, () => ({ n: constant(42) }))) }],
			context,
		);
		const result = host.root(
			async (root) =>
				root.trace("inner", { action: "read" }, async (nested) =>
					nested.trace("nested", {}, async (ctx) => {
						expect(ctx.principal).toEqual(principal);
						expect(ctx.incarnation).toBe(host.incarnation);
						expect(ctx.value(key)).toBe("request-7");
						expect(ctx.toString()).toContain("Trace");
						expect(ctx.abortSignal?.aborted).toBe(false);
						const ref = await ctx.get(Value, {});
						expect(ref.n.value).toBe(42);
						if (outcome === "abort") controller.abort(failure);
						if (outcome !== "success") throw failure;
						return ref.n.value;
					}),
				),
			invocation,
			{ trace: { name: "root", attributes: { operation: "read" } } },
		);
		if (outcome === "success") expect(await result).toBe(42);
		else await expect(result).rejects.toBe(failure);
		await vi.waitFor(() =>
			expect(
				telemetry
					.getSpans()
					.filter((span) => ["root", "inner", "nested"].includes(span.name))
					.every((span) => span.settled),
			).toBe(true),
		);
		const spans = telemetry.getSpans().filter((span) => ["root", "inner", "nested"].includes(span.name));
		expect(spans.map((span) => span.name)).toEqual(["root", "inner", "nested"]);
		expect(spans.map((span) => span.status.status)).toEqual(Array(3).fill(outcome === "failure" ? "error" : "ok"));
		expect(spans[1]?.parentId).toBe(spans[0]?.id);
		expect(spans[2]?.parentId).toBe(spans[1]?.id);
	} finally {
		await host.close(context);
	}
});

test("principal attributes use the configured mapper and omit anonymous callers", async () => {
	const host = createHost<{ kind: "client"; id: string }>({
		onError() {},
		principalAttributes: (principal) => ({ account: principal.id }),
	});
	const defaultHost = createHost({ onError() {} });
	try {
		expect(host.principalAttributes(undefined, context)).toEqual({});
		expect(host.principalAttributes({ kind: "client", id: "one" }, context)).toEqual({ account: "one" });
		expect(defaultHost.principalAttributes({ kind: "client", id: "one" }, context)).toEqual({
			"objects.principal": '{"id":"one","kind":"client"}',
		});
	} finally {
		await host.close(context);
		await defaultHost.close(context);
	}
});

test("missing registries time out and host closure interrupts a pending registry read", async () => {
	const Missing = defineRegistry<number, number>("boundary.missing", { version: 1 });
	const host = createHost({ onError() {} });
	try {
		await host.load([], context);
		await expect(host.registry(Missing, context, { readyTimeout: 5 })).rejects.toMatchObject({ code: "unavailable" });
		const pending = expect(host.registry(Missing, context)).rejects.toMatchObject({
			code: "released",
			reason: "closed",
		});
		await host.close(context);
		await pending;
	} finally {
		await host.close(context);
	}
});

test("a waiting registry read resolves when its provider arrives after publication", async () => {
	const Total = defineRegistry<number, number>("boundary.total", { version: 1 });
	const host = createHost({ onError() {} });
	try {
		await host.load([], context);
		const pending = host.registry(Total, context, { readyTimeout: 2000 });
		await host.reload(
			[
				{
					name: "total",
					facet: defineFacet((h, self) => {
						h.serve(Total, { compose: (entries) => entries.reduce((sum, entry) => sum + entry.value, 0) });
						self.contribute(Total, 7);
					}),
				},
			],
			context,
		);
		expect((await pending).value).toBe(7);
	} finally {
		await host.close(context);
	}
});

test("an open parent link cannot be replaced by a second connection", async () => {
	const address = hostKind("boundary.parent")();
	const Value = remote("boundary.remote", {
		version: 1,
		params: {},
		hostAddress: () => address,
		variants: { ready: { state: { n: int() } } },
	});
	const parent = createHost({ address, principal: { kind: "server" }, onError() {} }),
		client = createHost({ onError() {} });
	const [first, peer] = memoryLinkPair(),
		[second, spare] = memoryLinkPair();
	try {
		await parent.load(
			[
				{
					name: "value",
					facet: defineFacet((h) => h.serve(Value, () => ({ variant: "ready", members: { n: constant(7) } }))),
				},
			],
			context,
		);
		await client.load([], context);
		parent.accept(peer, { principal: { kind: "client" } }, context);
		client.connect(first, { principal: { kind: "server" } }, context);
		const ref = await client.get(Value, {}, context, { readyTimeout: 2000 });
		try {
			expect(() => client.connect(second, { principal: { kind: "server" } }, context)).toThrow("open parent link");
			expect(ref.n.value).toBe(7);
		} finally {
			ref.release();
		}
	} finally {
		second.close();
		spare.close();
		await client.close(context);
		await parent.close(context);
	}
});
