# Object runtime guide

Define a contract, serve it on a host, then hold a reference to an object. References with the same type, normalized input and principal share an object. Release references when their owner no longer needs them.

| Import | Purpose |
| --- | --- |
| `@axi/chord` | Contracts, hosts, state, resources, registries and links. |
| `@axi/chord/context` | Cancellation and values attached to an invocation. |
| `@axi/chord/delta` | JSON drafts, prepared revisions, diffs and delta encoding. |
| `@axi/chord/output` | Output limits and progress delivery. |
| `@axi/chord/node` | Module loading and child-process management. |
| `@axi/chord/sqlite` | Database contracts and schema changes. |
| `@axi/chord/sqlite/node` | Node SQLite connections. |
| `@axi/chord/sqlite/cloudflare` | Cloudflare Durable Object SQLite connections. |

```ts
import { Type } from "typebox";
import { createHost, local, method } from "@axi/chord";

const Counter = local("counter", {
	version: 1,
	input: Type.Object({}),
	members: { count: Type.Number(), add: method(Type.Number()) },
});

const host = createHost({ self: null });
host.serve(Counter, (_input, _principal, self) => {
	const count = self.state("count", Type.Number(), 0);
	return {
		count,
		add(amount, ctx) {
			count.change(ctx, value => value + amount);
		},
	};
});

const counter = await host.get(Counter, {});
await counter.add(2);
console.log(counter.count.value);
counter.release();
await host.close();
```

Factories declare state, references, resources, listeners and tasks synchronously. Resources open before the object becomes live. Cleanup closes resources in reverse order and releases dependencies afterward.

A facet groups service declarations. Install facets with `host.install()` or `host.load()`. Reload them with `host.reload()`. Reload preparation checks contracts, state, resources and listeners before publishing a code version. A failed preparation retains the installed code.

Use remote contracts with memory, IPC or WebSocket links to reach objects on another host. The accepting host supplies the caller's principal. State updates follow the held object without requiring a subscriber. A reference created with `state: false` receives no state until another view requests it.

Node applications can import `nodeLoader`, `forkDriver`, `createHostManager` and `childControl` from `@axi/chord/node`. The loader refreshes modules within loaded facet directories. Its module cache lasts for the process lifetime.

Use `host.root()` to share an invocation context across calls. Contexts expire when their call or root finishes. Tasks start a fresh root for each call. Close the host to cancel work, dispose its objects and close its links.

## JSON revisions

`track(initial)` opens a revision sequence. Start an edit with `beginChange()`, edit its `state`, and call `prepare()`. Preparation returns a candidate and its operations. The current value changes only when you call `adopt(candidate)`. Abort a failed edit. Adopting one candidate invalidates competing edits from the previous revision.

The following rules apply to `track`, `prepareReplace`, `replicatedState` and replacement methods:

- Passing a root transfers ownership. Do not change it afterward.
- Roots must contain finite JSON values, dense plain arrays, and plain or null-prototype objects. They must have no cycles, accessors, symbols or shared containers at different paths. Validate external roots before passing them in.
- Draft assignments copy and validate their values. You keep ownership of the assigned input. An invalid insertion changes nothing.
- A draft expires after preparation, cancellation or another candidate's adoption. Retained draft handles expire too.
- Published revisions and operation batches are immutable by contract. They can share containers and are not frozen. Copy a value before handing it to code that can mutate it.
- A no-op adoption still advances the revision. Delta operations can differ in shape while producing the same final value.

Use `applyImmutable(previous, operations)` to replay a revision without changing the previous value. `applyImmutableBatches` shares one copy scope across an ordered backlog and returns only its final value. Mutable `apply` needs its own copy of the starting value and each batch; sharing those inputs between mutable replicas makes their values share containers.

Use one encoder and decoder per ordered delta stream. A replacement resets their path dictionaries. After a decode or replay error, discard that stream's decoder and recover from a replacement.

## Standalone observable state

`replicatedState(initial)` provides observable JSON state without a host. Its synchronous `change(context, callback)` publishes one committed value. A failed callback leaves the previous value in place. `replace(context, value)` transfers ownership of a new root.

