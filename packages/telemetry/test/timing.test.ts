import { afterEach, expect, test, vi } from "vitest";
import { InMemoryTelemetryContext, telemetryNow, type StoredSpan } from "../src/index.ts";
import { renderTrace } from "../src/render.ts";

afterEach(() => vi.restoreAllMocks());

test("the span clock preserves sub-millisecond order and follows wall-clock steps", async () => {
	let clock = 20;
	let wall = 1000;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
	vi.spyOn(Date, "now").mockImplementation(() => wall);
	expect(telemetryNow()).toBe(1000);
	clock += 0.123456;
	expect(telemetryNow()).toBe(1000.123);
	wall = 2000;
	expect(telemetryNow()).toBe(2000);
	const recorder = new InMemoryTelemetryContext();
	await recorder.startSpan({ name: "request" }, (span) => {
		clock += 0.123456;
		span.addEvent("ready");
		clock += 0.123456;
	});
	const [trace] = (await recorder.findTraces()).traces;
	expect(trace!.spans[0]!.startedMs).toBe(2000);
	expect(trace!.spans[0]!.endedMs).toBe(2000.247);
	expect(trace!.spans[0]!.events[0]!.timeMs).toBe(0.123);
});

test("rendered traces escape terminal controls and round elapsed times to microseconds", () => {
	const span: StoredSpan = {
		id: "span",
		traceId: "trace",
		name: "run\u001b",
		startedMs: 10,
		endedMs: 10.123456,
		attributes: { "key\n": "value\t" },
		events: [{ name: "event\r", timeMs: 0.012345, attributes: {} }],
		links: [{ traceId: "trace\u007f", spanId: "span\u0085" }],
		status: { status: "error", error: { name: "Error\u0000", message: "bad\tinput" } },
	};
	expect(renderTrace([span])).toBe(
		'run\\u001b key\\u000a="value\\t" (0.123ms) error Error\\u0000: bad\\u0009input\n' +
			"  · event\\u000d (+0.012ms)\n  → link trace trace\\u007f span span\\u0085",
	);
});
