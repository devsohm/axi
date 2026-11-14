import { expect, test } from "vitest";
import { createModels } from "@axi/ai";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext, type TelemetrySpan } from "@axi/telemetry";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { createRegistry, defineTask, DURABLE_TELEMETRY_SCHEMA, Harness, MemoryStorage } from "../src/index.ts";

test("declares every scheduler report reason in submission and phase spans", () => {
	const reasons = ["threw", "restart_limit", "interrupted", "missing_task", "task_too_old", "migration_failed"];
	for (const name of ["axi.durable.submit", "axi.durable.phase"] as const) {
		expect(DURABLE_TELEMETRY_SCHEMA.spans[name].events["axi.durable.report"].attributes.reason.values).toEqual(reasons);
	}
});

test("a span-only telemetry adapter can observe durable phases without metrics or propagation", async () => {
	const names: string[] = [];
	const telemetry: TelemetryContext = {
		startSpan(options, callback) {
			names.push(options.name);
			return NOOP_TELEMETRY_CONTEXT.startSpan(options, (span) => {
				const { metrics: _metrics, propagation: _propagation, ...methods } = span;
				const plain: TelemetrySpan = { ...methods, startSpan: telemetry.startSpan };
				return callback(plain);
			});
		},
	};
	const task = defineTask<null, { phase: "run" }, number>({
		name: "span-only",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			async run(_record, runtime, ctx) {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: 42 } }), ctx);
			},
		},
		async abort(_record, runtime, ctx) {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
	const registry = createRegistry();
	registry.install({ name: "span-only", tasks: [task] });
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry, telemetry }, context);
	try {
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }), context);
		harness.resume();
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: 42 });
		expect(names.filter((name) => name === "axi.durable.phase")).toEqual(["axi.durable.phase"]);
	} finally {
		await harness.close(context);
	}
});
