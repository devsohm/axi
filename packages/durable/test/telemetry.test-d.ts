import type { TelemetryContext, TelemetryMetrics, TelemetryPropagation } from "@axi/telemetry";
import type { HarnessOptions } from "../src/index.ts";

declare const basic: TelemetryContext;
declare const complete: TelemetryContext & TelemetryMetrics & TelemetryPropagation;
export const accepted = [{}, { telemetry: basic }, { telemetry: complete }] satisfies readonly Pick<
	HarnessOptions,
	"telemetry"
>[];
// @ts-expect-error Metrics alone do not provide a span-starting context.
export const invalid: Pick<HarnessOptions, "telemetry"> = { telemetry: { counter: complete.counter } };
