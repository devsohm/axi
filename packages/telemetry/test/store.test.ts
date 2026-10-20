import { afterEach, expect, test, vi } from "vitest";
import { InMemoryTelemetryContext, type StoredSpan } from "../src/index.ts";
import { renderTrace } from "../src/render.ts";
afterEach(() => vi.useRealTimers());

test("carrier getter failures propagate and trace cursors keep their JSON comparison semantics", async () => {
	const recorder = new InMemoryTelemetryContext();
	const problem = new Error("unreadable carrier");
	const carrier = new Proxy<Record<string, string>>(
		{},
		{
			get() {
				throw problem;
			},
		},
	);
	expect(() => recorder.extract(carrier)).toThrow(problem);
	await recorder.startSpan({ name: "request" }, () => {});
	expect((await recorder.findTraces({ cursor: '["0", ""]' })).traces).toEqual([]);
	await expect(recorder.findTraces({ limit: 0 })).rejects.toBeInstanceOf(TypeError);
});

test("trace and metric queries preserve filtering, pagination and detached snapshots", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1000);
	const recorder = new InMemoryTelemetryContext();
	await recorder.startSpan({ name: "request", attributes: { flag: true } }, async (parent) => {
		await parent.startSpan({ name: "parse", attributes: { phase: "decode" } }, (span) =>
			span.addEvent("ready", { bytes: 3 }),
		);
	});
	vi.setSystemTime(2000);
	await expect(
		recorder.startSpan({ name: "request", attributes: { flag: 1 } }, () => {
			throw new TypeError("bad input");
		}),
	).rejects.toThrow("bad input");
	const first = await recorder.findTraces({ name: "request", limit: 1 });
	expect(first.traces.map((trace) => trace.spans.map((span) => span.name))).toEqual([["request"]]);
	expect(first.cursor).toBeTypeOf("string");
	const second = await recorder.findTraces({ limit: 1, cursor: first.cursor });
	expect(second.traces.map((trace) => trace.spans.map((span) => span.name))).toEqual([["request", "parse"]]);
	expect((await recorder.findTraces({ attributes: { flag: true } })).traces.map((trace) => trace.spans.length)).toEqual(
		[2],
	);
	expect(
		(await recorder.findTraces({ errors: true, startMin: 1500, startMax: 2500 })).traces.map(
			(trace) => trace.spans[0]!.status,
		),
	).toEqual([{ status: "error", error: { name: "TypeError", message: "bad input" } }]);
	const trace = await recorder.getTrace(second.traces[0]!.traceId);
	expect(trace?.spans[1]?.events.map((event) => ({ name: event.name, attributes: event.attributes }))).toEqual([
		{ name: "ready", attributes: { bytes: 3 } },
	]);
	trace!.spans[0]!.attributes.flag = "modified";
	expect((await recorder.getTrace(second.traces[0]!.traceId))?.spans[0]?.attributes.flag).toBe(true);
	expect(await recorder.getTrace("missing")).toBeUndefined();
	recorder.counter("calls").add(3, { flag: true });
	recorder.counter("calls").add(5, { flag: 1 });
	expect(
		(await recorder.findMetrics({ name: "calls", attributes: { flag: true }, startMin: 0, startMax: 9999 })).map(
			({ count, sum, min, max }) => ({ count, sum, min, max }),
		),
	).toEqual([{ count: 1, sum: 3, min: 3, max: 3 }]);
});

test("trace rendering orders descendants, retains orphan roots and displays errors and links", () => {
	const root: StoredSpan = {
		id: "root",
		traceId: "trace",
		name: "request",
		startedMs: 100,
		endedMs: 110,
		attributes: { count: 2 },
		events: [{ name: "sent", timeMs: 2, attributes: {} }],
		links: [{ traceId: "other", spanId: "remote" }],
		status: { status: "ok" },
	};
	const child: StoredSpan = {
		id: "child",
		traceId: "trace",
		parentId: "root",
		name: "decode",
		startedMs: 105,
		endedMs: 110,
		attributes: {},
		events: [],
		links: [],
		status: { status: "error", error: { name: "TypeError", message: "bad input" } },
	};
	const orphan: StoredSpan = {
		...child,
		id: "orphan",
		parentId: "absent",
		name: "orphan",
		startedMs: 90,
		endedMs: 91,
		status: { status: "ok" },
	};
	expect(renderTrace([child, root, orphan])).toBe(
		"orphan (1ms)\nrequest count=2 (10ms)\n  · sent (+2ms)\n  → link trace other span remote\n  decode (5ms) error TypeError: bad input",
	);
});
