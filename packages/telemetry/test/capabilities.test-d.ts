import type { InMemoryTelemetryContext, TelemetryMetrics, TelemetryPropagation } from "../src/index.ts";

type Check<T extends true> = T;
export type MetricsContract = Check<
	keyof InMemoryTelemetryContext["metrics"] extends keyof TelemetryMetrics ? true : false
>;
export type PropagationContract = Check<
	keyof InMemoryTelemetryContext["propagation"] extends keyof TelemetryPropagation ? true : false
>;
