import type { TelemetryMetricDefinition, TelemetryMetrics } from "./metrics.ts";

export type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];
export interface SpanAttributes {
	[name: string]: AttributeValue | undefined;
}
export type TelemetryCarrier = Record<string, string>;
export interface TelemetryPropagation {
	inject(context: TelemetryContext): TelemetryCarrier | undefined;
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext;
}
export interface SpanLink {
	context: TelemetryContext;
	attributes?: SpanAttributes;
}
export interface SpanOptions {
	name: string;
	attributes?: SpanAttributes;
	links?: readonly SpanLink[];
}
export type SpanStatus = { status: "ok" } | { status: "error"; error?: { name: string; message: string } };
export interface StoredSpan {
	readonly id: string;
	readonly traceId: string;
	readonly parentId?: string;
	readonly name: string;
	readonly startedMs: number;
	readonly endedMs: number;
	readonly attributes: SpanAttributes;
	readonly events: readonly { readonly name: string; readonly timeMs: number; readonly attributes: SpanAttributes }[];
	readonly links: readonly {
		readonly traceId: string;
		readonly spanId: string;
		readonly attributes?: SpanAttributes;
	}[];
	readonly status: SpanStatus;
}
export interface StoredTrace {
	readonly traceId: string;
	readonly spans: readonly StoredSpan[];
}
export interface TraceQuery {
	readonly name?: string;
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
	readonly errors?: true;
	readonly startMin?: number;
	readonly startMax?: number;
	readonly limit?: number;
	readonly cursor?: string;
}
export interface MetricQuery {
	readonly name: string;
	readonly startMin?: number;
	readonly startMax?: number;
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}
export interface StoredMetric {
	readonly intervalMs: number;
	readonly name: string;
	readonly kind: "counter" | "upDownCounter" | "histogram";
	readonly unit?: string;
	readonly attributes: SpanAttributes;
	readonly count: number;
	readonly sum: number;
	readonly min: number;
	readonly max: number;
}
export interface TelemetryStore {
	findTraces(query?: TraceQuery): Promise<{ traces: readonly StoredTrace[]; cursor?: string }>;
	getTrace(traceId: string): Promise<StoredTrace | undefined>;
	findMetrics(query: MetricQuery): Promise<readonly StoredMetric[]>;
}
export interface TelemetryContext {
	readonly metrics?: TelemetryMetrics;
	readonly propagation?: TelemetryPropagation;
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}
export interface TelemetrySpan extends TelemetryContext {
	addLink(link: SpanLink): void;
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}
export { NOOP_TELEMETRY_CONTEXT, NOOP_TELEMETRY_METRICS, NOOP_TELEMETRY_PROPAGATION } from "./noop.ts";
export { createTypedMetrics } from "./metrics.ts";
export type {
	HistogramOptions,
	InstrumentOptions,
	SchemaTelemetryCounter,
	SchemaTelemetryHistogram,
	TelemetryCounter,
	TelemetryHistogram,
	TelemetryMetricAttributeDefinition,
	TelemetryMetricDefinition,
	TelemetryMetrics,
	TelemetryUpDownCounter,
	TypedTelemetryMetrics,
} from "./metrics.ts";
type Scalars = { string: string; number: number; boolean: boolean };
export type TelemetryAttributeType = keyof Scalars | `${keyof Scalars}[]`;
export interface TelemetryAttributeMetadata {
	description: string;
	sensitive?: boolean;
	cardinality?: "low" | "high";
}
export type TelemetryAttributeDefinition = TelemetryAttributeMetadata &
	{
		[K in keyof Scalars]:
			| { type: K; values?: readonly Scalars[K][]; examples?: readonly Scalars[K][] }
			| { type: `${K}[]`; elementValues?: readonly Scalars[K][]; examples?: readonly (readonly Scalars[K][])[] };
	}[keyof Scalars];
export type TelemetryStartAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };
export type TelemetryEventAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };
export interface TelemetryEventDefinition {
	description: string;
	attributes: Record<string, TelemetryEventAttributeDefinition>;
}
export type TelemetryParentDefinition =
	| { kind: "any" }
	| { kind: "root_or_external" }
	| { kind: "spans"; spans: readonly string[] };
