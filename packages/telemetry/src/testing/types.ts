import type { TelemetryContext, TelemetryMetrics, TelemetryPropagation } from "../index.ts";
import type { RecordedTelemetryMeasurement, RecordedTelemetrySpan } from "../memory.ts";

export interface TelemetryAdapterFixture extends AsyncDisposable {
	readonly context: TelemetryContext;
	readonly propagation?: TelemetryPropagation;
	readonly metrics?: TelemetryMetrics;
	getMetrics?(): Promise<readonly RecordedTelemetryMeasurement[]>;
	getSpans(): Promise<readonly RecordedTelemetrySpan[]>;
}
export type TelemetryAdapterFixtureFactory = () => Promise<TelemetryAdapterFixture>;
export interface TelemetryAdapterConformanceCase {
	readonly group: string;
	readonly name: string;
	run(): Promise<void>;
}
