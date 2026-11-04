import { expect, it } from "vitest";
import { InMemoryTelemetryContext } from "@axi/telemetry";
import { BACKGROUND_CONTEXT as context, withTelemetry } from "../src/context/index.ts";
import { createHost, defineFacet, defineState, int, local, method, obj, str, remote, hostKind, memoryLinkPair } from "../src/index.ts";

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
