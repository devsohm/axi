# @axi/telemetry

Explicit spans, diagnostic context, and measurements for agent applications. The package includes an in-memory adapter, disabled adapters, typed schemas, and adapter tests. Applications own export, sampling, and storage policy.

## Record work

```ts
import { InMemoryTelemetryContext } from "@axi/telemetry";

const telemetry = new InMemoryTelemetryContext();
const duration = telemetry.histogram("load.duration", { unit: "ms" });
await telemetry.startSpan({ name: "load", attributes: { source: "disk" } }, async (span) => {
	span.addEvent("started");
	const count = await span.startSpan({ name: "read" }, () => 2);
	span.setAttributes({ count });
	duration.record(12, {}, span);
});
console.log(JSON.stringify(telemetry.getSpans().map((span) => span.name)));
console.log(telemetry.getMetrics()[0].value);
```

```text
["load","read"]
12
```

This records `load` and its child `read`, then prints `12` for the measurement. A callback starts synchronously once. Its returned value or promise controls settlement. Results and rejection values pass through unchanged.

Pass the callback span to nested work. There is no global current span and no public `end()` method. `NOOP_TELEMETRY_CONTEXT` runs the same callbacks without recording.

## Continue work in another process

```ts
import { InMemoryTelemetryContext } from "@axi/telemetry";

const sender = new InMemoryTelemetryContext();
const receiver = new InMemoryTelemetryContext();
const carrier = await sender.startSpan({ name: "submit" }, (span) => sender.inject(span));
if (!carrier) throw new Error("Missing diagnostic carrier");
const received = JSON.parse(JSON.stringify(carrier));
await receiver.extract(received).startSpan({ name: "process" }, () => 42);
console.log(receiver.getSpans()[0].parentContext !== null);
```

```text
true
```

Only the string-map carrier crosses the boundary. Adapter instances can live in separate processes. Incoming correlation is diagnostic data, not authorization. Use `links` or `span.addLink()` to relate work without changing its parent.

## Define a typed vocabulary

`defineTelemetrySchema()` preserves a schema as ordinary data. `createTypedSpanStarter()` constrains span names, attributes, and events. `createTypedMetrics()` constrains instrument names, kinds, and measurement attributes. These are compile-time checks. The low-level adapters do not validate application schemas.

See the [specification](docs/spec.md) for types, lifecycle rules, propagation, measurement limits, and schema behavior.

## Check an adapter

```ts
import { InMemoryTelemetryContext } from "@axi/telemetry";
import { createTelemetryAdapterConformance } from "@axi/telemetry/testing";

const cases = createTelemetryAdapterConformance(async () => {
	const context = new InMemoryTelemetryContext();
	return {
		context,
		propagation: context,
		metrics: context,
		getSpans: async () => context.getSpans(),
		getMetrics: async () => context.getMetrics(),
		async [Symbol.asyncDispose]() {},
	};
});
for (const test of cases) await test.run();
```

The testing subpath uses Node assertions. The root runtime uses no Node-specific imports. The memory adapter requires `crypto.randomUUID()` and retains records until its scope is discarded. It has no automatic flush or storage limit.

## Adapter capabilities

A context can expose optional `metrics` and `propagation` objects. The memory adapter exposes itself for both. Child spans, extracted parents and inactive descendants retain the same objects. Disabled spans expose disabled metrics and propagation. Applications retain the root adapter and pass callback spans to lower-level invocations. A span can therefore keep its adapter alive after settlement; releasing the span remains the caller's responsibility.