`replicatedState(source, { onError })` attaches to an external revision source. Attachment captures a snapshot and then receives consecutive committed frames. A missing or repeated cursor ends the attachment and reports an error. Call `dispose()` to release it; its last value remains readable.

Subscriptions receive the initial value, context and delivery metadata. Each subscription waits for its own asynchronous callback before delivering its next value. It retains up to 100 pending deliveries; overflow keeps the newest update and any initial hydration that has not started. Delivery sequences can therefore skip. Unsubscribing drops pending work but does not cancel or join the callback already running. Callback failures are reported and later delivery continues. Object cells use the separate `Readable` subscription API.

## Contract compatibility

Use `local()` for objects confined to one host. Declare methods with `method()`, state with a schema, and native values with `opaque("name@version")`. A loading reference can distinguish those member kinds before its object is ready. Local method arguments and results are not checked on each call.

Use `remote()` for objects that can cross a link. Each contract declares its input schema, placement and variants. `hostNamed(name)` places all objects on one host. `hostFamily(prefix, key)` forms a host name from a required, nonempty string input field. References choose their destination from that placement. Consumers cannot override it.

Input normalization applies schema defaults, removes unknown fields and validates the result. The object address uses canonical input with default-valued fields omitted. Changing that identity rule requires a new type name. Use an optional schema property with a default when callers should be able to omit the property.

Two contracts with the same version can bind when the provider covers the consumer. Every requested member must exist with the same kind. Method arguments must accept the consumer's values; results and state must fit the consumer's schemas. Opaque identifiers must agree. A consumer of a void method ignores any result. Both sides must agree on whether the method takes arguments.

Breaking changes require a higher version and an `accepts` adapter for each older consumer version still supported. An adapter maps the current implementation to the older view. It cannot change placement. Contract fingerprints describe structure, not application meaning; a meaning change still requires a version bump even when schemas stay identical.

## Host and object lifecycle

| API | Behavior |
| --- | --- |
| `serve(type, factory, options)` | Registers a synchronous factory. Referenced lifetime is the default. |
| `hold(type, input, options)` | Returns a reference immediately; it may still be loading. |
| `get(type, input, options)` | Waits for a live reference and its requested state. Failure releases this reference. |
| `root(callback, options)` | Runs a short call tree with one principal, cancellation signal and code version. |
| `install(facet, options)` | Installs one facet synchronously, then awaits its host objects by default. |
| `load(facets, options)` | Resolves modules and installs the whole batch before awaiting host objects. |
| `ready()` | Waits for the host-object references present when called. |
| `registry(definition)` | Reads versioned registration tables and subscribes to table changes. |
| `invalidatePrincipal(match)` | Revokes matching external identities, objects and links. Patterns propagate to child hosts. |
| `close()` | Disposes objects before closing connections. |

The default readiness timeout is 60 seconds. A failed activation rejects waiting references; a later acquisition can retry. State reads before initial readiness throw `not_ready`. A method can wait for activation, but calling a reference inside a factory is an error.

Activation opens declared resources, waits for dependencies, initializes cells, then attaches derivations, listeners and tasks. Cell `init` functions run in parallel in separate roots after resources and references are ready. They must not wait for their own object, read another unfinished initializer, or create dependency cycles. Initializing a cell does not persist it.

Objects normally end after their last reference is released. A service's `linger` delays disposal. A local service with `lifetime: "host"` instead has one object with empty normalized input and the host's principal. It cannot have required input fields or linger. Only these host objects can register entries. A failed host-object activation is reported through `onError` and can be retried by a reload that changes its service.

`awaitHostObjects: false` leaves startup coordination to the application. A child whose host objects need its parent can load without the barrier, await a local bootstrap reference, announce readiness to its manager, then await `host.ready()`. The application must still handle later startup failures. `ready()` does not join tasks or provide a continuous health check.

Disposal stops tasks and listeners, waits for calls, closes resources in reverse opening order, then releases dependencies. Forced disposal first marks references gone and cancels calls. Bulk disposal handles referrers before their dependencies so resource cleanup can still use held objects. Cleanup attempts all steps and aggregates failures.

