import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	createTypedMetrics,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	type RecordedTelemetrySpan,
} from "../src/index.ts";

describe("telemetry propagation and measurements", () => {
	it("continues a completed caller in a fresh process", async () => {
		const caller = new InMemoryTelemetryContext();
		let serialized = "";
		await caller.startSpan({ name: "request" }, (span) => {
			serialized = JSON.stringify(caller.inject(span));
		});
		const entry = new URL("../src/index.ts", import.meta.url).href;
		const result = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`
			import { InMemoryTelemetryContext } from ${JSON.stringify(entry)};
			const context = new InMemoryTelemetryContext();
			const parent = context.extract(JSON.parse(process.argv[1]));
			await parent.startSpan({name: "work"}, () => 7);
			process.stdout.write(JSON.stringify(context.getSpans()));
		`,
				serialized,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		const spans: RecordedTelemetrySpan[] = JSON.parse(result);
		expect(spans).toHaveLength(1);
		expect(spans[0].name).toBe("work");
		expect(spans[0].parentId).toBeNull();
		expect(spans[0].parentContext).toEqual(caller.getSpans()[0].context);
		expect(spans[0].context).not.toEqual(spans[0].parentContext);
		expect(spans[0].settled).toBe(true);
	});
	it("links resumed local work without mutating the old span", async () => {
		const context = new InMemoryTelemetryContext();
		let serialized = "";
		await context.startSpan({ name: "closed" }, (span) => {
			serialized = JSON.stringify(context.inject(span));
		});
		const parent = context.extract(JSON.parse(serialized));
		await parent.startSpan(
			{ name: "continued", links: [{ context: parent, attributes: { reason: "resume" } }] },
			() => {},
		);
		const [closed, continued] = context.getSpans();
		expect(continued.parentId).toBe(closed.id);
		expect(continued.parentContext).toEqual(closed.context);
		expect(continued.links).toEqual([{ context: closed.context, attributes: { reason: "resume" } }]);
		expect(closed.links).toEqual([]);
		for (const key of Object.keys(continued.links[0].context)) Reflect.set(continued.links[0].context, key, "changed");
		expect(context.getSpans()[1].links[0].context).toEqual(JSON.parse(serialized));
	});
	it("binds metric kinds and records detached metadata and exemplars", async () => {
		const schema = defineTelemetrySchema({
			version: 1,
			spans: {},
			metrics: {
				turns: {
					kind: "counter",
					description: "Completed turns",
					attributes: { result: { type: "string", values: ["ok", "error"], required: true, description: "Result" } },
				},
				duration: { kind: "histogram", description: "Elapsed time", unit: "ms", boundaries: [5, 20], attributes: {} },
			},
		} as const);
		const context = new InMemoryTelemetryContext();
		const metrics = createTypedMetrics(context, [schema]);
		metrics.counter("turns").add(2, { result: "ok" });
		metrics.counter("turns").add(-1, { result: "error" });
		await context.startSpan({ name: "turn" }, (span) => metrics.histogram("duration").record(12, undefined, span));
		const result = context.getMetrics();
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual({
			kind: "counter",
			name: "turns",
			description: "Completed turns",
			value: 2,
			attributes: { result: "ok" },
			context: null,
		});
		expect(result[1]).toEqual({
			kind: "counter",
			name: "turns",
			description: "Completed turns",
			value: -1,
			attributes: { result: "error" },
			context: null,
		});
		expect(result[2]).toEqual({
			kind: "histogram",
			name: "duration",
			description: "Elapsed time",
			unit: "ms",
			boundaries: [5, 20],
			value: 12,
			attributes: {},
			context: context.getSpans()[0].context,
		});
		if (!result[2].context) throw new Error("Missing exemplar");
		for (const key of Object.keys(result[2].context)) Reflect.set(result[2].context, key, "changed");
		expect(context.getMetrics()[2].context).toEqual(context.getSpans()[0].context);
		const checkTypes = () => {
			// @ts-expect-error A histogram name cannot select a counter.
			metrics.counter("duration");
			// @ts-expect-error Required attributes must be supplied.
			metrics.counter("turns").add(1);
			// @ts-expect-error The result value is a closed set.
			metrics.counter("turns").add(1, { result: "unknown" });
			// @ts-expect-error Duplicate metric names are ambiguous.
			createTypedMetrics(context, [schema, schema]);
		};
		void checkTypes;
	});
});
