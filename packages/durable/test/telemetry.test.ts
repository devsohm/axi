import { expect, test } from "vitest";
import { DURABLE_TELEMETRY_SCHEMA } from "../src/index.ts";

test("declares every scheduler report reason in submission and phase spans", () => {
	const reasons = ["threw", "restart_limit", "interrupted", "missing_task", "task_too_old", "migration_failed"];
	for (const name of ["axi.durable.submit", "axi.durable.phase"] as const) {
		expect(DURABLE_TELEMETRY_SCHEMA.spans[name].events["axi.durable.report"].attributes.reason.values).toEqual(reasons);
	}
});
