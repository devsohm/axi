import { expect, it } from "vitest";
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT, type TelemetrySpan } from "@axi/telemetry";
import { BACKGROUND_CONTEXT as context, withTelemetry } from "../src/context/index.ts";
import { ObjectsHost } from "../src/host/host.ts";
import { constant, defineFacet, defineRegistry, int, local, str } from "../src/index.ts";

it("reports published registries in name order and distinguishes missing types from version skew", async () => {
	const first = local("lifecycle.notes", { version: 1, params: { id: str() }, members: { value: int() } });
	const later = local("lifecycle.notes", { version: 2, params: { id: str() }, members: { value: int() } });
	const absent = local("lifecycle.absent", { version: 1, params: {}, members: {} });
	const z = defineRegistry<number, number>("lifecycle.z", { version: 1 });
	const a = defineRegistry<number, number>("lifecycle.a", { version: 1 });
	const published: boolean[] = [];
	const host = new ObjectsHost({ onError(error) {
		if (error.kind === "registry_undeclared") published.push(host.published);
	} });
	try {
		await host.load([{ name: "notes", facet: defineFacet((h, self) => {
			h.serve(first, () => ({ value: constant(1) }));
			self.contribute(z, 1);
			self.contribute(a, 2);
		}) }], context);
		const versioned = host.hold(later, { id: "one" }, context);
		const missing = host.hold(absent, {}, context);
		expect(host.unservedNames()).toEqual(["lifecycle.absent"]);
		expect(host.undeclaredRegistries().map((entry) => entry.name)).toEqual(["lifecycle.a", "lifecycle.z"]);
		expect(published).toEqual([true, true]);
		versioned.release();
		missing.release();
	} finally {
		await host.close(context);
	}
});

it("admits only one load while its telemetry callback is pending", async () => {
	const telemetry: TelemetrySpan = {
		...NOOP_TELEMETRY_CONTEXT,
		startSpan: (options, callback) => Promise.resolve().then(() => NOOP_TELEMETRY_CONTEXT.startSpan(options, callback)),
	};
	const host = new ObjectsHost({ onError() {} });
	try {
		const results = await Promise.allSettled([
			host.load([], withTelemetry(telemetry, context)),
			host.load([], withTelemetry(telemetry, context)),
		]);
		expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
	} finally {
		await host.close(context);
	}
});

it("rejects a closed host's reload before interpreting plugin names", async () => {
	const host = new ObjectsHost({ onError() {} });
	await host.close(context);
	await expect(host.reload([{ name: "Bad Name", facet: defineFacet(() => {}) }], context)).rejects.toMatchObject({
		code: "released", reason: "closed",
	});
});

it("bounds object labels in reload telemetry events", async () => {
	const row = local("lifecycle.row", { version: 1, params: { id: str() }, members: { value: int() } });
	const telemetry = new InMemoryTelemetryContext();
	const host = new ObjectsHost({ telemetry, onError() {} });
	const plugin = (n: number) => defineFacet((h) => h.serve(row, () => ({ value: constant(n) })));
	try {
		await host.load([{ name: "rows", facet: plugin(1) }], context);
		const ref = await host.get(row, { id: "x".repeat(500) }, context);
		await telemetry.startSpan({ name: "request" }, (span) =>
			host.reload([{ name: "rows", facet: plugin(2) }], withTelemetry(span, context)));
		const events = telemetry.getSpans().find((span) => span.name === "objects.reload")!.events;
		expect(events).toHaveLength(1);
		expect(events[0]!.attributes.object).toHaveLength(256);
		ref.release();
	} finally {
		await host.close(context);
	}
});
