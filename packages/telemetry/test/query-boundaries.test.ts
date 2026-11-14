import { afterEach, expect, test, vi } from "vitest";
import {
	createTypedMetrics,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
	type StoredSpan,
	type TelemetryContext,
} from "../src/index.ts";
import { renderTrace } from "../src/render.ts";
import { createTelemetryAdapterConformance } from "../src/testing/index.ts";

afterEach(() => vi.restoreAllMocks());

test("equal-time traces have stable pagination without dropping or duplicating roots", async () => {
	vi.spyOn(performance, "now").mockReturnValue(0);
	vi.spyOn(Date, "now").mockReturnValue(1000);
	const recorder = new InMemoryTelemetryContext();
	for (let index = 1; index <= 12; index++)
		await recorder.startSpan({ name: `root-${index}`, links: [{ context: NOOP_TELEMETRY_CONTEXT }] }, () => {});
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await recorder.findTraces({ limit: 3, cursor });
		names.push(...page.traces.map((trace) => trace.spans[0]!.name));
		cursor = page.cursor;
	} while (cursor);
	expect(names).toEqual([
		"root-1",
		"root-10",
		"root-11",
		"root-12",
		"root-2",
		"root-3",
		"root-4",
		"root-5",
		"root-6",
		"root-7",
		"root-8",
		"root-9",
	]);
	expect(recorder.getSpans().every((span) => span.links.length === 0)).toBe(true);
	recorder.counter("work", { unit: "items" }).add(2);
	expect(await recorder.findMetrics({ name: "work" })).toEqual([
		{ intervalMs: 0, name: "work", kind: "counter", unit: "items", attributes: {}, count: 1, sum: 2, min: 2, max: 2 },
	]);
});

test("equal-time continuations sort opaque trace identities independently of their arrival order", async () => {
	vi.spyOn(performance, "now").mockReturnValue(0);
	vi.spyOn(Date, "now").mockReturnValue(1000);
	const recorder = new InMemoryTelemetryContext();
	for (const id of ["z-last", "a-first", "m-middle"])
		await recorder
			.extract({
				"axi-memory-scope": "remote-recorder",
				"axi-memory-span": "parent",
				"axi-memory-trace": id,
			})
			.startSpan({ name: id }, () => {});
	const first = await recorder.findTraces({ limit: 2 });
	expect(first.traces.map((trace) => trace.traceId)).toEqual(["a-first", "m-middle"]);
	expect(first.cursor).toBeDefined();
	const next = await recorder.findTraces({ limit: 2, cursor: first.cursor });
	expect(next.traces.map((trace) => trace.traceId)).toEqual(["z-last"]);
	expect(next.cursor).toBeUndefined();
});

test("trace rendering handles empty input, cycles and errors without diagnostics", () => {
	expect(renderTrace([])).toBe("");
	const failed: StoredSpan = {
		id: "one",
		traceId: "trace",
		name: "failed",
		startedMs: 0,
		endedMs: 2,
		attributes: {},
		events: [],
		links: [],
		status: { status: "error" },
	};
	expect(renderTrace([failed])).toBe("failed (2ms) error");
	expect(renderTrace([{ ...failed, parentId: "one" }])).toBe("");
});

test("schemas without metrics do not prevent instruments from other schemas being used", () => {
	const recorder = new InMemoryTelemetryContext();
	const spans = defineTelemetrySchema({ version: 1, spans: {} });
	const metrics = defineTelemetrySchema({
		version: 1,
		spans: {},
		metrics: {
			jobs: { kind: "counter", description: "Completed jobs", attributes: {} },
			active: { kind: "upDownCounter", description: "Active jobs", attributes: {} },
		},
	});
	createTypedMetrics(recorder, [spans, metrics]).counter("jobs").add(4);
	createTypedMetrics(recorder, [spans, metrics]).upDownCounter("active").add(-1);
	expect(recorder.getMetrics()).toEqual([
		{ kind: "counter", name: "jobs", description: "Completed jobs", value: 4, attributes: {}, context: null },
		{ kind: "upDownCounter", name: "active", description: "Active jobs", value: -1, attributes: {}, context: null },
	]);
});

test("live spans remain inspectable before settlement while stored traces contain only settled spans", async () => {
	const recorder = new InMemoryTelemetryContext();
	await recorder.startSpan({ name: "live" }, async () => {
		expect(recorder.getSpans()[0]).toMatchObject({ settled: false });
		expect(recorder.getSpans()[0]).not.toHaveProperty("endSequence");
		expect((await recorder.findTraces()).traces).toEqual([]);
	});
	expect(recorder.getSpans()[0]).toMatchObject({ settled: true, endSequence: 1 });
	expect(NOOP_TELEMETRY_CONTEXT.propagation?.inject(recorder)).toBeUndefined();
});

test("capability conformance permits an adapter that supports spans alone", async () => {
	const context: TelemetryContext = {
		startSpan(options, callback) {
			return NOOP_TELEMETRY_CONTEXT.startSpan(options, (span) => {
				const { metrics: _metrics, propagation: _propagation, ...plain } = span;
				return callback({ ...plain, startSpan: context.startSpan });
			});
		},
	};
	const cases = createTelemetryAdapterConformance(async () => ({
		context,
		getSpans: async () => [],
		async [Symbol.asyncDispose]() {},
	}));
	const check = cases.find((entry) => entry.group === "capabilities");
	if (!check) throw new Error("Missing capabilities conformance case");
	await expect(check.run()).resolves.toBeUndefined();
});

test("conformance cases support adapters without advertised metrics or propagation", async () => {
	let opened = 0,
		closed = 0;
	const cases = createTelemetryAdapterConformance(async () => {
		opened++;
		const context = new InMemoryTelemetryContext();
		return {
			context,
			getSpans: async () => context.getSpans(),
			async [Symbol.asyncDispose]() {
				closed++;
			},
		};
	});
	for (const check of cases) await check.run();
	expect(opened).toBe(cases.length);
	expect(closed).toBe(opened);
});

test("conformance failures identify skipped callbacks and still dispose the fixture", async () => {
	let closed = 0;
	const cases = createTelemetryAdapterConformance(async () => ({
		context: { startSpan: async () => JSON.parse("null") },
		getSpans: async () => [],
		async [Symbol.asyncDispose]() {
			closed++;
		},
	}));
	for (const [name, message] of [
		["records initial and late links without changing parents", "Expected target span"],
		["preserves synchronous and asynchronous rejection values", "Expected operation to reject"],
	]) {
		const check = cases.find((entry) => entry.name === name);
		if (!check) throw new Error(`Missing conformance case: ${name}`);
		await expect(check.run()).rejects.toThrow(message);
	}
	expect(closed).toBe(2);
});

test.each([2, 3])("propagation conformance rejects a fixture that drops capability on hop %i", async (missing) => {
	let opened = 0,
		closed = 0;
	const cases = createTelemetryAdapterConformance(async () => {
		const context = new InMemoryTelemetryContext();
		return {
			context,
			propagation: ++opened === missing ? undefined : context,
			getSpans: async () => context.getSpans(),
			async [Symbol.asyncDispose]() {
				closed++;
			},
		};
	});
	const check = cases.find((entry) => entry.name === "propagates across fresh adapters and multiple hops");
	if (!check) throw new Error("Missing propagation conformance case");
	await expect(check.run()).rejects.toThrow("Expected propagation on each fixture");
	expect(opened).toBe(3);
	expect(closed).toBe(opened);
});
