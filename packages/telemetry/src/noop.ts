import type { SpanOptions, TelemetryPropagation, TelemetrySpan } from "./index.ts";
import type { TelemetryCounter, TelemetryHistogram, TelemetryMetrics, TelemetryUpDownCounter } from "./metrics.ts";

function startSpan<T>(_options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
	try {
		return Promise.resolve(callback(inert));
	} catch (error) {
		return Promise.reject(error);
	}
}
export const NOOP_TELEMETRY_PROPAGATION: TelemetryPropagation = Object.freeze({
	inject: () => undefined,
	extract: () => NOOP_TELEMETRY_CONTEXT,
});
const counter: TelemetryCounter = Object.freeze({ add() {} });
const active: TelemetryUpDownCounter = Object.freeze({ add() {} });
const histogram: TelemetryHistogram = Object.freeze({ record() {} });
export const NOOP_TELEMETRY_METRICS: TelemetryMetrics = Object.freeze({
	counter: () => counter,
	upDownCounter: () => active,
	histogram: () => histogram,
});
const inert: TelemetrySpan = Object.freeze({
	metrics: NOOP_TELEMETRY_METRICS,
	propagation: NOOP_TELEMETRY_PROPAGATION,
	startSpan,
	addLink() {},
	addEvent() {},
	setAttributes() {},
	setStatus() {},
});
export const NOOP_TELEMETRY_CONTEXT: TelemetrySpan = inert;
