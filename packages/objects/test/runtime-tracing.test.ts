import { expect, it, vi } from "vitest";
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT, NOOP_TELEMETRY_METRICS } from "@axi/telemetry";
import { BACKGROUND_CONTEXT as context, withTelemetry } from "../src/context/index.ts";
import { createHost, defineFacet, defineState, int, local, method, obj, str, remote, hostKind, memoryLinkPair, ObjectsError } from "../src/index.ts";

it("reuses described metric instruments while validating and changing state", async () => {
	const counter = vi.fn(NOOP_TELEMETRY_METRICS.counter);
	const telemetry = { ...NOOP_TELEMETRY_CONTEXT, metrics: { ...NOOP_TELEMETRY_METRICS, counter } };
	const measured = withTelemetry(telemetry, context);
	const Value = local("metric.counter", { version: 1, params: {}, members: { value: int(), add: method(int(), int()) } });
	const State = defineState("counter", { version: 1, schema: obj({ value: int() }), initial: () => ({ value: 0 }) });
	const host = createHost({ telemetry, onError(error) { throw error; } });
	try {
		await host.load([{ name: "counter", facet: defineFacet(h => h.serve(Value, (_, self) => {
			const state = self.state(State);
			return {
				value: self.derive([state], ([current]) => current.value),
				add: async (amount, ctx) => {
					await state.change(draft => { draft.value += amount; }, ctx);
					return state.value.value;
				},
			};
		})) }], measured);
		const ref = await host.get(Value, {}, measured);
		await ref.add(1, measured);
		expect(await ref.add(2, measured)).toBe(3);
		ref.release();
	} finally {
		await host.close(measured);
	}
	const names = counter.mock.calls.map(([name]) => name);
	expect(names).toContain("objects.data.validations");
	expect(names).toHaveLength(new Set(names).size);
	for (const [, options] of counter.mock.calls)
		expect(options).toHaveProperty("description", expect.any(String));
});

it.each(["source-fails", "retry", "aborted-error"] as const)("records routine retry events and links for %s", async (mode) => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const telemetry = new InMemoryTelemetryContext(), errors: string[] = [];
	const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
	const Value = local("trace.routine", { version: 1, params: {}, members: { value: obj({ n: int() }), set: method(int(), int()) } });
	const State = defineState("value", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 0 }) });
	const host = createHost({ telemetry, onError(error) { errors.push(error.kind); } });
	let calls = 0;
	try {
		await host.load([{ name: "value", facet: defineFacet((h) => h.serve(Value, (_, self) => {
			const value = self.state(State);
			const derived = self.derive([value], ([state]) => {
				if (state.n < 0) throw new Error("source failed");
				return state.n;
			});
			self.on(derived, async ({ value: n }) => {
				if (n !== 1) return;
				calls++;
				entered.resolve();
				if (mode === "source-fails") { await gate.promise; throw new Error("routine rejected"); }
				if (calls === 1) throw mode === "aborted-error"
					? new ObjectsError({ code: "aborted", message: "routine cancelled" })
					: new Error("routine rejected");
			});
			return { value, set: async (n, ctx) => { await value.change((draft) => { draft.n = n; }, ctx); return n; } };
		})) }], context);
		const ref = await host.get(Value, {}, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await telemetry.startSpan({ name: "write" }, (span) => ref.set(1, withTelemetry(span, context)));
		await entered.promise;
		if (mode === "source-fails") { await ref.set(-1, context); gate.resolve(); }
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(errors).toContain("routine_failed");
		if (mode !== "source-fails") await vi.advanceTimersByTimeAsync(1000);
		const spans = telemetry.getSpans().filter((span) => span.name === "objects.routine");
		expect(spans.map((span) => span.links.length)).toEqual(mode === "source-fails" ? [0, 1] : [0, 1, 0]);
		expect(spans[1]?.attributes.outcome).toBe(mode === "aborted-error" ? "aborted" : "error");
		expect(spans[1]?.events.filter((event) => event.name === "objects.retry")).toHaveLength(mode === "retry" ? 1 : 0);
		ref.release();
	} finally {
		gate.resolve();
		await host.close(context);
		vi.useRealTimers();
	}
});