## Factory declarations

| Declaration | Ownership and reload behavior |
| --- | --- |
| `state(name, schema, initial, options)` | Keeps a named cell and value. A higher cell version permits migration; the schema cannot change without a version bump. |
| `get(type, input, options)` | Holds an object-owned reference, reused by address. |
| `resource(name, declaration)` | Keeps an open resource while its version, dependencies and exclusivity agree. |
| `on(name, source, handler)` | Holds a subscription and replaces its handler on reload. An optional selector chooses the event source. |
| `task(callback)` | Runs background work until cancellation; reload replaces the run. |
| `derive(sources, callback)` | Computes synchronous observable state; reload creates new derivations. |
| `register(registry, entries)` | Adds entries to the host object's versioned registry table. |
| `expose(resource)` | Exposes the open native resource value through a local member. |

Declaration names are unique within their kind and object. Factories only declare dependencies; resource values, unfinished cells and reference calls are unavailable inside them. Resources may explicitly depend on references or other resources of the same object.

A kept resource adopts its replacement declaration at commit, including its cleanup function. A replaced resource closes with the declaration that opened it. An open that finishes after cancellation closes its resulting value instead of publishing it.

State listeners receive the current value when attached. Replacing their source during reload attaches them again, so handlers must reconcile state rather than count notifications. Event subscriptions survive when their source and selector are unchanged; selector comparison also accepts equal function source text. Avoid selectors whose changing captured values are essential to their behavior.

Object state notifications are synchronous and ordered. Every changed cell and dependent value is installed before listeners run. Listener failures go to `onError`. `change()` callbacks and derivations must be synchronous. A value returned from `change()` replaces the draft and is always validated. Development mode additionally validates normal writes and exposed remote state. `replace()` transfers ownership; its optional `diff` controls whether to publish a structural diff or a whole-value replacement.

## Contexts and principals

The application supplies `self` and every link's principal. `principalKey` determines identity; include grant revisions and connection provenance when those distinguish callers. A principal with the same key as `self` is treated as the host itself. Objects are otherwise separate for each principal key.

An ingress root acts as its supplied principal. Methods, initializers, listeners and tasks inside an object act as the host. A context carries cancellation, root identity and code version. A nested call with that context stays in the call tree. Calls without a context, or calls made by long-lived task holders, start a fresh root.

Contexts expire when their call or root settles. A foreign host's context is refused. `ctx.get()` waits for readiness and releases the acquired reference when the call ends. Cancellation and readiness timeout release only that acquisition.

The separate `@axi/chord/context` API carries invocation values, cancellation and telemetry for code outside an object call. Use `withContextValue`, `withCancel`, `withAbortSignal`, `withoutAbortSignal` and `awaitWithContext`; `BACKGROUND_CONTEXT` has no caller cancellation. Every standalone `Context` has a `telemetry` member, defaulting to the no-op span. `withTelemetry(span, context)` replaces it in a derived context. Start a root span through your telemetry adapter, then pass its callback's span to this helper. `traceIn(options, callback, context)` starts a callback-managed child span and passes a context with that span. Both preserve typed values and cancellation. They do not automatically instrument hosts, calls or link frames. These values do not replace the host's call context.

## Reload transactions

A reload loads replacement facets and prepares every affected live object before publishing new code. Preparation records declarations, opens candidate nonexclusive resources, validates contracts and registry collisions, and stages subscriptions. It does not start candidate tasks or publish candidate state. An unsuccessful preparation rolls back candidates and leaves installed code in place.

Changing a cell version or replacing an exclusive resource requires a gate. Existing roots that already touched the object may finish. New old-version roots receive retryable `upgrade_conflict`; they are not queued. The gate waits up to `gateDeadline`, closes replaced exclusive resources, opens their replacements and migrates private state copies. Tasks stop at the gate; listener events wait for commit or rollback. A failed replacement attempts to reopen its old resource.

Commit installs state, implementations, tables and reference shapes in one synchronous publication step. Observers run afterward. An unexpected commit failure marks the host failed; it must not continue admitting work against a partially installed version.

