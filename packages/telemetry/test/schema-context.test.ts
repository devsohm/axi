import { expect, test } from "vitest";
import {
	createTypedSpanStarter,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
} from "../src/index.ts";

const schema = defineTelemetrySchema({
	version: 1,
	spans: {
		job: {
			description: "Scheduled operation",
			parents: { kind: "any" },
			startAttributes: {
				queue: { type: "string", values: ["foreground", "background"], required: true, description: "Queue" },
			},
			endAttributes: { written: { type: "number", description: "Saved records" } },
			events: {
				checkpoint: {
					description: "Checkpoint saved",
					attributes: { sequence: { type: "number", required: true, description: "Revision" } },
				},
			},
			status: { default: "ok", errorWhen: "Work fails" },
		},
		step: {
			description: "Part of a job",
			parents: { kind: "spans", spans: ["job"] },
			startAttributes: {},
			endAttributes: {},
			status: { default: "ok", errorWhen: "Step fails" },
		},
	},
});

test("schema-bound child starters retain parentage, record events and return callback results", async () => {
	const recorder = new InMemoryTelemetryContext(),
		start = createTypedSpanStarter(recorder, [schema]);
	expect(
		await start("job", { queue: "foreground" }, async (span, child) => {
			span.addEvent("checkpoint", { sequence: 3 });
			span.setAttributes({ written: 7 });
			return child("step", {}, () => "saved");
		}),
	).toBe("saved");
	expect(
		recorder.getSpans().map((span) => ({
			name: span.name,
			parent: span.parentId,
			attributes: span.attributes,
			events: span.events,
			status: span.status,
		})),
	).toEqual([
		{
			name: "job",
			parent: null,
			attributes: { queue: "foreground", written: 7 },
			events: [{ name: "checkpoint", attributes: { sequence: 3 } }],
			status: { status: "ok" },
		},
		{ name: "step", parent: 1, attributes: {}, events: [], status: { status: "ok" } },
	]);
});

test("disabled telemetry runs nested work and preserves failures while accepting every instrumentation operation", async () => {
	const result = await NOOP_TELEMETRY_CONTEXT.startSpan({ name: "outer" }, async (span) => {
		span.setAttributes({ count: 1 });
		span.addEvent("saved");
		span.setStatus({ status: "ok" });
		span.addLink({ context: span });
		span.metrics?.counter("calls").add(1);
		span.metrics?.upDownCounter("active").add(-1);
		span.metrics?.histogram("latency").record(2);
		expect(span.propagation?.extract({ unknown: "carrier" })).toBe(NOOP_TELEMETRY_CONTEXT);
		return span.startSpan({ name: "inner" }, () => 42);
	});
	expect(result).toBe(42);
	const problem = new Error("callback failed");
	await expect(
		NOOP_TELEMETRY_CONTEXT.startSpan({ name: "sync" }, () => {
			throw problem;
		}),
	).rejects.toBe(problem);
	await expect(
		NOOP_TELEMETRY_CONTEXT.startSpan({ name: "async" }, async () => {
			throw problem;
		}),
	).rejects.toBe(problem);
});