export interface TelemetrySpanDefinition {
	description: string;
	parents: TelemetryParentDefinition;
	startAttributes: Record<string, TelemetryStartAttributeDefinition>;
	endAttributes: Record<string, TelemetryAttributeDefinition>;
	events?: Record<string, TelemetryEventDefinition>;
	status: { default: "ok"; errorWhen: string };
}
export interface TelemetrySchemaDefinition {
	version: number;
	spans: Record<string, TelemetrySpanDefinition>;
	metrics?: Record<string, TelemetryMetricDefinition>;
}
export function defineTelemetrySchema<const T extends TelemetrySchemaDefinition>(schema: T): T {
	return schema;
}
type Attribute<D extends TelemetryAttributeDefinition> = D extends { type: infer K extends keyof Scalars }
	? D extends { values: readonly (infer V)[] }
		? V
		: Scalars[K]
	: D extends { type: `${infer K extends keyof Scalars}[]` }
		? readonly (D extends { elementValues: readonly (infer V)[] } ? V : Scalars[K])[]
		: never;
type Definitions = Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>;
type RequiredNames<D extends Definitions> = { [K in keyof D]-?: D[K]["required"] extends true ? K : never }[keyof D];
export type InferRequiredAndOptionalAttributes<D extends Definitions> = keyof D extends never
	? Record<string, never>
	: { [K in RequiredNames<D>]: Attribute<D[K]> } & { [K in Exclude<keyof D, RequiredNames<D>>]?: Attribute<D[K]> };
export type InferStartAttributes<D extends Record<string, TelemetryStartAttributeDefinition>> =
	InferRequiredAndOptionalAttributes<D>;
export type InferEventAttributes<D extends Record<string, TelemetryEventAttributeDefinition>> =
	InferRequiredAndOptionalAttributes<D>;
export type InferOptionalAttributes<D extends Record<string, TelemetryAttributeDefinition>> = keyof D extends never
	? Record<string, never>
	: { [K in keyof D]?: Attribute<D[K]> };
export type ExactTelemetryAttributes<Expected, Actual extends Expected> = Actual &
	Record<Exclude<keyof Actual, keyof Expected>, never>;
export type TelemetrySchemaSpanName<S extends TelemetrySchemaDefinition> = keyof S["spans"] & string;
export type TelemetrySchemaSpanStartAttributes<
	S extends TelemetrySchemaDefinition,
	N extends TelemetrySchemaSpanName<S>,
> = InferStartAttributes<S["spans"][N]["startAttributes"]>;
export type TelemetrySchemaSpanEndAttributes<
	S extends TelemetrySchemaDefinition,
	N extends TelemetrySchemaSpanName<S>,
> = InferOptionalAttributes<S["spans"][N]["endAttributes"]>;
type Events<S extends TelemetrySchemaDefinition, N extends TelemetrySchemaSpanName<S>> = S["spans"][N] extends {
	events: infer E extends Record<string, TelemetryEventDefinition>;
}
	? E
	: Record<never, never>;
export type TelemetrySchemaSpanEventName<
	S extends TelemetrySchemaDefinition,
	N extends TelemetrySchemaSpanName<S>,
> = keyof Events<S, N> & string;
type EventDefs<
	S extends TelemetrySchemaDefinition,
	N extends TelemetrySchemaSpanName<S>,
	E extends TelemetrySchemaSpanEventName<S, N>,
> = Events<S, N>[E] extends { attributes: infer D extends Record<string, TelemetryEventAttributeDefinition> }
	? D
	: Record<never, never>;
export type TelemetrySchemaSpanEventAttributes<
	S extends TelemetrySchemaDefinition,
	N extends TelemetrySchemaSpanName<S>,
	E extends TelemetrySchemaSpanEventName<S, N>,
> = InferEventAttributes<EventDefs<S, N, E>>;
type EventArguments<D extends Definitions, A extends InferEventAttributes<D>> = [RequiredNames<D>] extends [never]
	? [attributes?: ExactTelemetryAttributes<InferEventAttributes<D>, A>]
	: [attributes: ExactTelemetryAttributes<InferEventAttributes<D>, A>];
