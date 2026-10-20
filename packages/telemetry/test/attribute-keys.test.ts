import { expect, test } from "vitest";
import { InMemoryTelemetryContext, type SpanAttributes } from "../src/index.ts";

test("attribute names that match Object prototype members survive recording, merging and snapshots", async () => {
	const telemetry = new InMemoryTelemetryContext();
	const initial: SpanAttributes = Object.fromEntries([
		["__proto__", ["first"]],
		["constructor", "initial"],
		["toString", false],
	]);
	const changed: SpanAttributes = Object.fromEntries([
		["__proto__", ["updated"]],
		["constructor", "changed"],
	]);
	await telemetry.startSpan({ name: "keyed", attributes: initial }, (span) => {
		span.addEvent("event", initial);
		span.setAttributes(changed);
		telemetry.counter("keyed").add(2, initial);
	});
	const expected = Object.fromEntries([
		["__proto__", ["updated"]],
		["constructor", "changed"],
		["toString", false],
	]);
	expect(telemetry.getSpans()[0]?.attributes).toEqual(expected);
	expect(Object.keys(telemetry.getSpans()[0]?.attributes ?? {})).toEqual(["__proto__", "constructor", "toString"]);
	expect(telemetry.getSpans()[0]?.events).toEqual([{ name: "event", attributes: initial }]);
	expect(telemetry.getMetrics()[0]).toMatchObject({ name: "keyed", value: 2, attributes: initial });
	initial.__proto__ = "caller changed";
	changed.__proto__ = "caller changed";
	expect(telemetry.getSpans()[0]?.attributes).toEqual(expected);
	expect(telemetry.getMetrics()[0]?.attributes.__proto__).toEqual(["first"]);
	const traces = await telemetry.findTraces({ attributes: { constructor: "changed" } });
	expect(traces.traces.map((trace) => trace.spans[0]?.name)).toEqual(["keyed"]);
	expect(traces.traces[0]?.spans[0]?.attributes).toEqual(expected);
	expect((await telemetry.findMetrics({ name: "keyed" }))[0]?.attributes.__proto__).toEqual(["first"]);
});
