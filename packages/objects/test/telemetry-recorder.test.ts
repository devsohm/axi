import { NOOP_TELEMETRY_CONTEXT, type TelemetryCarrier, type TelemetrySpan } from "@axi/telemetry";
import { afterEach, expect, test, vi } from "vitest";
import { TelemetryRecorder } from "../src/telemetry-ingest/index.ts";

afterEach(() => vi.restoreAllMocks());

test("propagated parents and links retain identity while span data is copied at recording time", async () => {
	const scope = vi.fn(() => "process"),
		recorder = new TelemetryRecorder(scope, 10);
	const values = [1, 2],
		attributes = { values, label: "initial", omitted: undefined };
	let parent: TelemetrySpan | undefined;
	await recorder.startSpan({ name: "parent", attributes }, async (span) => {
		parent = span;
		const carrier = recorder.inject(span);
		const extracted = recorder.extract(carrier);
		expect(recorder.inject(extracted)).toEqual(carrier);
		values.push(3);
		attributes.label = "mutated";
		await extracted.startSpan({ name: "child", links: [{ context: span, attributes: { values } }] }, (child) => {
			child.addLink({ context: NOOP_TELEMETRY_CONTEXT });
			child.addLink({ context: span, attributes: { label: "related" } });
			child.addEvent("ready", { values });
			child.setAttributes({ extra: true });
			values.push(4);
		});
	});
	if (parent === undefined) throw new Error("Parent span was not supplied");
	parent.setAttributes({ late: true });
	parent.addEvent("too late");
	parent.addLink({ context: parent });
	parent.setStatus({ status: "error" });
	expect(
		await parent.startSpan({ name: "late child" }, (span) => span.startSpan({ name: "later child" }, () => 42)),
	).toBe(42);
	const { spans } = recorder.take(true);
	expect(scope).toHaveBeenCalledOnce();
	expect(spans.map((span) => span.name)).toEqual(["child", "parent"]);
	const [child, root] = spans;
	expect(root).toMatchObject({
		attributes: { values: [1, 2], label: "initial" },
		status: { status: "ok" },
		events: [],
		links: [],
	});
	expect(root!.attributes).not.toHaveProperty("omitted");
	expect(root).not.toHaveProperty("parentId");
	expect(child).toMatchObject({
		parentId: root!.id,
		traceId: root!.traceId,
		attributes: { extra: true },
		links: [
			{ spanId: root!.id, traceId: root!.traceId, attributes: { values: [1, 2, 3] } },
			{ spanId: root!.id, traceId: root!.traceId, attributes: { label: "related" } },
		],
		events: [{ name: "ready", attributes: { values: [1, 2, 3] }, timeMs: expect.any(Number) }],
	});
	for (const span of spans) expect(span.endedMs).toBeGreaterThanOrEqual(span.startedMs);
	expect(recorder.inject(NOOP_TELEMETRY_CONTEXT)).toBeUndefined();
	const incompleteCarriers: (TelemetryCarrier | undefined)[] = [undefined, {}, { "axi-sqlite-span": "only-one-field" }];
	for (const carrier of incompleteCarriers) expect(recorder.extract(carrier)).toBe(recorder);
});