it("retains a document through replacement and records resource and routine lifetimes", async () => {
	const telemetry = new InMemoryTelemetryContext();
	const errors: unknown[] = [];
	const host = createHost({ telemetry, onError: (error) => errors.push(error) });
	const state = defineState("meter.value", { version: 1, schema: obj({ count: int() }), initial: () => ({ count: 0 }) });
	const meter = local("meter", { version: 1, params: {}, members: { value: int(), increment: method() } });
	const observed: number[] = [];
	const nativeEvents: string[] = [];
	const implementation = (amount: number, resource: boolean) => defineFacet((facet) => facet.serve(meter, (_params, self) => {
		const document = self.state(state);
		if (resource) self.open(async () => { nativeEvents.push("open"); return 1; }, () => { nativeEvents.push("close"); });
		self.on(document, async ({ value }) => { observed.push(value.count); });
		return {
			value: self.derive([document], ([value]) => value.count),
			increment: async (ctx) => { await document.change((draft) => { draft.count += amount; }, ctx); return null; },
		};
	}));
	try {
		await host.load([{ name: "meter", facet: implementation(1, true) }], context);
		const ref = await host.get(meter, {}, context);
		await telemetry.startSpan({ name: "request" }, (span) => ref.increment(withTelemetry(span, context)));
		await host.reload([{ name: "meter", facet: implementation(2, false) }], context);
		await ref.increment(context);
		expect(ref.value.value).toBe(3);
		ref.release();
	} finally { await host.close(context); }
	expect(errors).toEqual([]);
	expect(nativeEvents).toEqual(["open", "close"]);
	expect(observed).toContain(1);
	const spans = telemetry.getSpans();
	const request = spans.find(({ name }) => name === "request")!;
	const methodSpan = spans.find(({ name, parentId }) => name === "objects.method" && parentId === request.id)!;
	expect(methodSpan.attributes.outcome).toBe("ok");
	expect(methodSpan.events.map(({ name }) => name)).toContain("objects.commit");
	expect(spans.filter(({ name }) => name === "objects.activate").map(({ attributes }) => attributes.outcome)).toEqual(["live", "live"]);
	expect(spans.find(({ name }) => name === "objects.open")?.settled).toBe(true);
	expect(spans.find(({ name }) => name === "objects.close")?.settled).toBe(true);
	expect(spans.filter(({ name }) => name === "objects.routine").every(({ settled }) => settled)).toBe(true);
});

it("links a remote activation to its incoming hold and to the dependency it waits for", async () => {
	const telemetry = new InMemoryTelemetryContext(),
		address = hostKind("trace-server")();
	const dependency = local("trace.dependency", { version: 1, params: { key: str() }, members: { value: int() } });
	const consumer = remote("trace.consumer", {
		version: 1,
		params: { key: str() },
		hostAddress: () => address,
		variants: { ready: { state: { value: int() } } },
	});
	const host = createHost({ address, principal: { kind: "server" }, telemetry, onError() {} }),
		client = createHost({ telemetry, onError() {} });
	const state = defineState("trace.value", {
		version: 1,
		schema: obj({ value: int() }),
		initial: () => ({ value: 7 }),
	});
	await host.load(
		[
			{
				name: "trace",
				facet: defineFacet((facet) => {
					facet.serve(dependency, (_params, self) => {
						const value = self.state(state);
						return { value: self.derive([value], ([value]) => value.value) };
					});
					facet.serve(consumer, ({ key }, _principal, self) => {
						const ref = self.get(dependency, { key });
						return { variant: "ready", members: { value: self.derive([ref.value], ([value]) => value) } };
					});
				}),
			},
		],
		context,
	);
	await client.load([], context);
	const [up, down] = memoryLinkPair();
	host.accept(up, { principal: { kind: "guest" } }, context);
	client.connect(down, { principal: { kind: "server" }, trusted: true }, context);
	try {
		const ref = await telemetry.startSpan({ name: "request" }, (span) =>
			client.get(consumer, { key: "one" }, withTelemetry(span, context)),
		);
		expect(ref.value.value).toBe(7);
		ref.release();
		const spans = telemetry.getSpans(),
			hold = spans.find((span) => span.name === "objects.hold")!,
			initial = spans.find(
				(span) => span.attributes.type === "trace.consumer" && span.attributes.outcome === "parked",
			)!,
			loading = spans.find((span) => span.attributes.type === "trace.dependency")!;
		expect(initial.links.map(({ context }) => context)).toEqual([hold.context, loading.context]);
		const resumed = spans.find(
			(span) => span.attributes.type === "trace.consumer" && span.attributes.outcome === "live",
		)!;
		expect(resumed.links.map(({ context }) => context)).toEqual([initial.context]);
	} finally {
		await client.close(context);
		await host.close(context);
	}
});
