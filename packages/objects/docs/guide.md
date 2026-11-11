# Objects guide

## Contracts and references

Use `local(name, { version, params, members })` for a host-local contract. Use `remote()` with named `variants` and `hostAddress` for an object that can cross a link. `hostKind()` constructs addresses. It does not create hosts.

Schema helpers describe parameters, state and method inputs and results. `obj()` refuses extra fields. Contract declarations snapshot their schemas and calculate fingerprints. A fingerprint identifies shape, not application meaning or authorization.

Use `defineFacet()` to group declarations. The facet's `host.serve()` registers factories and registry providers. Call `host.load()` once with named facets before acquiring references. An invalid plugin name rejects the load. A failed plugin setup appears in the report and does not prevent independent plugins from loading.

`host.get(type, params, context)` waits for a live reference. `host.hold()` returns a reference while it loads. References expose `state`, `retry()` and `release()`. State is `loading`, `live`, `failed` or `ended`. A failed reference carries its cause and optional retry time.

Use `self.get()` inside a factory to declare an object-owned dependency. Use `ctx.get()` inside a call for a reference released when that call settles. Release references acquired directly from the host yourself. `host.root()` supplies the same call ownership to application code.

## Factory declarations

Factories run synchronously. A factory declares handles before it reads their values or calls dependencies. Activation loads documents, binds dependencies and opens native resources before admitting calls.

| Declaration | Purpose |
| --- | --- |
| `self.state(definition)` | Object-owned document |
| `self.get(type, params)` | Object-owned reference |
| `self.registry(registry)` | Composed plugin contributions |
| `self.writable(initial)` | In-process mutable value |
| `self.derive(sources, compute)` | Derived JSON value |
| `self.events<T>()` | Transient event source owned by the current attempt |
| `self.open(open, close, options)` | Native resource with bounded cleanup |
| `self.follow(attach)` | Source attached during activation |
| `self.on(source, handler)` | Serialized source-triggered routine |
| `self.onLive(handler)` | Routine started once the attempt is live |
| `self.job(definition, implementation)` | Job with run and finish phases |
| `self.retryOn(...sources)` | Additional retry triggers |
| `self.tx(callback, context)` | Atomic document and table transaction |

An empty-parameter local factory receives `StoreSelf`. With a Store, it can also declare tables, persisted documents, persisted jobs and contributions. `self.query(table, query, limit)` exposes bounded live rows. A commit refreshes affected queries before publishing its document changes. Failed query refreshes retain the last result and report the failure.

## Transient events

Declare a local member with `event(schema)`, or put its schema in a remote variant's `events` map. Return a source created by `self.events<T>()` from the factory. Call `source.emit(value)` to queue a value with its emission time. An event is independent of document transactions, so a rollback does not retract it. Events have no persisted history and do not replay after a restart.

Subscribe with `await reference.member.on(listener, context)`. Keep the returned subscription and call `stop()` when it is no longer needed. Cancelling the context or releasing the reference also ends the subscription. A reference subscription follows a replacement during reload, while a source retained from the old attempt refuses further emissions. A throwing listener ends only its own subscription.

