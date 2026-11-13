import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withTelemetry } from "../src/context/index.ts";
import { InMemoryTelemetryContext } from "@axi/telemetry";
import {
	constant,
	createHost,
	defineFacet,
	hostKind,
	int,
	local,
	memoryLinkPair,
	remote,
	str,
	type HostError,
} from "../src/index.ts";

it("reports a rejected route without evaluating the plugin error's stack", async () => {
	const Worker = hostKind("error.worker"),
		failure = new Error("worker unavailable");
	let stackReads = 0;
	Object.defineProperty(failure, "stack", {
		get() {
			stackReads++;
			throw new Error("stack not available");
		},
	});
	const Value = remote("error.value", {
		version: 1,
		params: {},
		hostAddress: () => Worker(),
		variants: { value: { state: { value: int() } } },
	});
	const reports: HostError[] = [],
		host = createHost({ principal: { kind: "service" }, onError: (error) => reports.push(error) });
	host.route(Worker, { authorize: () => true, resolve: () => Promise.reject(failure) }, context);
	try {
		await host.load([], context);
		const ref = host.hold(Value, {}, context);
		await vi.waitFor(() => expect(ref.state.value.kind).toBe("failed"));
		expect(reports).toHaveLength(1);
		const reported = reports[0]!;
		expect(reported.kind).toBe("resolve_failed");
		if (reported.kind === "resolve_failed") expect(reported.error).toBe(failure);
		expect(stackReads).toBe(0);
		ref.release();
	} finally {
		await host.close(context);
	}
});

it("calls an address callback without an internal receiver", async () => {
	const Server = hostKind("callback.server");
	const receivers: unknown[] = [];
	const Value = remote("callback.value", {
		version: 1,
		params: {},
		hostAddress(this: unknown) { receivers.push(this); return Server(); },
		variants: { value: { state: { value: int() } } },
	});
	const host = createHost({ address: Server(), principal: { kind: "service" }, onError() {} });
	try {
		await host.load([{ name: "value", facet: defineFacet((h) => h.serve(Value, () => ({
			variant: "value", members: { value: constant(3) },
		}))) }], context);
		const value = await host.get(Value, {}, context);
		value.release();
		expect(receivers).toEqual([undefined]);
	} finally {
		await host.close(context);
	}
});

it("links a shared route and hold to their first trigger, and a joining getter to the open hold", async () => {
	const Worker = hostKind("trace.worker");
	const Value = remote("trace.value", {
		version: 1, params: {}, hostAddress: () => Worker(),
		variants: { value: { state: { value: int() } } },
	});
	const telemetry = new InMemoryTelemetryContext();
	const host = createHost({ telemetry, principal: { kind: "service" }, onError() {} });
	const pending = Promise.withResolvers<never>();
	host.route(Worker, { authorize: () => true, resolve: () => pending.promise }, context);
	try {
		await host.load([], context);
		const first = await telemetry.startSpan({ name: "first" }, async (span) =>
			host.hold(Value, {}, withTelemetry(span, context)));
		await telemetry.startSpan({ name: "second" }, async (span) =>
			host.hold(Value, {}, withTelemetry(span, context)));
		pending.reject(new Error("worker unavailable"));
		await vi.waitFor(() => expect(first.state.value.kind).toBe("failed"));
		const spans = telemetry.getSpans();
		const route = spans.find((span) => span.name === "objects.resolve")!;
		expect(route.links).toHaveLength(1);
		const waiting = spans.filter((span) => span.name === "objects.hold");
		expect(waiting).toHaveLength(1);
		expect(route.links[0]!.context).toEqual(waiting[0]!.context);
		const firstGetter = spans.find(span => span.name === "first")!;
		const secondGetter = spans.find(span => span.name === "second")!;
		expect(waiting[0]!.parentId).toBeNull();
		expect(waiting[0]!.links.map(link => link.context)).toEqual([firstGetter.context, route.context]);
		expect(secondGetter.links.map(link => link.context)).toEqual([waiting[0]!.context]);
	} finally {
		pending.reject(new Error("test ended"));
		await host.close(context);
	}
});

it("keeps an explicitly anonymous root anonymous and limits it to local objects", async () => {
	const Value = local("root.local", { version: 1, params: {}, members: { value: int() } });
	const Server = hostKind("server");
	const Shared = remote("root.shared", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { value: { state: { value: int() }, methods: {} } },
	});
	const host = createHost({ address: Server(), principal: { kind: "service" }, onError() {} });
	await host.load(
		[
			{
				name: "core",
				facet: defineFacet((h) => {
					h.serve(Value, () => ({ value: constant(7) }));
					h.serve(Shared, () => ({ variant: "value", members: { value: constant(9) } }));
				}),
			},
		],
		context,
	);
	try {
		expect(await host.root(async (ctx) => ctx.principal, context)).toEqual({ kind: "service" });
		await host.root(
			async (ctx) => {
				expect(ctx.principal).toBeUndefined();
				expect((await ctx.get(Value, {})).value.value).toBe(7);
				await expect(ctx.get(Shared, {})).rejects.toMatchObject({ code: "forbidden" });
			},
			context,
			{ principal: undefined },
		);
	} finally {
		await host.close(context);
	}
});

it("retries a failed route only on demand and can suspend new holders until retry", async () => {
	const Worker = hostKind("runner", { id: str() });
	const address = Worker({ id: "one" });
	const Value = remote("route.value", {
		version: 1,
		params: {},
		hostAddress: () => address,
		variants: { value: { state: { value: int() }, methods: {} } },
	});
	const host = createHost({ principal: { kind: "service" }, onError() {} });
	const worker = createHost({ principal: { kind: "service" }, address, onError() {} });
	await worker.load(
		[
			{
				name: "core",
				facet: defineFacet((h) => h.serve(Value, () => ({ variant: "value", members: { value: constant(12) } }))),
			},
		],
		context,
	);
	let attempts = 0;
	const controls = host.route(
		Worker,
		{
			authorize: () => true,
			async resolve() {
				if (++attempts === 1) throw new Error("worker not started");
				const [link, peer] = memoryLinkPair();
				worker.accept(peer, { principal: { kind: "service" }, trusted: true }, context);
				return { link, principal: { kind: "service" }, trusted: true };
			},
		},
		context,
	);
	await host.load([], context);
	const first = host.hold(Value, {}, context);
	let second: ReturnType<typeof host.hold<typeof Value>> | undefined;
	try {
		await vi.waitFor(() => expect(first.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } }));
		controls.suspend(address);
		const following = host.hold(Value, {}, context);
		second = following;
		await vi.waitFor(() =>
			expect(following.state.value).toMatchObject({
				kind: "failed",
				cause: { error: { message: "runner|one: suspended" } },
			}),
		);
		expect(attempts).toBe(1);
		controls.retry(address);
		await vi.waitFor(() => expect(first.state.value).toEqual({ kind: "live" }));
		expect((await host.get(Value, {}, context)).value.value).toBe(12);
		expect(attempts).toBe(2);
	} finally {
		first.release();
		second?.release();
		await host.close(context);
		await worker.close(context);
	}
});