The host keeps current and previous code versions. Existing roots use their original version. Before another reload, retirement waits up to `retireDeadline`, then cancels remaining old roots and grants a short cleanup period. A call for a version no longer retained receives `superseded`. Gated objects refuse older versions after commit even if other objects still retain them.

The coordinator prepares its direct child hosts and collects their votes before committing. Any failed vote aborts the transaction. It sends commit decisions before starting new-version work. A child that reconnects behind the coordinator is fenced until reconciliation finishes. Cluster module lists use the longest matching host-name prefix. Clients observe changes but do not vote or send code-version roots.

## Links and remote state

`connect()` supplies the parent link. `accept()` supplies authenticated downstream links; a host link also needs a configured name. Browser peers are clients. `acceptWebSockets()` buffers incoming frames while its principal callback runs and refuses unauthenticated sockets.

`route(prefix, { authorize, resolve, principal })` controls relayed access. Authorization runs before and after link resolution, and revocation is checked across awaits. A known child is not sufficient authorization. Forwarded principals and reload control frames are accepted only from the configured parent.

Remote references with the same address, principal and consumer fingerprint share one binding. Views retain their own status, callbacks and release ownership. A shape is installed only after all its required snapshots arrive. Later frames carry per-member deltas or resets. The binding retains its last hydrated values during reconnect, but in-flight calls reject when their link ends; whether those calls executed is unknown.

Links use protocol version 4. Mismatched versions invoke `onProtocolMismatch` and close; there is no protocol negotiation. Ping intervals and timeouts detect lost peers. `maxCalls` limits admitted concurrent calls and rejects excess work immediately.

Acknowledgements regulate state traffic. The default state window is 256 KiB; queued operations are bounded by `pendingCap`, defaulting to four windows. Stalled streams collapse to current-value resets. Method results and other control traffic can pass waiting state. A new reference's initial unit bypasses waiting state so unrelated streams cannot prevent its first hydration. IPC links do not report encoded sizes and are not windowed.

## Output and SQLite helpers

`boundOutput()` selects a head or tail window without splitting UTF-8 characters. `OutputBuffer` accepts string or byte chunks, handles split characters, tracks dropped bytes and lines, and sanitizes display control characters. Call `end()` when the stream finishes. Skipped-output metadata is accepted only for tail retention.

`Progress` coalesces writes and spaces them by the minimum interval and written size at 100 KiB per second. `markAndWait()` settles with the write containing that change. `stop()` stops scheduling, joins the current write and returns waiters for the caller's final commit.

`SqliteExecutor` exposes asynchronous `exec`, `run`, `get` and `all`. Use positional bindings. A database transaction owns an exclusive queue slot: use only its temporary executor inside the callback. Database operations, another transaction and `close()` wait behind it and would deadlock if awaited from inside it. The temporary executor expires when the callback settles. Callback failure rolls back before rejection; rollback failure is reported separately.

The Node adapter shares prepared statements across transactions and defaults to WAL mode, normal synchronous mode, a 1,000-page checkpoint threshold and a 5,000 ms busy timeout. The Durable Object adapter shares a queue for each storage object and leaves storage ownership with the object. It rejects `bigint` bindings outside the safe integer range and converts returned blobs to `Uint8Array`.

`applySqliteMigrations()` validates the metadata table name and contiguous versions starting at 1, then applies pending statements and updates the tracked version in one transaction. A database newer than the supplied migrations is refused.

## Operational limits

Facets are trusted code in the host process. The Node loader imports a new module generation for each reload; old generations stay cached and plugins are not isolated. The process-wide synchronous publication queue means a slow observer delays other observers in the same process.

Cluster commit decisions and child module lists are not persisted. A coordinator failure can leave children on an older version until reconciliation. Only direct child hosts participate in a coordinated reload. Links do not resume provider-side holds after disconnect. The host manager does not automatically restart a failed child; the application chooses its policy.

On platforms that use filesystem socket locks, competing stale-lock probes can race. Bound remote cleanup calls so a disconnected dependency cannot prevent shutdown indefinitely. These runtime helpers do not provide durable application recovery by themselves.