test.each([new TypeError("failed work"), "failed work"])(
	"recording preserves a thrown %j and stores its error status",
	async (failure) => {
		const recorder = new TelemetryRecorder(() => "errors", 10);
		await expect(
			recorder.startSpan({ name: "failed" }, () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(recorder.take(true).spans[0]!.status).toEqual(
			failure instanceof Error
				? { status: "error", error: { name: "TypeError", message: "failed work" } }
				: { status: "error" },
		);
	},
);

test.each(["ok", "error"] as const)("an explicit %s status is retained when the callback throws", async (status) => {
	const recorder = new TelemetryRecorder(() => "explicit-status", 10);
	const failure = new Error("callback failed"),
		detail = { name: "Saved", message: "original" };
	await expect(
		recorder.startSpan({ name: "request" }, (span) => {
			span.setStatus(status === "ok" ? { status } : { status, error: detail });
			detail.message = "changed later";
			throw failure;
		}),
	).rejects.toBe(failure);
	expect(recorder.take(true).spans[0]!.status).toEqual(
		status === "ok" ? { status } : { status, error: { name: "Saved", message: "original" } },
	);
});

test("a taken span batch keeps its capacity until its owner releases it", async () => {
	const recorder = new TelemetryRecorder(() => "capacity", 2);
	for (const name of ["first", "second"]) await recorder.startSpan({ name }, () => {});
	expect(recorder.pending(false)).toBe(true);
	expect(recorder.take(false, 1).spans.map((span) => span.name)).toEqual(["first"]);
	await recorder.startSpan({ name: "dropped" }, () => {});
	expect(recorder.queuedSpans).toBe(1);
	expect(recorder.droppedSpans).toBe(1);
	recorder.release();
	await recorder.startSpan({ name: "after release" }, () => {});
	expect(recorder.take(true).spans.map((span) => span.name)).toEqual(["second", "after release"]);
	expect(recorder.pending(true)).toBe(false);
});

test("metric series use ordered attributes and retain unfinished intervals until a partial flush", () => {
	let now = 12345;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const recorder = new TelemetryRecorder(() => "metrics", 10);
	const count = recorder.metrics.counter("requests", { unit: "call" });
	count.add(2, { z: "last", a: "first" });
	count.add(5, { a: "first", z: "last" });
	recorder.metrics.upDownCounter("active").add(-2);
	recorder.metrics.histogram("duration", { unit: "ms" }).record(12);
	expect(recorder.pending(false)).toBe(false);
	expect(recorder.pending(true)).toBe(true);
	expect(recorder.take(false)).toEqual({ spans: [], metrics: [] });
	now = 20000;
	expect(recorder.pending(false)).toBe(true);
	const { metrics } = recorder.take(false);
	expect(metrics).toEqual([
		{
			name: "requests",
			kind: "counter",
			unit: "call",
			intervalMs: 10000,
			attributes: { a: "first", z: "last" },
			count: 2,
			sum: 7,
			min: 2,
			max: 5,
		},
		{ name: "active", kind: "upDownCounter", intervalMs: 10000, attributes: {}, count: 1, sum: -2, min: -2, max: -2 },
		{
			name: "duration",
			kind: "histogram",
			unit: "ms",
			intervalMs: 10000,
			attributes: {},
			count: 1,
			sum: 12,
			min: 12,
			max: 12,
		},
	]);
	recorder.release();
	count.add(1);
	expect(recorder.take(true).metrics[0]).toMatchObject({ intervalMs: 20000, count: 1, sum: 1 });
});

test("metric capacity includes taken series and counts each rejected measurement", () => {
	const recorder = new TelemetryRecorder(() => "bounded", 1);
	const count = recorder.metrics.counter("jobs");
	count.add(2);
	count.add(3);
	recorder.metrics.counter("other").add(1);
	expect(recorder.take(true).metrics).toMatchObject([{ name: "jobs", count: 2, sum: 5 }]);
	count.add(9);
	expect(recorder.droppedMeasurements).toBe(2);
	recorder.release();
	count.add(4);
	expect(recorder.take(true).metrics).toMatchObject([{ name: "jobs", count: 1, sum: 4 }]);
});

test.each(["keep", "discard"] as const)(
	"stopping with %s preserves callback execution while ending recording",
	async (mode) => {
		const recorder = new TelemetryRecorder(() => "stopping", 10);
		await recorder.startSpan({ name: "saved" }, () => {});
		recorder.metrics.counter("saved count").add(1);
		let finish: () => void = () => {
			throw new Error("Missing pending callback");
		};
		const pending = recorder.startSpan({ name: "in flight" }, async (span) => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			span.addEvent("after stop");
		});
		recorder.stop(mode);
		finish();
		await pending;
		expect(recorder.stopped).toBe(true);
		expect(
			await recorder.startSpan({ name: "ignored" }, (span) =>
				span.startSpan({ name: "ignored nested" }, () => "completed"),
			),
		).toBe("completed");
		expect(recorder.ingest({ spans: [], metrics: [] })).toBe(0);
		const batch = recorder.take(true);
		expect(batch.spans.map((span) => span.name)).toEqual(mode === "keep" ? ["saved"] : []);
		expect(batch.metrics.map((metric) => metric.name)).toEqual(mode === "keep" ? ["saved count"] : []);
	},
);
