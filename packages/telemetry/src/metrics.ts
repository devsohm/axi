import type {
	ExactTelemetryAttributes,
	InferRequiredAndOptionalAttributes,
	SpanAttributes,
	TelemetryContext,
	TelemetrySchemaDefinition,
	TelemetryStartAttributeDefinition,
} from "./index.ts";

export interface InstrumentOptions {
	description?: string;
	unit?: string;
}
export interface HistogramOptions extends InstrumentOptions {
	boundaries?: readonly number[];
}
export interface TelemetryCounter {
	add(value: number, attributes?: SpanAttributes): void;
}
export interface TelemetryUpDownCounter {
	add(value: number, attributes?: SpanAttributes): void;
}
export interface TelemetryHistogram {
	record(value: number, attributes?: SpanAttributes, context?: TelemetryContext): void;
}
export interface TelemetryMetrics {
	counter(name: string, options?: InstrumentOptions): TelemetryCounter;
	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter;
	histogram(name: string, options?: HistogramOptions): TelemetryHistogram;
}
export type TelemetryMetricAttributeDefinition = TelemetryStartAttributeDefinition & { cardinality?: "low" };
export type TelemetryMetricDefinition = {
	description: string;
	unit?: string;
	attributes: Record<string, TelemetryMetricAttributeDefinition>;
} & ({ kind: "counter" | "upDownCounter"; boundaries?: never } | { kind: "histogram"; boundaries?: readonly number[] });

type Schemas = readonly [TelemetrySchemaDefinition, ...TelemetrySchemaDefinition[]];
type Definitions<S extends TelemetrySchemaDefinition> = S extends {
	metrics: infer M extends Record<string, TelemetryMetricDefinition>;
}
	? M
	: Record<never, never>;
type Names<
	S extends TelemetrySchemaDefinition,
	K extends TelemetryMetricDefinition["kind"],
> = S extends TelemetrySchemaDefinition
	? { [N in keyof Definitions<S>]: Definitions<S>[N] extends { kind: K } ? N : never }[keyof Definitions<S>] & string
	: never;
type Definition<S extends TelemetrySchemaDefinition, N extends string> = S extends TelemetrySchemaDefinition
	? N extends keyof Definitions<S>
		? Definitions<S>[N]
		: never
	: never;
type Duplicates<S extends readonly TelemetrySchemaDefinition[], Seen extends string = never> = S extends readonly [
	infer First extends TelemetrySchemaDefinition,
	...infer Rest extends readonly TelemetrySchemaDefinition[],
]
	? Extract<keyof Definitions<First>, Seen> | Duplicates<Rest, Seen | (keyof Definitions<First> & string)>
	: never;
type Attributes<D extends TelemetryMetricDefinition> = InferRequiredAndOptionalAttributes<D["attributes"]>;
type Arguments<D extends TelemetryMetricDefinition, A extends Attributes<D>> = {
	[N in keyof D["attributes"]]: D["attributes"][N]["required"] extends true ? N : never;
}[keyof D["attributes"]] extends never
	? [attributes?: ExactTelemetryAttributes<Attributes<D>, A>]
	: [attributes: ExactTelemetryAttributes<Attributes<D>, A>];

export type SchemaTelemetryCounter<D extends TelemetryMetricDefinition> = {
	add<const A extends Attributes<D> = Attributes<D>>(value: number, ...args: Arguments<D, A>): void;
};
export type SchemaTelemetryHistogram<D extends TelemetryMetricDefinition> = {
	record<const A extends Attributes<D> = Attributes<D>>(
		value: number,
		...args: [...Arguments<D, A>, context?: TelemetryContext]
	): void;
};
export interface TypedTelemetryMetrics<S extends Schemas> {
	counter<N extends Names<S[number], "counter">>(name: N): SchemaTelemetryCounter<Definition<S[number], N>>;
	upDownCounter<N extends Names<S[number], "upDownCounter">>(name: N): SchemaTelemetryCounter<Definition<S[number], N>>;
	histogram<N extends Names<S[number], "histogram">>(name: N): SchemaTelemetryHistogram<Definition<S[number], N>>;
}
export function createTypedMetrics<const S extends Schemas>(
	metrics: TelemetryMetrics,
	schemas: S &
		([Duplicates<S>] extends [never] ? unknown : { readonly "duplicate telemetry metric names": Duplicates<S> }),
): TypedTelemetryMetrics<S> {
	const definitions = new Map<string, TelemetryMetricDefinition>();
	for (const schema of schemas)
		for (const [name, definition] of Object.entries(schema.metrics ?? {})) definitions.set(name, definition);
	return {
		counter: (name: string) => metrics.counter(name, definitions.get(name)),
		upDownCounter: (name: string) => metrics.upDownCounter(name, definitions.get(name)),
		histogram: (name: string) => metrics.histogram(name, definitions.get(name)),
	} as unknown as TypedTelemetryMetrics<S>;
}
