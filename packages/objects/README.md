# Objects

The [experimental composition API](docs/experimental.md) provides versioned contracts, hosts, routed references, observable sources, registries, object-owned documents, persisted jobs, and a shared SQLite Store. Internal Node components provide [HTTP hosting](docs/http.md), [worker processes](docs/workers.md), and [plugin loading](docs/plugins.md).

Objects manages typed objects, observable JSON state, references and resources. A host creates objects on demand and releases them when their owners leave. Links let the same contracts work across processes. Reload replaces implementations while keeping compatible state and resources.

## Run an object

Use TypeBox schemas to describe the input and members. Factories declare dependencies synchronously; the host opens resources and activates references afterward.

```ts
import { Type } from "typebox";
import { createHost, local, method } from "@axi/objects";

const Total = local("total", {
  version: 1,
  input: Type.Object({}),
  members: { value: Type.Number(), add: method(Type.Number()) },
});
const host = createHost({ self: "application" });
try {
  host.serve(Total, (_input, _principal, self) => {
    const value = self.state("value", Type.Number(), 0);
    return { value, add: (amount, ctx) => { value.change(ctx, n => n + amount); } };
  });
  const total = await host.get(Total, {});
  await total.add(3);
  console.log(total.value.value);
  total.release();
} finally {
  await host.close();
}
```

```text
3
```

Use `ctx.get()` for references that end with a call. Release references from `host.get()` yourself. Factories can declare `state`, `get`, `resource`, `on`, `task`, `derive`, `register` and `expose`. A facet groups service declarations for `load()` and `reload()`.

## Edit JSON independently

The delta tracker also works without a host. Preparation creates a candidate; adoption makes it current.

```ts
import { applyImmutable, track } from "@axi/objects/delta";

const tracker = track({ items: [] as string[] });
const change = tracker.beginChange();
change.state.items.push("ready");
const prepared = change.prepare();
tracker.adopt(prepared);
console.log(JSON.stringify(applyImmutable(prepared.base, prepared.ops)));
```

```text
{"items":["ready"]}
```

Transferred roots, published values and operation batches are immutable by contract. Draft insertions copy their inputs. Do not mutate a value after giving ownership to the tracker.

## Carry telemetry explicitly

Standalone invocation contexts always contain a telemetry span. Keep the root adapter in the host. Pass a callback span to `withTelemetry()` and start nested operations with `traceIn()`.

```ts
import { BACKGROUND_CONTEXT, traceIn, withTelemetry } from "@axi/objects/context";
import { InMemoryTelemetryContext } from "@axi/telemetry";

const telemetry = new InMemoryTelemetryContext();
await telemetry.startSpan({ name: "request" }, span => {
  const context = withTelemetry(span, BACKGROUND_CONTEXT);
  return traceIn({ name: "load" }, child => {
    child.telemetry.addEvent("loaded");
  }, context);
});
console.log(telemetry.getSpans().length);
```

```text
2
```

These helpers preserve cancellation and typed values. They do not automatically trace host methods or network traffic.

## Imports and documentation

| Import | Contents |
| --- | --- |
| `@axi/objects` | Contracts, hosts, cells, standalone state, registries, links and errors |
| `@axi/objects/context` | Invocation values, cancellation and telemetry |
| `@axi/objects/delta` | Drafts, revisions, diffs, replay and wire operations |
| `@axi/objects/output` | Bounded output and paced progress |
| `@axi/objects/node` | Facet loading, child processes and host management |
| `@axi/objects/sqlite` | Database interfaces, schema names and migrations |
| `@axi/objects/sqlite/node` | Node SQLite adapter |
| `@axi/objects/sqlite/cloudflare` | Durable Object SQLite adapter |
| `@axi/objects/next` | Experimental object host, contracts, documents, jobs, and Store |

Read the [tutorial](docs/tutorial.md) for connected examples, the [guide](docs/guide.md) for API usage, and the [specification](docs/spec.md) for contracts and limits.

The [Node plugin component](docs/plugins.md) is internal. It remains available in the source for development and testing, without a public package import.

Facets are trusted application code. The Node loader retains old module generations. Object cells survive compatible reloads, but disposal or process restart loses them unless the application explicitly persists them.

### SQLite telemetry

Import `createSqliteTelemetry` from `@axi/objects/telemetry-sqlite` and pass an open
SQLite database. Recording is synchronous and performs no SQL. A background flush
stores settled spans and completed ten-second metric intervals once per second.
Each flush captures one cutoff for completed intervals.
`close()` also stores partial intervals and leaves the database open.

The default queue holds 10,000 spans and 10,000 pending metric series/interval
pairs. In-flight writes count toward these bounds. Overflow increments
`droppedSpans` or `droppedMeasurements`. A write failure stops recording permanently;
`flush()` and `close()` reject with that failure. Stored data expires after seven
days by default. Configure these limits with `maxQueuedSpans` and `retentionMs`.

Use `getTrace()`, `findTraces()`, and `findMetrics()` to read committed data.
Flush before reading newly settled spans. Trace filters include the earliest span's
name and start time, errors anywhere in a trace, and attributes matching one span.

[API reference](docs/api.md)
