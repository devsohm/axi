import type { TelemetrySchemaSpanEndAttributes } from "@axi/telemetry";
import { expect, expectTypeOf, it } from "vitest";
import { OBJECTS_TELEMETRY_SCHEMA as schema } from "../src/index.ts";

it("declares bounded outcomes and lifecycle values for telemetry consumers", () => {
	expectTypeOf<TelemetrySchemaSpanEndAttributes<typeof schema, "objects.call">["outcome"]>().toEqualTypeOf<
		"ok" | "error" | "aborted" | undefined
	>();
	for (const name of ["objects.call", "objects.method", "objects.relay", "objects.routine", "objects.job"] as const)
		expect(schema.spans[name]).toMatchObject({ endAttributes: { outcome: { values: ["ok", "error", "aborted"] } } });
	expect(schema.spans["objects.hold"]).toMatchObject({
		endAttributes: { outcome: { values: ["bound", "failed", "ended"] } },
	});
	expect(schema.spans["objects.activate"]).toMatchObject({
		endAttributes: { outcome: { values: ["live", "failed", "parked", "ended"] } },
	});
	expect(schema.spans["objects.resolve"]).toMatchObject({
		endAttributes: { outcome: { values: ["linked", "failed"] } },
	});
	expect(schema.spans["objects.close"]).toMatchObject({
		startAttributes: { reason: { values: ["end", "close", "reload"] } },
	});
	expect(schema.spans["objects.routine"]).toMatchObject({ startAttributes: { routine: { values: ["on", "onLive"] } } });
	expect(schema.spans["objects.job"]).toMatchObject({
		startAttributes: { phase: { values: ["intent", "run", "finish"] } },
	});
	expect(schema.spans["objects.reload"]).toMatchObject({
		events: {
			"objects.reload.fate": { attributes: { fate: { values: ["restarted", "ended", "parked", "retried"] } } },
		},
	});
});

it("requires declaration inputs without requiring optional telemetry results", () => {
	for (const span of Object.values(schema.spans)) {
		for (const [name, attribute] of Object.entries(span.startAttributes))
			expect(attribute, name).toHaveProperty("required", name !== "objects.principal" && name !== "job.id");
		for (const attribute of Object.values(span.endAttributes)) expect(attribute).not.toHaveProperty("required");
	}
	expect(schema.spans["objects.resolve"].startAttributes.address).toEqual({
		type: "string",
		required: true,
		cardinality: "high",
		description: expect.any(String),
	});
});
