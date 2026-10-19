# Telemetry specification

## Entry points

`@axi/telemetry` exports runtime contracts, schemas, disabled adapters, and the memory adapter. `@axi/telemetry/testing` exports adapter cases and fixture types. The root runtime has no external dependencies.

## Context and span lifecycle

`TelemetryContext.startSpan(options, callback)` returns a promise and invokes the callback synchronously, exactly once. The callback receives a `TelemetrySpan`, which also starts child spans. `SpanOptions` contains `name`, optional `attributes`, and optional `links`.

A normal return or fulfilled promise produces an `ok` status unless an explicit status was set. A synchronous throw becomes a rejected promise with the same rejection value. Asynchronous rejection preserves that value too. Error recording must not replace the business error.

| Span method | Behavior |
| --- | --- |
| `startSpan(options, callback)` | Starts a child while the parent is active. |
| `setAttributes(attributes)` | Merges defined values. Later values replace earlier values. |
| `addEvent(name, attributes?)` | Appends an event in call order. |
| `setStatus(status)` | Sets the explicit status. The last successful call wins. |
| `addLink(link)` | Appends a relationship without changing the parent. |

Recording methods are synchronous and non-throwing. A failed recording call leaves no partial update. After settlement, recording calls have no effect. A settled span's `startSpan()` still executes the child callback and preserves its result, but records no child.

`SpanStatus` is `{ status: "ok" }` or `{ status: "error", error?: { name, message } }`. Explicit status survives a later callback rejection. A returned error result is ordinary data until the caller sets an error status.

`AttributeValue` accepts strings, numbers, booleans, and readonly arrays of each scalar type. `SpanAttributes` maps names to values or `undefined`. Undefined values are ignored. The memory adapter copies arrays and returns detached snapshots.

Callers pass parent contexts explicitly. There is no global current span and no public `end()` method.

Contexts expose optional `metrics` and `propagation` capabilities. Child spans and extracted parents carry the same adapter objects. Inactive descendants keep these capabilities even though they record no spans. A completed span can therefore retain its adapter. Hosts own root adapters; invocation contexts carry callback spans. A tracing-only adapter can implement `startSpan()` without metrics or propagation.

## Propagation and links

`TelemetryPropagation` is an optional adapter capability. `inject(context)` returns a detached `TelemetryCarrier` or `undefined` for an unknown context. `extract(carrier)` returns a receiver-owned parent context. Missing, malformed, unreadable, and unknown carriers fall back to the receiver's root.

`TelemetryCarrier` is `Record<string, string>`. Its encoding belongs to the adapter. Transport code serializes carriers, not contexts or spans. Injection and extraction are synchronous, passive, and non-throwing. Transport owners enforce carrier size limits. Correlation data grants no identity, permissions, or ownership.

`SpanLink` contains a target `context` and optional `attributes`. Links append in order and copy their attributes. Known settled targets remain injectable and linkable. Unknown targets are ignored. A settled source accepts no additional links.

## Measurements

`TelemetryMetrics` is an optional adapter capability:

| Factory | Instrument method | Accepted values |
| --- | --- | --- |
| `counter(name, options?)` | `add(value, attributes?)` | Finite, nonnegative values. |
| `upDownCounter(name, options?)` | `add(value, attributes?)` | Finite signed values. |
| `histogram(name, options?)` | `record(value, attributes?, context?)` | Finite signed values. |

`InstrumentOptions` contains optional `description` and `unit` strings. `HistogramOptions` adds optional `boundaries`. Boundaries must be finite and strictly increasing. They are hints for the adapter's aggregation policy.

The optional histogram context identifies an exemplar span. An absent or unknown context produces a null exemplar in the memory adapter. Counter methods have no typed context argument.

Factories and recording methods are synchronous and non-throwing. Invalid metadata, unreadable attributes, nonfinite values, negative counter values, and invalid boundaries suppress the affected call. A malformed call produces no partial measurement.

Metric attributes use bounded, low-cardinality values. The low-level API does not inspect application meaning or filter sensitive values automatically.

## Disabled adapters

`NOOP_TELEMETRY_CONTEXT` uses one shared frozen span. It preserves callback timing, results, and rejection identity without reading diagnostic payloads.

`NOOP_TELEMETRY_PROPAGATION.inject()` returns `undefined`. Its `extract()` returns `NOOP_TELEMETRY_CONTEXT`. Neither method inspects its arguments.

`NOOP_TELEMETRY_METRICS` returns shared frozen instruments. Their methods inspect and retain no arguments.

## Memory adapter

`InMemoryTelemetryContext` implements `TelemetryContext`, `TelemetryPropagation`, and `TelemetryMetrics`. Each instance creates a UUID scope with `crypto.randomUUID()`. Span IDs start at one and increase within that scope.

The adapter's carrier uses `axi-memory-scope` and `axi-memory-span`. These keys belong to this codec. Other adapters may use another encoding. Extraction accepts own fields, string values, a lowercase UUID scope, and a positive safe-integer span string. Extra string fields are ignored.