An older contract needs an explicit mapping when an event schema is edited. References sharing that older version share its mapped values. A mapping failure drops the event only for that version and reports once until a later value maps successfully. A refused member prevents that older reference from binding; current-version readers keep working. See the [event contract](spec.md#events) for delivery order and link windows.

## Documents, tables and jobs

`defineState()` specifies a document's name, schema, version and initial value. A keyed definition addresses documents with `handle.at(key)`. Change documents with `handle.change()` or draft several handles in `self.tx()`. A failed transaction publishes nothing.

Use `keyed: true` for string keys. Use `keyed: Kind`, with a declared `hostKind`, for host addresses. Pass `Kind(params)` to the handle or transaction. Expose that handle through a local contract with `keyed(schema, Kind)`. The implementation and contract must use the same key kind.

A persisted definition also supplies `checkpointWhen`. Schema migrations run through its `migrate` callback. State survives a reload. Persistence also retains it across host restarts when the application reopens the same Store.

`defineTable()` specifies columns, a primary key, indexes and a version. `evolveTable()` records later schema changes and row transformations. `query()` builds conditions and ordering. Use table paging for bounded reads and `self.query()` for a watched result.

`defineJob()` specifies arguments, results, optional state, concurrency and persistence. Its `run` executes outside a transaction. Its `finish` callback and record cleanup execute together in a transaction. Failed finishes retry and block after five failures. Persisted runs reserve their record before executing. Recovery resumes eligible work from committed state. External effects still need application idempotency.

Deferred job-state writes become visible immediately and persist by their deadline or an earlier immediate write. A crash can lose uncommitted deferred state. The outcome and close paths flush deferred state.

## Reload

Pass the complete desired facet set to `host.reload()`. Reusing the same facet object keeps it unchanged. Omitted facets are removed. Reloads are serialized.

Staging records setup and factory declarations without opening natives or publishing state. A failed plugin keeps its prior implementation. A changed consumer also stays on prior code when it requires an incompatible provider whose update failed.

Every affected live object restarts. Its outgoing attempt serves calls already running and calls they cause while new calls wait for the replacement. Documents stay. Readiness checks the replacement's dependencies before closing the outgoing attempt. Parked or failed objects retry. References retain their last visible values until the replacement binds.

Set `reloadDrainTimeout` in host options, or `timeouts.reloadDrainTimeout` in the app host, to bound outgoing work. It defaults to five seconds and cannot exceed `closeTimeout`. Work still running at that deadline is cut off. Use persisted jobs for work that must recover after reload. In-memory jobs receive an aborted reload outcome.

A reload report describes plugin changes and each affected object's result. Cancellation before publication changes nothing. Cancellation after publication can reject the wait while retaining the committed update.

For terminal clients, `TuiScope.optimistic(read, reduce?)` returns a reader, `add(action, call)` and a `pending()` reader. The reducer applies pending actions in order over the current server value. Without a reducer, the latest action is the displayed value. Once all calls settle, the reader returns the server value. Callers handle rejected calls.

## Principals, links and routes

The host or accepting link supplies the principal. `principalKey` controls identity. A local object uses the host principal. Remote objects separate identities by principal. Named variants restrict available members. Plugin methods still enforce their application rules.

`memoryLinkPair()` connects hosts in one process. `ipcLink()` and `webSocketLink()` adapt transports. `accept()` admits a downstream principal. `connect()` supplies a parent link. Only a parent can stamp a forwarded caller's principal and incarnation.

Register routes before loading. `host.route(kind, { authorize, resolve }, context)` authorizes each hold and resolves a link for its address. Resolution runs at most once per address at a time. `retry(address)` retries held work. `suspend(address)` prevents new resolution until retry or release. There is no timer retry loop.

A lost link fails in-flight calls. Their remote effect may already have happened. Reconnecting rebinds held references and retains their last snapshots while loading. Calls are not replayed automatically.

## Store and SQLite

Open a database through `@axi/objects/sqlite/node` or `@axi/objects/sqlite/cloudflare`. Pass `sqliteBackend(database)` to `openStore()`, then pass the Store to `createHost()`. Close the host before closing the Store. The Store owns its database after opening.

Group data by host with `keyed: Kind` document definitions and `host(Kind)` table columns. Call `host.exportHostData(address, context)` to inspect or save that address's archive. Call `host.importHostData(parts, context)` to restore it, or pass `{ address: otherAddress }` to copy it. Existing data is refused unless you pass `existing: "replace"`. `host.deleteHostData(address, context)` removes only its owned records and rows. These operations update live documents and queries together. Plain string-keyed documents remain separate, even when their keys resemble host addresses.

Store commits apply document and table writes atomically. Adoption follows the database commit. An uncertain commit outcome stops the Store. An optional outbox retains applied writes for ordered replay.

`store.export(context)` holds the commit queue while yielding an archive. `encodeJsonl()` and `decodeJsonl()` encode archive records as UTF-8 lines. `importStore()` validates an archive and imports it atomically into an empty database. Export records are separate from Durable's JSONL session backend.

The experimental `@axi/objects/sync` helpers replicate a Store through its outbox. The application controls upload, pull and scheduling. A remote stores compressed batches and snapshots. See [Store sync](sync.md) for progress recovery, divergence and filesystem limits.

The SQLite executor's transaction callback owns an exclusive queue slot. Use its temporary executor inside that callback. Awaiting the outer database there would deadlock. The temporary executor expires afterward. Failed callbacks roll back before rejecting.

## Observers and tracing

A JSON watch delivers the newest value, delta operations, a retirement flag and a commit context. A native watch delivers in-process values without delta operations. Callbacks run in order. Backlogged JSON changes fold together. Stop or cancellation detaches the watch and releases queued state.

Pass an explicit `Context` through calls. `withCancel()` and `withAbortSignal()` derive cancellation scopes. `withContextValue()` carries typed values. `withTelemetry()` attaches a callback span without changing the parent context.

A host telemetry adapter records methods, holds, calls, activation, cleanup, jobs, routines, HTTP, routes and reloads. Remote carriers preserve supported parent context. Cancellation records an aborted outcome without a failure status. `ctx.trace()` adds an application span while preserving principal, incarnation and acquired-reference ownership.

The SQLite telemetry recorder queues finished spans and ten-second metric aggregates. `flush()` writes them. `close()` flushes partial intervals and leaves its database open. Page ingestion checks sender identity, field bounds and per-minute span limits. Worker ingestion stamps its authenticated host. Senders keep unsent batches while disconnected and discard failed sends as best effort.
