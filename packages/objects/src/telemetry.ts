import { createTypedMetrics, createTypedSpanStarter, defineTelemetrySchema, NOOP_TELEMETRY_CONTEXT, NOOP_TELEMETRY_METRICS, type SpanAttributes, type TelemetryCarrier, type TelemetryContext, type TelemetrySpan, type TelemetryMetrics, type TypedTelemetryMetrics, type TypedSpanStarter, type TelemetrySpanDefinition, type TelemetryStartAttributeDefinition, type TelemetryAttributeDefinition } from "@axi/telemetry";
import type { Address } from "./contracts/index.ts";
import { isObjectsError } from "./data/index.ts";

const text = { type: "string", required: true, description: "A text field." } as const;
const number = { type: "number", required: true, description: "A numeric field." } as const;
const host = { ...text, cardinality: "high", description: "Host address, or client when unaddressed." } as const;
const object = { ...text, cardinality: "high", description: "Object type and parameters." } as const;
const caller = { ...text, required: false, cardinality: "high" } as const;
const common = { "objects.host": host, type: text, object };
const outcome = { type: "string", description: "Operation outcome." } as const;
const status = { default: "ok", errorWhen: "Failed operations record a bounded error category and message; cancellation remains ok." } as const;
const commit = { description: "An adopted transaction.", attributes: { documents: number, ops: number, rows: number, duration: number } } as const;
const retry = { description: "Delay before retry.", attributes: { backoff: number } } as const;
const span = <const A extends Record<string, TelemetryStartAttributeDefinition>, const E extends Record<string, TelemetryAttributeDefinition>>(
	description: string, parents: TelemetrySpanDefinition["parents"], startAttributes: A, endAttributes: E,
) => ({ description, parents, startAttributes, endAttributes, status });
const any = { kind: "any" } as const;
const root = { kind: "root_or_external" } as const;
const counter = (description: string) => ({ kind: "counter", description, attributes: {} }) as const;
const gauge = (description: string) => ({ kind: "upDownCounter", description, attributes: {} }) as const;
const duration = (description: string) => ({ kind: "histogram", description, unit: "ms", attributes: {} }) as const;
export const OBJECTS_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"objects.call": span("Remote method invocation by a consumer.", any, { ...common, member: text, "address.kind": text, "objects.principal": caller }, { outcome }),
		"objects.method": { ...span("Method execution by a provider.", any, { ...common, member: text, "principal.kind": text, "objects.principal": caller }, { outcome }), events: { "objects.commit": commit } },
		"objects.relay": span("Forwarded hold or method invocation.", root, { "objects.host": host, type: text, member: text, "upstream.kind": text }, { outcome }),
		"objects.hold": span("Hold acquisition until a first answer.", any, { ...common, "address.kind": text }, { outcome }),
		"objects.activate": { ...span("One activation or resumed activation.", root, { ...common, attempt: number }, { outcome }), events: { "objects.park": { description: "Activation waiting on a dependency.", attributes: { cause: text } }, "objects.retry": retry } },
		"objects.open": span("Opening an object's native resource.", { kind: "spans", spans: ["objects.activate"] }, { "objects.host": host, type: text, native: number }, {}),
		"objects.close": span("Closing an object's native resource.", root, { "objects.host": host, type: text, native: number, reason: text }, {}),
		"objects.load": span("Initial facet publication.", any, { "objects.host": host, plugins: number }, { failed: { type: "number", description: "Rejected facets." } }),
		"objects.reload": { ...span("Facet replacement and affected objects.", any, { "objects.host": host, plugins: number }, { added: number, changed: number, removed: number, failed: number, fates: number }), events: { "objects.reload.fate": { description: "An affected object's result.", attributes: { object, fate: text } } } },
		"objects.resolve": span("Resolving a routed host address.", root, { "objects.host": host, kind: text, address: object }, { outcome }),
		"objects.revoke": span("Revoking principals and their work.", any, { "objects.host": host }, { count: number }),
		"objects.routine": { ...span("A source-triggered routine invocation.", root, { ...common, routine: text, position: number }, { outcome }), events: { "objects.commit": commit, "objects.retry": retry } },
		"objects.job": { ...span("One job intent, execution or finish phase.", any, { "objects.host": host, object, job: text, phase: text, "job.id": { ...caller } }, { outcome, "job.id": { type: "string", cardinality: "high", description: "Persisted run identifier." } }), events: { "objects.commit": commit, "objects.retry": retry } },
		"objects.http": { ...span("A routed HTTP request.", root, { "objects.host": host, method: text, route: text }, { status: { type: "number", description: "Response status." } }), events: { "objects.commit": commit } },
	},
	metrics: {
		"objects.events.emitted": counter("Emitted event values."),
		"objects.events.sent": counter("Event entries sent to holders."),
		"objects.events.encodes": counter("Encoded event representations."),
		"objects.events.dropped": {
			...counter("Dropped event entries."),
			attributes: { reason: { ...text, values: ["window", "too_large", "mapping"] } },
		},
		"objects.data.compilations": counter("Compiled validators."),
		"objects.data.validations": counter("Validated values."),
		"objects.data.walks": counter("Full-value traversals."),
		"objects.link.checks": counter("Checked wire messages."),
		"objects.link.deflates": counter("Compressed parts."),
		"objects.link.inflates": counter("Decompressed parts."),
		"objects.link.encodes": counter("Encoded state payloads."),
		"objects.store.loads": counter("Loaded documents."),
		"objects.store.commits": counter("Storage commits."),
		"objects.store.statements": counter("Committed SQL statements."),
		"objects.query.runs": counter("Live query executions."),
		"objects.cycle.visits": counter("Visited dependency nodes."),
		"objects.derive.computes": counter("Derived-value computations."),
		"objects.derive.diffs": counter("Derived-value comparisons."),
		"objects.registry.composes": counter("Registry compositions."),
		"objects.registry.adapts": counter("Adapted registry values."),
		"objects.contract.adapts": counter("Adapted contract state."),
		"objects.link.state_messages": counter("Outgoing local state messages."),
		"objects.link.bytes": { kind: "counter", unit: "By", description: "Encoded link bytes.", attributes: { direction: { ...text, values: ["sent", "received"] } } },
		"objects.commit.duration": duration("Transaction adoption latency."),
		"objects.calls.in_flight": gauge("Active method invocations."),
		"objects.holds.active": gauge("Holds placed on this host."),
		"objects.links.open": gauge("Open host links."),
		"objects.park.duration": duration("Dependency wait duration."),
		"objects.backpressure.wait": duration("State flow-control wait duration."),
	},
});
export type ObjectsSpanName = keyof typeof OBJECTS_TELEMETRY_SCHEMA.spans;
export type ObjectsMetrics = TypedTelemetryMetrics<readonly [typeof OBJECTS_TELEMETRY_SCHEMA]>;
export function objectsSpans(parent: TelemetryContext): TypedSpanStarter<readonly [typeof OBJECTS_TELEMETRY_SCHEMA]> { return createTypedSpanStarter(parent, [OBJECTS_TELEMETRY_SCHEMA]); }
const instruments = new WeakMap<TelemetryMetrics, ObjectsMetrics>();
export function objectsMetrics(source: TelemetryMetrics | undefined): ObjectsMetrics {
	const metrics = source ?? NOOP_TELEMETRY_METRICS;
	let cached = instruments.get(metrics);
	if (!cached) {
		const typed = createTypedMetrics(metrics, [OBJECTS_TELEMETRY_SCHEMA]);
		const cache = new Map<string, unknown>();
		const get = (kind: "counter" | "upDownCounter" | "histogram", name: string): unknown => {
			let value = cache.get(name);
			if (!value) { value = (typed[kind] as (name: string) => unknown)(name); cache.set(name, value); }
			return value;
		};
		cached = { counter: (name) => get("counter", name), upDownCounter: (name) => get("upDownCounter", name), histogram: (name) => get("histogram", name) } as ObjectsMetrics;
		instruments.set(metrics, cached);
	}
	return cached;
}
export function countingOnly(metrics: TelemetryMetrics): TelemetrySpan { return { ...NOOP_TELEMETRY_CONTEXT, metrics }; }
export const MAX_MESSAGE = 500;
export function capped(text: string): string { return text.slice(0, 256); }