A known same-scope span produces a local parent ID. A different scope or unknown ID retains the parent carrier with a null local parent ID. Extracted contexts remain valid after the original span settles. They can record continuation under the saved identity. Calling `startSpan()` on the settled span object itself remains inert for recording.

`getSpans()` returns detached `RecordedTelemetrySpan` records in start order:

- Numeric `id` and nullable local `parentId`.
- Carrier-shaped `context` and nullable `parentContext`.
- Ordered `links`, `events`, and merged `attributes`.
- Current `status` and `settled` flag.
- An `endSequence` assigned on settlement.

Roots have null parent fields. Remote children have a null `parentId` and non-null `parentContext`. `RecordedTelemetryEvent` contains `name` and copied `attributes`. `RecordedTelemetryLink` contains a target carrier and copied `attributes`.

`getMetrics()` returns detached `RecordedTelemetryMeasurement` records in call order. Each record contains `kind`, `name`, optional instrument metadata, `value`, copied `attributes`, and a nullable exemplar `context`. The adapter keeps a measurement log, not aggregated counters or histogram buckets.

The memory adapter records no timestamps, has no storage bound, and provides no exporter or flush operation. Applications own the recording scope's lifetime.

## Schemas

`TelemetrySchemaDefinition` contains a version, span definitions, and optional metric definitions. `defineTelemetrySchema()` returns its argument unchanged. Schemas are serializable data and perform no runtime validation.

A span definition contains its description, parent rule, start attributes, end attributes, optional events, and status description. Parent rules are `any`, `root_or_external`, or `spans` with a list of names. They describe intent and are not enforced by the adapter.

Start and event attributes declare whether they are required. End attributes are optional. Both sets occupy the same recorded attribute bag. End attributes may be written any time before settlement.

Attribute metadata contains a description and optional sensitivity, cardinality, and examples. Scalars can declare `values`; arrays can declare `elementValues`. These declarations constrain inferred TypeScript types.

`createTypedSpanStarter(context, schemas)` constrains span names, attributes, and events. Its callback receives a schema-specific span and a child starter bound to that span. It rejects duplicate literal names, unknown keys, missing required attributes, invalid closed-set values, and undeclared events at compile time. Narrow union-valued names before selecting their attributes. The helper does not inspect or retain schemas at runtime.

`TelemetryMetricDefinition` declares its description, kind, attributes, optional unit, and histogram boundaries. Only histograms declare boundaries. Metric attributes permit `cardinality: "low"` and reject `"high"`.

`createTypedMetrics(adapter, schemas)` constrains instrument names, kinds, and measurement arguments at compile time. It collects definitions at runtime and forwards the selected definition to each factory. It retains that metadata and does not validate measurement attributes at runtime.

```ts
import { createTypedMetrics, defineTelemetrySchema, InMemoryTelemetryContext } from "@axi/telemetry";

const schema = defineTelemetrySchema({
	version: 1,
	spans: {},
	metrics: {
		completed: {
			kind: "counter",
			description: "Completed operations",
			attributes: {
				result: { type: "string", values: ["ok", "error"], required: true, description: "Outcome" },
			},
		},
	},
} as const);
const adapter = new InMemoryTelemetryContext();
createTypedMetrics(adapter, [schema]).counter("completed").add(1, { result: "ok" });
console.log(adapter.getMetrics()[0].value);
```

```text
1
```

Schema type helpers include `TelemetrySchemaSpanName`, `TelemetrySchemaSpanStartAttributes`, `TelemetrySchemaSpanEndAttributes`, `TelemetrySchemaSpanEventName`, `TelemetrySchemaSpanEventAttributes`, `SchemaTelemetrySpan`, `TelemetrySchemaSpanUnion`, and `TypedSpanStarter`.

Attribute helpers are `InferStartAttributes`, `InferOptionalAttributes`, `InferEventAttributes`, `InferRequiredAndOptionalAttributes`, and `ExactTelemetryAttributes`. Metric views are `SchemaTelemetryCounter`, `SchemaTelemetryHistogram`, and `TypedTelemetryMetrics`.

## Adapter tests

`createTelemetryAdapterConformance(factory)` returns grouped cases. Each case acquires one fresh `TelemetryAdapterFixture` and disposes it asynchronously. The fixture supplies `context` and `getSpans()`.

Optional `propagation` enables JSON, fallback, and multi-hop checks. Optional `metrics` requires `getMetrics()` and enables ordered measurement, exemplar, and input-copy checks. All fixtures check links and span lifecycle behavior.

The suite checks result preservation, rejection identity, status precedence, atomic recording, post-settlement behavior, parent relationships, links, and unreadable inputs. `TelemetryAdapterFixtureFactory` and `TelemetryAdapterConformanceCase` describe factories and cases. Snapshot readers may flush their backend before returning.
