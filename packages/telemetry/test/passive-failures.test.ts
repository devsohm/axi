import { expect, test } from "vitest";
import { InMemoryTelemetryContext, type SpanAttributes } from "../src/index.ts";

const unreadable: SpanAttributes = {
	get value(): string {
		throw new Error("unreadable attribute");
	},
};

test("unreadable instrumentation surfaces errors before recording unreadable values", async () => {
	const telemetry = new InMemoryTelemetryContext();
	await expect(telemetry.startSpan({ name: "unreadable", attributes: unreadable }, () => 42)).rejects.toThrow(
		"unreadable attribute",
	);
	expect(telemetry.getSpans()).toEqual([]);
	const original = new Error("operation failed");
	await expect(
		telemetry.startSpan({ name: "recorded" }, (span) => {
			expect(() => span.addEvent("discarded", unreadable)).toThrow("unreadable attribute");
			expect(() => span.setAttributes(unreadable)).toThrow("unreadable attribute");
			expect(() =>
				span.setStatus({
					status: "error",
					get error(): Error {
						throw new Error("unreadable error");
					},
				}),
			).toThrow("unreadable error");
			span.addEvent("retained", { n: 1 });
			throw original;
		}),
	).rejects.toBe(original);
	expect(telemetry.getSpans()).toMatchObject([
		{
			name: "recorded",
			attributes: {},
			events: [{ name: "retained", attributes: { n: 1 } }],
			status: { status: "error", error: { name: "Error", message: "operation failed" } },
		},
	]);
});

test("writes through a completed span cannot alter its recorded snapshot", async () => {
	const telemetry = new InMemoryTelemetryContext();
	const completed = await telemetry.startSpan({ name: "finished" }, (span) => span);
	const before = telemetry.getSpans();
	completed.setStatus({ status: "error" });
	completed.setAttributes({ late: true });
	completed.addEvent("late");
	completed.addLink({ context: completed });
	expect(
		await completed.startSpan({ name: "late" }, async (child) =>
			child.startSpan({ name: "later" }, () => "still runs"),
		),
	).toBe("still runs");
	expect(telemetry.getSpans()).toEqual(before);
	expect(before[0]).toMatchObject({ name: "finished", status: { status: "ok" }, settled: true });
});

test("metric getters surface errors and the memory recorder retains raw numeric measurements", () => {
	const telemetry = new InMemoryTelemetryContext();
	expect(() =>
		telemetry.histogram("bad-options", {
			get boundaries(): number[] {
				throw new Error("unreadable boundaries");
			},
		}),
	).toThrow("unreadable boundaries");
	telemetry.histogram("bad-order", { boundaries: [2, 1] }).record(4);
	telemetry.histogram("bad-finite", { boundaries: [NaN] }).record(4);
	expect(() => telemetry.counter("bad-attrs").add(4, unreadable)).toThrow("unreadable attribute");
	telemetry.counter("values").add(Infinity);
	telemetry.counter("values").add(-2);
	telemetry.counter("values").add(3, { valid: true });
	expect(telemetry.getMetrics()).toEqual([
		{ kind: "histogram", name: "bad-order", boundaries: [2, 1], value: 4, attributes: {}, context: null },
		{ kind: "histogram", name: "bad-finite", boundaries: [NaN], value: 4, attributes: {}, context: null },
		{ kind: "counter", name: "values", value: Infinity, attributes: {}, context: null },
		{ kind: "counter", name: "values", value: -2, attributes: {}, context: null },
		{ kind: "counter", name: "values", value: 3, attributes: { valid: true }, context: null },
	]);
});