export type SchemaTelemetrySpan<S extends TelemetrySchemaDefinition, N extends TelemetrySchemaSpanName<S>> = Omit<
	TelemetrySpan,
	"addEvent" | "setAttributes"
> & {
	addEvent<
		E extends TelemetrySchemaSpanEventName<S, N>,
		const A extends InferEventAttributes<EventDefs<S, N, E>> = InferEventAttributes<EventDefs<S, N, E>>,
	>(name: E, ...args: EventArguments<EventDefs<S, N, E>, A>): void;
	setAttributes<const A extends TelemetrySchemaSpanEndAttributes<S, N>>(
		attributes: ExactTelemetryAttributes<TelemetrySchemaSpanEndAttributes<S, N>, A>,
	): void;
};
export type TelemetrySchemaSpanUnion<S extends TelemetrySchemaDefinition> = {
	[N in TelemetrySchemaSpanName<S>]: {
		name: N;
		startAttributes: TelemetrySchemaSpanStartAttributes<S, N>;
		endAttributes: TelemetrySchemaSpanEndAttributes<S, N>;
		events: { [E in TelemetrySchemaSpanEventName<S, N>]: TelemetrySchemaSpanEventAttributes<S, N, E> };
	};
}[TelemetrySchemaSpanName<S>];
type Schemas = readonly [TelemetrySchemaDefinition, ...TelemetrySchemaDefinition[]];
type Names<S extends TelemetrySchemaDefinition> = S extends TelemetrySchemaDefinition
	? TelemetrySchemaSpanName<S>
	: never;
type Start<S extends TelemetrySchemaDefinition, N extends string> = S extends TelemetrySchemaDefinition
	? N extends TelemetrySchemaSpanName<S>
		? TelemetrySchemaSpanStartAttributes<S, N>
		: never
	: never;
type Span<S extends TelemetrySchemaDefinition, N extends string> = S extends TelemetrySchemaDefinition
	? N extends TelemetrySchemaSpanName<S>
		? SchemaTelemetrySpan<S, N>
		: never
	: never;
type Duplicates<S extends readonly TelemetrySchemaDefinition[], Seen extends string = never> = S extends readonly [
	infer First extends TelemetrySchemaDefinition,
	...infer Rest extends readonly TelemetrySchemaDefinition[],
]
	? Extract<TelemetrySchemaSpanName<First>, Seen> | Duplicates<Rest, Seen | TelemetrySchemaSpanName<First>>
	: never;
type Unique<S extends Schemas> = [Duplicates<S>] extends [never]
	? unknown
	: { readonly "duplicate telemetry span names": Duplicates<S> };
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
type Starter<S extends Schemas, N extends Names<S[number]>> = <const A extends Start<S[number], N>, R>(
	name: N,
	attributes: ExactTelemetryAttributes<Start<S[number], N>, A>,
	callback: (span: Span<S[number], N>, child: TypedSpanStarter<S>) => R | Promise<R>,
) => Promise<R>;
export type TypedSpanStarter<S extends Schemas> = Intersection<
	{ [N in Names<S[number]>]: Starter<S, N> }[Names<S[number]>]
>;
function starter<S extends Schemas>(parent: TelemetryContext): TypedSpanStarter<S> {
	const start = (
		name: Names<S[number]>,
		attributes: SpanAttributes,
		callback: (span: Span<S[number], Names<S[number]>>, child: TypedSpanStarter<S>) => unknown,
	): Promise<unknown> =>
		parent.startSpan({ name, attributes }, (span) =>
			callback(span as Span<S[number], Names<S[number]>>, starter<S>(span)),
		);
	return start as TypedSpanStarter<S>;
}
export function createTypedSpanStarter<const S extends Schemas>(
	context: TelemetryContext,
	_schemas: S & Unique<S>,
): TypedSpanStarter<S> {
	return starter<S>(context);
}
export type {
	RecordedTelemetryEvent,
	RecordedTelemetryLink,
	RecordedTelemetryMeasurement,
	RecordedTelemetrySpan,
} from "./memory.ts";
export { InMemoryTelemetryContext } from "./memory.ts";