export function untraced(context: TelemetryContext): boolean {
	return context.startSpan === NOOP_TELEMETRY_CONTEXT.startSpan;
}
export function hostAttribute(address: Address | undefined): string {
	return (address?.key ?? "client").slice(0, 256);
}
export function spanFailed(span: TelemetrySpan, name: string, error: unknown): void {
	span.setStatus({ status: "error", error: { name, message: (error instanceof Error ? error.message : String(error)).slice(0, 500) } });
}
export function ended(span: TelemetrySpan, category: string, error: unknown, signal?: AbortSignal): "aborted" | "error" {
	if (signal?.aborted || isObjectsError(error, "aborted")) {
		span.setStatus({ status: "ok" });
		return "aborted";
	}
	spanFailed(span, category, error);
	return "error";
}
export function parentOf(carrier: TelemetryCarrier | undefined, adapter: TelemetryContext): TelemetryContext {
	return untraced(adapter) ? adapter : adapter.propagation?.extract(carrier) ?? adapter;
}
export function carrierOf(context: TelemetryContext): TelemetryCarrier | undefined {
	return untraced(context) ? undefined : context.propagation?.inject(context);
}
export class OpenSpan {
	#span = NOOP_TELEMETRY_CONTEXT;
	readonly #completion = Promise.withResolvers<void>();
	#ended = false;
	constructor(parent: TelemetryContext, name: string, attributes: SpanAttributes) {
		void parent.startSpan({ name, attributes }, (span) => {
			this.#span = span;
			return this.#completion.promise;
		});
	}
	get span(): TelemetrySpan { return this.#span; }
	get ended(): boolean { return this.#ended; }
	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#completion.resolve();
	}
	endWhen(work: Promise<unknown>, category: string, signal?: AbortSignal): void {
		void work.then(
			() => { this.#span.setAttributes({ outcome: "ok" }); this.end(); },
			(error) => { this.#span.setAttributes({ outcome: ended(this.#span, category, error, signal) }); this.end(); },
		);
	}
}
