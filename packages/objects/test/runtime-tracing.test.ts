import { expect, it } from "vitest";
import { InMemoryTelemetryContext } from "@axi/telemetry";
import { BACKGROUND_CONTEXT as context, withTelemetry } from "../src/context/index.ts";
import { createHost, defineFacet, defineState, int, local, method, obj } from "../src/index.ts";

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
